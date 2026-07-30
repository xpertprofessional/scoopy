// NativePluginHost.mm — JUCE-backed implementation of NativePluginHost.hpp.
//
// Vendored from scoopyloops (P6-1). There, this TU was compiled only into the
// Xcode app target behind a prefix header that hand-assembled the JUCE module
// flags; here JUCE is a CMake citizen, so the WizardMerged target supplies the
// module settings (JUCE_PLUGINHOST_AU/VST3) and include paths itself and the
// prefix header is gone. The SCOOPY_PLUGIN_HOST=0 branch at the bottom is
// JUCE-free plain C++ and doubles as the link stub for the headless gate tools
// (built by vendor/scoopy/engine's scoopy_plugin_host_stub target).

#include "NativePluginHost.hpp"

#if SCOOPY_PLUGIN_HOST

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <iostream>
#include <mutex>
#include <thread>

namespace scoopyloops {

namespace {

juce::File deadMansPedalLocation()
{
    auto dir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                   .getChildFile("ScoopyLoops");
    dir.createDirectory();
    return dir.getChildFile("PluginScanDeadMansPedal.txt");
}

juce::File pluginCacheLocation()
{
    auto dir = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                   .getChildFile("ScoopyLoops");
    dir.createDirectory();
    return dir.getChildFile("PluginScanCache.xml");
}

ScannedPluginInfo toInfo(const juce::PluginDescription& d)
{
    ScannedPluginInfo info;
    info.identifier   = d.createIdentifierString().toStdString();
    info.name         = d.name.toStdString();
    info.manufacturer = d.manufacturerName.toStdString();
    info.format       = d.pluginFormatName.toStdString();
    info.version      = d.version.toStdString();
    info.isInstrument = d.isInstrument;
    return info;
}

// CustomScanner that performs each plugin scan OUT OF PROCESS by re-launching the
// app binary with "--scan-plugin <format> <id>". A plugin that crashes on
// instantiation only kills the throwaway child; the parent records an empty
// result and moves on, so the app never goes down during scanning.
class HelperProcessScanner : public juce::KnownPluginList::CustomScanner {
public:
    bool findPluginTypesFor(juce::AudioPluginFormat& format,
                            juce::OwnedArray<juce::PluginDescription>& result,
                            const juce::String& fileOrIdentifier) override
    {
        // Re-launch THIS binary as the throwaway worker (WizardMerged's main
        // intercepts --scan-plugin before any application object exists). The
        // shipping app spawns a bundled ScoopyPluginScanner helper instead —
        // a sandbox-era artifact kept there for crash isolation; the merged
        // host is unsandboxed and gets the same isolation from its own child.
        const juce::File exe = juce::File::getSpecialLocation(juce::File::currentExecutableFile);

        juce::StringArray args;
        args.add(exe.getFullPathName());
        args.add("--scan-plugin");
        args.add(format.getName());
        args.add(fileOrIdentifier);

        juce::ChildProcess proc;
        if (! proc.start(args, juce::ChildProcess::wantStdOut))
            return true; // couldn't launch -> treat as scanned with no results

        // Watchdog: kill a hung helper after a timeout so one misbehaving plugin
        // can't stall the whole scan. readAllProcessOutput() blocks until the child
        // closes stdout (exits or is killed). This runs on the scan background
        // thread, never the UI thread.
        std::atomic<bool> finished { false };
        std::thread watchdog([&proc, &finished]() {
            const std::uint32_t deadline = juce::Time::getMillisecondCounter() + 30000u;
            while (! finished.load(std::memory_order_acquire)) {
                if (juce::Time::getMillisecondCounter() > deadline) { proc.kill(); return; }
                juce::Thread::sleep(50);
            }
        });

        const juce::String output = proc.readAllProcessOutput();
        finished.store(true, std::memory_order_release);
        watchdog.join();

        if (auto xml = juce::parseXML(output))
            for (auto* child : xml->getChildIterator())
            {
                auto desc = std::make_unique<juce::PluginDescription>();
                if (desc->loadFromXml(*child))
                    result.add(desc.release());
            }

        return true; // handled out-of-process (empty result if the child crashed)
    }

    void scanFinished() override {}
};

} // namespace

int runPluginScanWorker(const std::string& formatName, const std::string& fileOrIdentifier)
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    juce::AudioPluginFormatManager fm;
    juce::addDefaultFormatsToManager(fm);

    juce::AudioPluginFormat* format = nullptr;
    for (int i = 0; i < fm.getNumFormats(); ++i)
        if (fm.getFormat(i)->getName() == juce::String(formatName)) { format = fm.getFormat(i); break; }

    if (format == nullptr)
        return 2;

    juce::OwnedArray<juce::PluginDescription> found;
    format->findAllTypesForFile(found, juce::String(fileOrIdentifier));

    juce::XmlElement root("PLUGINS");
    for (auto* d : found)
        if (auto xml = d->createXml())
            root.addChildElement(xml.release());

    std::cout << root.toString() << std::flush;
    return 0;
}

class NativePluginScanner::Impl {
public:
    Impl() : deadMansPedalFile(deadMansPedalLocation()), cacheFile(pluginCacheLocation())
    {
        // JUCE 8 replaced AudioPluginFormatManager::addDefaultFormats() with this
        // free function (which only pulls in the formats the build enables — here
        // AU + VST3 via JUCE_PLUGINHOST_AU / JUCE_PLUGINHOST_VST3).
        juce::addDefaultFormatsToManager(formatManager);
        // Restore the persisted scan results so already-known plugins (and, via the
        // dead-man's-pedal, crash-prone ones) are skipped on the next scan — the
        // first scan is slow (one child process per plugin) but later ones are fast.
        if (auto xml = juce::parseXML(cacheFile))
            knownPluginList.recreateFromXml(*xml);
        // Scan each plugin out of process so a buggy plugin can't crash the app.
        knownPluginList.setCustomScanner(std::make_unique<HelperProcessScanner>());
        refreshResultsCache();
    }

    void saveCache()
    {
        if (auto xml = knownPluginList.createXml())
            xml->writeTo(cacheFile);
    }

    ~Impl()
    {
        abortScan.store(true, std::memory_order_relaxed);
        if (scanThread.joinable())
            scanThread.join();
    }

    void beginScan(std::function<void(float)> progress, std::function<void()> completion)
    {
        bool expected = false;
        if (! scanning.compare_exchange_strong(expected, true))
            return;

        progressCallback   = std::move(progress);
        completionCallback = std::move(completion);

        if (scanThread.joinable())
            scanThread.join();

        // Scan on a BACKGROUND thread: each plugin is scanned out-of-process via the
        // helper, and reading the child's output blocks. Doing that on the JUCE
        // message thread (the main/UI thread) froze the app — so run the whole
        // PluginDirectoryScanner loop here and marshal progress/completion to main.
        scanThread = std::thread([this]() { runScan(); });
    }

    void runScan()
    {
        std::vector<juce::AudioPluginFormat*> formats;
        for (int i = 0; i < formatManager.getNumFormats(); ++i)
        {
            auto* format = formatManager.getFormat(i);
            if (format != nullptr && format->canScanForPlugins())
                formats.push_back(format);
        }

        for (std::size_t fi = 0; fi < formats.size(); ++fi)
        {
            auto* format = formats[fi];
            juce::PluginDirectoryScanner scanner(knownPluginList, *format,
                format->getDefaultLocationsToSearch(), /*recursive*/ true,
                deadMansPedalFile, /*allowAsync*/ false);

            for (;;)
            {
                // Bail promptly if the scanner is being torn down (e.g. app quit mid-scan).
                if (abortScan.load(std::memory_order_relaxed)) { saveCache(); return; }
                juce::String nameBeingScanned;
                const bool more = scanner.scanNextFile(true, nameBeingScanned);

                refreshResultsCache();

                // Persist incrementally (throttled) so a mid-scan quit keeps progress
                // and crash-prone plugins stay recorded/skipped next time.
                const std::uint32_t now = juce::Time::getMillisecondCounter();
                if (now - lastSaveMs > 3000u) { saveCache(); lastSaveMs = now; }

                const float perFormat = static_cast<float>(scanner.getProgress());
                const float overall = (static_cast<float>(fi) + perFormat)
                    / static_cast<float>(juce::jmax<std::size_t>(1, formats.size()));
                postProgress(juce::jlimit(0.0f, 1.0f, overall));

                if (! more) break;
            }
        }

        saveCache();
        postProgress(1.0f);

        auto done = completionCallback;
        juce::MessageManager::callAsync([this, done]() {
            progressCallback = nullptr;
            completionCallback = nullptr;
            scanning.store(false, std::memory_order_release);
            if (done) done();
        });
    }

    void refreshResultsCache()
    {
        const auto types = knownPluginList.getTypes();
        std::vector<ScannedPluginInfo> cache;
        cache.reserve(static_cast<std::size_t>(types.size()));
        for (const auto& d : types)
            cache.push_back(toInfo(d));
        std::lock_guard<std::mutex> lock(resultsMutex);
        resultsCache = std::move(cache);
    }

    void postProgress(float p)
    {
        if (! progressCallback) return;
        auto cb = progressCallback;
        juce::MessageManager::callAsync([cb, p]() { cb(p); });
    }

    std::vector<ScannedPluginInfo> results() const
    {
        std::lock_guard<std::mutex> lock(resultsMutex);
        return resultsCache;
    }

    std::string knownPluginListXml() const
    {
        if (auto xml = knownPluginList.createXml())
            return xml->toString().toStdString();
        return {};
    }

    void restoreFromXml(const std::string& xml)
    {
        if (xml.empty()) return;
        if (auto parsed = juce::parseXML(juce::String(xml)))
            knownPluginList.recreateFromXml(*parsed);
    }

    juce::AudioPluginFormatManager formatManager;
    juce::KnownPluginList          knownPluginList;
    juce::File                     deadMansPedalFile;
    juce::File                     cacheFile;
    std::uint32_t                  lastSaveMs = 0;

    std::atomic<bool> scanning { false };
    // Set true by ~Impl before joining so a scan in progress at app quit bails after the
    // current out-of-process plugin scan rather than blocking teardown on the full sweep.
    std::atomic<bool> abortScan { false };

    std::thread                     scanThread;
    std::function<void(float)>      progressCallback;
    std::function<void()>           completionCallback;
    mutable std::mutex              resultsMutex;
    std::vector<ScannedPluginInfo>  resultsCache;
};

NativePluginScanner::NativePluginScanner() : impl_(std::make_unique<Impl>()) {}
NativePluginScanner::~NativePluginScanner() = default;

void NativePluginScanner::beginScan(std::function<void(float)> progress,
                                    std::function<void()> completion)
{
    impl_->beginScan(std::move(progress), std::move(completion));
}

bool NativePluginScanner::isScanning() const noexcept
{
    return impl_->scanning.load(std::memory_order_acquire);
}

std::vector<ScannedPluginInfo> NativePluginScanner::results() const
{
    return impl_->results();
}

std::string NativePluginScanner::knownPluginListXml() const
{
    return impl_->knownPluginListXml();
}

void NativePluginScanner::restoreFromXml(const std::string& xml)
{
    impl_->restoreFromXml(xml);
}

// ============================================================================
// NativePluginSlot
// ============================================================================

// Supplies host tempo + transport to the hosted plugin so tempo-syncable plugins
// (synced delays, LFOs, arps) lock to the project BPM. Updated once per block on
// the audio thread (update()); the plugin reads it via getPosition() inside its
// processBlock on the same thread, so no locking is needed.
class HostPlayHead : public juce::AudioPlayHead {
public:
    void update(double bpm, bool isPlaying, double sampleRate, int numFrames) noexcept
    {
        if (isPlaying && ! wasPlaying_) samplePos_ = 0.0; // restart the beat clock on play
        bpm_        = bpm > 0.0 ? bpm : 120.0;
        playing_    = isPlaying;
        sampleRate_ = sampleRate > 0.0 ? sampleRate : 44100.0;
        currentSamples_ = samplePos_;
        if (isPlaying) samplePos_ += static_cast<double>(numFrames);
        wasPlaying_ = isPlaying;
    }

    juce::Optional<juce::AudioPlayHead::PositionInfo> getPosition() const override
    {
        juce::AudioPlayHead::PositionInfo info;
        info.setBpm(bpm_);
        info.setIsPlaying(playing_);
        juce::AudioPlayHead::TimeSignature ts; ts.numerator = 4; ts.denominator = 4;
        info.setTimeSignature(ts);
        const double seconds = currentSamples_ / sampleRate_;
        info.setTimeInSamples(static_cast<juce::int64>(currentSamples_));
        info.setTimeInSeconds(seconds);
        info.setPpqPosition(seconds * (bpm_ / 60.0));
        return info;
    }

private:
    double bpm_ = 120.0, sampleRate_ = 44100.0, samplePos_ = 0.0, currentSamples_ = 0.0;
    bool playing_ = false, wasPlaying_ = false;
};

// Standalone window that hosts a plugin's own editor. Using a JUCE DocumentWindow
// (which owns its NSWindow) avoids embedding the plugin NSView into the SwiftUI
// app's view hierarchy. Lives entirely on the JUCE message (main) thread.
class PluginEditorWindow : public juce::DocumentWindow {
public:
    PluginEditorWindow(juce::AudioProcessorEditor* editor,
                       const juce::String& title,
                       std::function<void()> onClose)
        : juce::DocumentWindow(title, juce::Colours::darkgrey,
                               juce::DocumentWindow::closeButton),
          onClose_(std::move(onClose))
    {
        setUsingNativeTitleBar(true);
        setContentOwned(editor, true); // takes ownership + sizes to the editor
        setResizable(editor->isResizable(), false);
        centreWithSize(getWidth(), getHeight());
        // Float above the app so the user can tweak send params while watching the
        // plugin UI and make realtime adjustments.
        setAlwaysOnTop(true);
        setVisible(true);
        toFront(true);
    }

    void closeButtonPressed() override { if (onClose_) onClose_(); }

private:
    std::function<void()> onClose_;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginEditorWindow)
};

// Shared plugin-instance host: everything common to an FX-return insert (NativePluginSlot) and a
// per-track instrument (NativeInstrumentSlot) — the load/unload/prepare/editor/state lifecycle plus
// the audio-thread try-lock swap discipline. The two derived Impls add only their distinct render
// entry point (process() for the insert, renderInstrument() for the instrument). All the delicate
// message-thread / lock ordering lives here once.
class PluginHostCommon {
public:
    virtual ~PluginHostCommon() { closeEditorInternal(); }

    void openEditor() { setEditorVisible(true); }

    // Show/hide the editor window WITHOUT destroying it (or the plugin instance), so a
    // hidden editor can be re-shown instantly with its state intact. Creates the window
    // lazily on first show. Runs on the message thread.
    void setEditorVisible(bool visible)
    {
        juce::MessageManager::callAsync([this, visible]() {
            // load/unload also run on the message thread, so `instance` is stable here.
            if (visible) {
                if (instance == nullptr || ! instance->hasEditor()) return;
                if (editorWindow == nullptr) {
                    if (auto* editor = instance->createEditorIfNeeded())
                        editorWindow = std::make_unique<PluginEditorWindow>(
                            editor, instance->getName(), [this]() { closeEditorInternal(); });
                }
                if (editorWindow != nullptr) { editorWindow->setVisible(true); editorWindow->toFront(true); }
            } else if (editorWindow != nullptr) {
                editorWindow->setVisible(false);
            }
            // Publish what ACTUALLY happened, from inside the marshalled work
            // (P6-4). A request is not a state: `visible = true` on a plugin with
            // no editor changes nothing, and a UI that echoed its own request
            // would light an EDIT lamp over a window that never opened — the same
            // display-what-is-TRUE rule the monitor switch exists for.
            editorShown.store(editorWindow != nullptr && editorWindow->isVisible(),
                              std::memory_order_release);
        });
    }

    void closeEditor()
    {
        juce::MessageManager::callAsync([this]() { closeEditorInternal(); });
    }

    void closeEditorInternal()
    {
        editorWindow.reset();
        // The window's own close box lands here too (PluginEditorWindow's
        // callback), which is exactly why the lamp reads this mirror rather than
        // the last request: closing the editor by hand must un-light EDIT.
        editorShown.store(false, std::memory_order_release);
    }

    /** Does the LOADED plugin have an editor at all? Lock-free mirror, published
        with `loaded` and by the same discipline — a UI needs this to disable EDIT
        with a reason ("this plugin has no editor") instead of offering a button
        that is a documented no-op. */
    bool editorAvailableLockFree() const noexcept
    {
        return editorAvail.load(std::memory_order_acquire);
    }

    /** Is an editor window on screen right now? Lock-free, and it follows the
        window rather than the request (see setEditorVisible / closeEditorInternal). */
    bool editorVisibleLockFree() const noexcept
    {
        return editorShown.load(std::memory_order_acquire);
    }

    void prepare(double sr, int maxBlock)
    {
        // Called from the engine's configure() on the audio-control queue. Plugin
        // lifecycle calls (releaseResources / prepareToPlay) are NOT safe to call
        // off the JUCE message thread — a VST3 crashes deactivating its event buses.
        // So update the basics here and re-prepare the loaded instance (if any) on
        // the message thread. Audio isn't running during configure(), so the brief
        // async gap is fine.
        bool hasInstance = false;
        {
            std::lock_guard<std::mutex> lock(mutex);
            sampleRate   = sr > 0 ? sr : sampleRate;
            maxBlockSize = juce::jmax(1, maxBlock);
            hasInstance = (instance != nullptr);
            if (! hasInstance)
                scratch.setSize(2, maxBlockSize, false, false, true);
        }

        if (! hasInstance) return; // no plugin -> nothing to re-prepare (and avoid touching the MM)

        juce::MessageManager::callAsync([this]() {
            // Move the instance OUT under a brief lock so process() sees null and
            // passes through. Then do the slow plugin calls (releaseResources /
            // prepareToPlay) WITHOUT holding the lock — some plugins pump the message
            // loop there, and holding our non-recursive mutex across that can
            // self-deadlock with another queued callAsync (load/unload) that also
            // takes it. Swap the re-prepared instance back under a brief lock.
            std::unique_ptr<juce::AudioPluginInstance> inst;
            double sr; int mb;
            {
                std::lock_guard<std::mutex> lock(mutex);
                inst = std::move(instance);
                sr = sampleRate; mb = maxBlockSize;
            }
            if (inst == nullptr) return;

            inst->releaseResources();
            const int chans = configureAndPrepare(*inst, sr, mb);
            const int lat = inst->getLatencySamples();

            {
                std::lock_guard<std::mutex> lock(mutex);
                scratch.setSize(chans, mb, false, false, true);
                instance = std::move(inst);
            }
            latency.store(lat, std::memory_order_release);
        });
    }

    // Best-effort: prefer a stereo main bus but NEVER force an exact layout —
    // setPlayConfigDetails(2,2,..) jasserts/crashes on plugins that can't be
    // configured to exactly 2-in/2-out. Returns the channel count to allocate for
    // the process buffer (>= 2, large enough for the plugin's in & out buses).
    static int configureAndPrepare(juce::AudioPluginInstance& inst, double sr, int mb)
    {
        auto stereo = juce::AudioChannelSet::stereo();
        auto layout = inst.getBusesLayout();
        bool changed = false;
        if (layout.inputBuses.size() > 0 && layout.getMainInputChannelSet() != stereo)
        { layout.inputBuses.getReference(0) = stereo; changed = true; }
        if (layout.outputBuses.size() > 0 && layout.getMainOutputChannelSet() != stereo)
        { layout.outputBuses.getReference(0) = stereo; changed = true; }
        if (changed && inst.checkBusesLayoutSupported(layout))
            inst.setBusesLayout(layout);

        inst.setRateAndBufferSizeDetails(sr, mb);
        inst.setNonRealtime(false);
        inst.prepareToPlay(sr, mb);

        return juce::jmax(2, inst.getTotalNumInputChannels(), inst.getTotalNumOutputChannels());
    }

    void loadAsync(NativePluginScanner& scanner, std::string identifier,
                   std::string stateB64,
                   std::function<void(bool, std::string)> completion)
    {
        juce::MessageManager::callAsync([this, &scanner, identifier, stateB64,
                                         completion = std::move(completion)]() mutable
        {
            // Idempotent: if the requested plugin is already loaded, do nothing.
            // Lets the launch-restore path re-apply modes without reloading.
            {
                std::lock_guard<std::mutex> lock(mutex);
                if (instance != nullptr && loadedIdentifier == identifier)
                {
                    const std::string nm = instance->getName().toStdString();
                    if (completion) completion(true, nm);
                    return;
                }
            }

            auto* sImpl = scanner.impl();
            juce::PluginDescription desc;
            bool found = false;
            if (sImpl != nullptr)
            {
                const juce::String wanted(identifier);
                for (const auto& d : sImpl->knownPluginList.getTypes())
                    if (d.createIdentifierString() == wanted) { desc = d; found = true; break; }
            }
            if (! found) { if (completion) completion(false, {}); return; }

            double sr; int mb;
            { std::lock_guard<std::mutex> lock(mutex); sr = sampleRate; mb = maxBlockSize; }

            juce::String err;
            std::unique_ptr<juce::AudioPluginInstance> inst =
                sImpl->formatManager.createPluginInstance(desc, sr, mb, err);
            if (inst == nullptr) { if (completion) completion(false, {}); return; }

            const int chans = configureAndPrepare(*inst, sr, mb);
            inst->setPlayHead(&playHead); // feed host tempo/transport for synced plugins

            if (! stateB64.empty())
            {
                juce::MemoryBlock blk;
                if (blk.fromBase64Encoding(juce::String(stateB64)))
                    inst->setStateInformation(blk.getData(), static_cast<int>(blk.getSize()));
            }

            const int lat = inst->getLatencySamples();
            const std::string nm = inst->getName().toStdString();
            // Phase 5 audit: report plugin-reported latency (uncompensated — it adds directly to
            // first-tone delay). Lookahead limiters / linear-phase EQ show up here as large values.
            std::cout << "[NativePluginHost] loaded '" << nm << "' latency=" << lat
                      << " samples (" << (sr > 0.0 ? (1000.0 * lat / sr) : 0.0) << " ms @ "
                      << sr << "Hz)" << std::endl;
            closeEditorInternal(); // close any editor for the instance we're replacing
            std::unique_ptr<juce::AudioPluginInstance> old;
            {
                std::lock_guard<std::mutex> lock(mutex);
                scratch.setSize(chans, maxBlockSize, false, false, true);
                old = std::move(instance);   // keep old to destroy OUTSIDE the lock
                instance = std::move(inst);
                loadedIdentifier = identifier;
            }
            old.reset(); // old plugin's destructor (releaseResources/deactivate) may pump
                         // the message loop — must run without the slot mutex held.
            latency.store(lat, std::memory_order_release);
            // Asked ON the message thread, where `instance` is stable, and cached
            // for lock-free readers (P6-4). Publishing it beside `loaded` is what
            // makes "loaded but no editor" a state the UI can state honestly.
            editorAvail.store(instance != nullptr && instance->hasEditor(),
                              std::memory_order_release);
            loaded.store(true, std::memory_order_release);
            if (completion) completion(true, nm);
        });
    }

    void unload()
    {
        juce::MessageManager::callAsync([this]()
        {
            closeEditorInternal(); // the editor references the instance we're dropping
            std::unique_ptr<juce::AudioPluginInstance> old;
            { std::lock_guard<std::mutex> lock(mutex); old = std::move(instance); loadedIdentifier.clear(); }
            editorAvail.store(false, std::memory_order_release);
            loaded.store(false, std::memory_order_release);
            if (old != nullptr) old->releaseResources();
            latency.store(0, std::memory_order_release);
        });
    }

    // Synchronous teardown for app quit. MUST be called on the message thread (the
    // caller guarantees this). Mirrors unload()'s lock discipline but runs inline:
    // move the editor + instance out under a brief lock, then destroy them WITHOUT
    // the lock held (a plugin ~dtor / releaseResources can pump the message loop,
    // and editor destruction touches the message thread — holding our non-recursive
    // mutex across either can self-deadlock).
    void destroyNow()
    {
        std::unique_ptr<PluginEditorWindow> oldEditor;
        std::unique_ptr<juce::AudioPluginInstance> old;
        {
            std::lock_guard<std::mutex> lock(mutex);
            oldEditor = std::move(editorWindow);
            old = std::move(instance);
            loadedIdentifier.clear();
        }
        oldEditor.reset();              // destroy the editor window first (it references the instance)
        editorShown.store(false, std::memory_order_release);
        editorAvail.store(false, std::memory_order_release);
        loaded.store(false, std::memory_order_release);
        if (old != nullptr) old->releaseResources();
        old.reset();                    // run the plugin ~dtor outside the lock
        latency.store(0, std::memory_order_release);
    }

    bool has() const { std::lock_guard<std::mutex> lock(mutex); return instance != nullptr; }

    std::string stateB64() const
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (instance == nullptr) return {};
        juce::MemoryBlock blk;
        instance->getStateInformation(blk);
        return blk.toBase64Encoding().toStdString();
    }

    std::string name() const
    {
        std::lock_guard<std::mutex> lock(mutex);
        return instance != nullptr ? instance->getName().toStdString() : std::string();
    }

    /** The identifier this slot was LOADED FROM — what a document must store to
        find the same plugin again (P6-5). Deliberately not the display name: a
        name is for people and collides between formats/vendors, while
        `createIdentifierString()` is JUCE's own persistence key. Empty when
        nothing is loaded, and cleared by unload/destroy alongside the instance. */
    std::string identifier() const
    {
        std::lock_guard<std::mutex> lock(mutex);
        return instance != nullptr ? loadedIdentifier : std::string();
    }

    // --- JUCE program (preset) list — v81 preset stepping. Main/message-thread callers only
    // (same as stateB64/name). The lock excludes the audio thread's try-lock render for the
    // duration of a program switch — that block renders silence, same policy as a load swap.
    int programCount() const
    {
        std::lock_guard<std::mutex> lock(mutex);
        return instance != nullptr ? instance->getNumPrograms() : 0;
    }

    int currentProgram() const
    {
        std::lock_guard<std::mutex> lock(mutex);
        return instance != nullptr ? instance->getCurrentProgram() : -1;
    }

    std::string currentProgramName() const
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (instance == nullptr) return {};
        const int idx = instance->getCurrentProgram();
        return idx >= 0 ? instance->getProgramName(idx).toStdString() : std::string();
    }

    void setProgram(int index)
    {
        std::lock_guard<std::mutex> lock(mutex);
        if (instance == nullptr) return;
        const int n = instance->getNumPrograms();
        if (n <= 0) return;
        instance->setCurrentProgram(juce::jlimit(0, n - 1, index));
    }

    mutable std::mutex mutex;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    std::unique_ptr<PluginEditorWindow> editorWindow; // message-thread only
    /** Lock-free mirrors OF the message-thread editor state (P6-4), so a control
        thread can read it without touching `editorWindow` — which is
        message-thread-only, and a cross-thread peek at a unique_ptr is a data
        race however harmless it looks. Published exactly where `loaded` is. */
    std::atomic<bool> editorAvail { false };
    std::atomic<bool> editorShown { false };
    HostPlayHead playHead;
    std::string loadedIdentifier;
    double sampleRate = 44100.0;
    int    maxBlockSize = 512;
    juce::AudioBuffer<float> scratch;
    juce::MidiBuffer midi;
    std::atomic<int> latency { 0 };
    // Lock-free mirror of `instance != nullptr` for audio-thread callers
    // (isLoadedLockFree): flipped true after a load swaps in, false on
    // unload/destroyNow — beside `latency`, which follows the same lifecycle.
    std::atomic<bool> loaded { false };
};

// FX-return insert: dual-mono audio in → wet audio out, with an always-empty MIDI buffer.
class NativePluginSlot::Impl : public PluginHostCommon {
public:
    bool process(float* left, float* right, int numFrames, double bpm, bool isPlaying) noexcept
    {
        std::unique_lock<std::mutex> lock(mutex, std::try_to_lock);
        if (! lock.owns_lock()) return false;            // swap in progress -> passthrough
        auto* inst = instance.get();
        const int nCh = scratch.getNumChannels();
        if (inst == nullptr || nCh < 1 || numFrames <= 0 || numFrames > maxBlockSize) return false;

        playHead.update(bpm, isPlaying, sampleRate, numFrames); // host tempo/transport for this block

        const auto bytes = sizeof(float) * static_cast<size_t>(numFrames);
        // Dual-mono in: ch0 = L, ch1 = R, any extra channels cleared.
        std::memcpy(scratch.getWritePointer(0), left, bytes);
        if (nCh > 1) std::memcpy(scratch.getWritePointer(1), right, bytes);
        for (int c = 2; c < nCh; ++c)
            juce::FloatVectorOperations::clear(scratch.getWritePointer(c), numFrames);

        juce::AudioBuffer<float> view(scratch.getArrayOfWritePointers(), nCh, numFrames);
        midi.clear();
        // Re-assert flush-to-zero around the plugin: some plugins reset the CPU's MXCSR flags
        // mid-block, so a callback-level guard alone can leave the plugin running denormals.
        // (Mirrors juce::AudioProcessorPlayer.)
        const juce::ScopedNoDenormals noDenormals;
        inst->processBlock(view, midi);

        std::memcpy(left,  scratch.getReadPointer(0), bytes);
        std::memcpy(right, scratch.getReadPointer(nCh > 1 ? 1 : 0), bytes);
        return true;
    }
};

NativePluginSlot::NativePluginSlot() : impl_(std::make_unique<Impl>()) {}
NativePluginSlot::~NativePluginSlot() = default;

void NativePluginSlot::prepare(double sampleRate, int maxBlockSize)
{
    impl_->prepare(sampleRate, maxBlockSize);
}

void NativePluginSlot::loadAsync(NativePluginScanner& scanner,
                                 const std::string& identifier,
                                 const std::string& stateBase64,
                                 std::function<void(bool, std::string)> completion)
{
    impl_->loadAsync(scanner, identifier, stateBase64, std::move(completion));
}

void NativePluginSlot::unload() { impl_->unload(); }
void NativePluginSlot::destroyNow() { impl_->destroyNow(); }
bool NativePluginSlot::hasPlugin() const noexcept { return impl_->has(); }
bool NativePluginSlot::isLoadedLockFree() const noexcept { return impl_->loaded.load(std::memory_order_acquire); }
int  NativePluginSlot::latencySamples() const noexcept { return impl_->latency.load(std::memory_order_acquire); }
bool NativePluginSlot::processStereoBlock(float* left, float* right, int numFrames,
                                          double bpm, bool isPlaying) noexcept
{
    return impl_->process(left, right, numFrames, bpm, isPlaying);
}
std::string NativePluginSlot::stateBase64() const { return impl_->stateB64(); }
std::string NativePluginSlot::loadedName() const { return impl_->name(); }
std::string NativePluginSlot::loadedIdentifier() const { return impl_->identifier(); }
void NativePluginSlot::openEditor() { impl_->openEditor(); }
void NativePluginSlot::closeEditor() { impl_->closeEditor(); }
void NativePluginSlot::setEditorVisible(bool visible) { impl_->setEditorVisible(visible); }
bool NativePluginSlot::editorAvailable() const noexcept { return impl_->editorAvailableLockFree(); }
bool NativePluginSlot::editorVisible() const noexcept { return impl_->editorVisibleLockFree(); }

// ============================================================================
// NativeInstrumentSlot
// ============================================================================

// Instrument host: MIDI in (drained from a producer ring + appended live on the audio thread) →
// instrument audio out. Shares the whole plugin lifecycle via PluginHostCommon; adds only the MIDI
// feed and the render entry point.
class NativeInstrumentSlot::Impl : public PluginHostCommon {
public:
    struct MidiEvent {
        std::uint8_t  status     = 0;
        std::uint8_t  data1      = 0;
        std::uint8_t  data2      = 0;
        std::uint32_t frameOffset = 0;
    };
    static constexpr std::size_t kMidiRingSize = 1024; // power of two

    // Off-audio-thread producers (live note-in via the bridge control queue, external MIDI-in via
    // the CoreMIDI input callback) are serialized by this mutex; the audio-thread consumer drains
    // lock-free in renderInstrument(). The audio thread NEVER takes this mutex.
    void enqueueMidi(std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                     std::uint32_t frameOffset) noexcept
    {
        std::lock_guard<std::mutex> lk(midiProducerMutex_);
        const auto head = midiHead_.load(std::memory_order_relaxed);
        const auto tail = midiTail_.load(std::memory_order_acquire);
        if (((head + 1) & (kMidiRingSize - 1)) == (tail & (kMidiRingSize - 1)))
            return; // ring full -> drop (never block the producer)
        midiRing_[head & (kMidiRingSize - 1)] = { status, data1, data2, frameOffset };
        midiHead_.store(head + 1, std::memory_order_release);
    }

    void allNotesOff() noexcept
    {
        // CC120 (all sound off) + CC123 (all notes off) on every channel.
        for (std::uint8_t ch = 0; ch < 16; ++ch) {
            enqueueMidi(static_cast<std::uint8_t>(0xB0 | ch), 120, 0, 0);
            enqueueMidi(static_cast<std::uint8_t>(0xB0 | ch), 123, 0, 0);
        }
    }

    // AUDIO THREAD ONLY. Stages an event for the upcoming renderInstrument(). Stores the RAW frame
    // offset (generation runs before renderInstrument knows the block size); the offset is clamped to
    // the actual block at drain time. pendingMidi_ is cleared after each renderInstrument().
    void addMidiNow(std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                    std::uint32_t frameOffset) noexcept
    {
        if (status < 0x80) return;
        const int n = ((status & 0xF0) == 0xC0 || (status & 0xF0) == 0xD0) ? 2 : 3;
        pendingMidi_.addEvent(n == 2 ? juce::MidiMessage(status, data1)
                                     : juce::MidiMessage(status, data1, data2),
                              static_cast<int>(frameOffset));
    }

    void sequencerNoteNow(std::uint8_t channel, int note, std::uint8_t velocity,
                          std::uint32_t frameOffset) noexcept
    {
        const std::uint8_t ch = channel & 0x0F;
        if (heldSeqNote_ >= 0) {
            addMidiNow(static_cast<std::uint8_t>(0x80 | heldSeqChannel_),
                       static_cast<std::uint8_t>(heldSeqNote_), 0, frameOffset);
            heldSeqNote_ = -1;
        }
        if (velocity > 0 && note >= 0 && note <= 127) {
            addMidiNow(static_cast<std::uint8_t>(0x90 | ch),
                       static_cast<std::uint8_t>(note), velocity, frameOffset);
            heldSeqNote_ = note;
            heldSeqChannel_ = ch;
        }
    }

    void releaseSequencerNoteNow(std::uint32_t frameOffset) noexcept
    {
        if (heldSeqNote_ >= 0) {
            addMidiNow(static_cast<std::uint8_t>(0x80 | heldSeqChannel_),
                       static_cast<std::uint8_t>(heldSeqNote_), 0, frameOffset);
            heldSeqNote_ = -1;
        }
    }

    bool renderInstrument(float* outL, float* outR, int numFrames,
                          double bpm, bool isPlaying) noexcept
    {
        std::unique_lock<std::mutex> lock(mutex, std::try_to_lock);
        if (! lock.owns_lock()) return false;            // swap in progress -> passthrough (silence)
        auto* inst = instance.get();
        const int nCh = scratch.getNumChannels();
        if (inst == nullptr || nCh < 1 || numFrames <= 0 || numFrames > maxBlockSize) return false;

        playHead.update(bpm, isPlaying, sampleRate, numFrames);
        const int maxOffset = juce::jmax(0, numFrames - 1);

        // Build the MIDI buffer for this block: ring events (off-thread producers) first, then any
        // events appended this callback by addMidiNow() (audio-thread sequencer note generation).
        // All offsets are clamped to this block here, so staging never assumes the block size.
        midi.clear();
        {
            const auto head = midiHead_.load(std::memory_order_acquire);
            auto tail = midiTail_.load(std::memory_order_relaxed);
            while (tail != head) {
                const MidiEvent& e = midiRing_[tail & (kMidiRingSize - 1)];
                if (e.status >= 0x80) {
                    const int off = juce::jlimit(0, maxOffset, static_cast<int>(e.frameOffset));
                    const int n = ((e.status & 0xF0) == 0xC0 || (e.status & 0xF0) == 0xD0) ? 2 : 3;
                    midi.addEvent(n == 2 ? juce::MidiMessage(e.status, e.data1)
                                         : juce::MidiMessage(e.status, e.data1, e.data2), off);
                }
                ++tail;
            }
            midiTail_.store(tail, std::memory_order_release);
        }
        for (const auto meta : pendingMidi_)
            midi.addEvent(meta.getMessage(), juce::jlimit(0, maxOffset, meta.samplePosition));
        pendingMidi_.clear();

        // Instruments ignore audio in: clear all channels, then run the plugin (it writes its
        // output into the buffer), then read its main stereo bus out.
        for (int c = 0; c < nCh; ++c)
            juce::FloatVectorOperations::clear(scratch.getWritePointer(c), numFrames);

        juce::AudioBuffer<float> view(scratch.getArrayOfWritePointers(), nCh, numFrames);
        const juce::ScopedNoDenormals noDenormals;
        inst->processBlock(view, midi);

        const auto bytes = sizeof(float) * static_cast<size_t>(numFrames);
        std::memcpy(outL, scratch.getReadPointer(0), bytes);
        std::memcpy(outR, scratch.getReadPointer(nCh > 1 ? 1 : 0), bytes);
        return true;
    }

private:
    std::array<MidiEvent, kMidiRingSize> midiRing_ {};
    std::atomic<std::uint32_t> midiHead_ { 0 };
    std::atomic<std::uint32_t> midiTail_ { 0 };
    std::mutex midiProducerMutex_;
    juce::MidiBuffer pendingMidi_;     // audio-thread-only staging for addMidiNow()
    int heldSeqNote_ = -1;             // monophonic sequencer note currently sounding (-1 = none)
    std::uint8_t heldSeqChannel_ = 0;  // channel the held seq note was started on
};

NativeInstrumentSlot::NativeInstrumentSlot() : impl_(std::make_unique<Impl>()) {}
NativeInstrumentSlot::~NativeInstrumentSlot() = default;

void NativeInstrumentSlot::prepare(double sampleRate, int maxBlockSize)
{
    impl_->prepare(sampleRate, maxBlockSize);
}
void NativeInstrumentSlot::loadAsync(NativePluginScanner& scanner,
                                     const std::string& identifier,
                                     const std::string& stateBase64,
                                     std::function<void(bool, std::string)> completion)
{
    impl_->loadAsync(scanner, identifier, stateBase64, std::move(completion));
}
void NativeInstrumentSlot::unload() { impl_->unload(); }
void NativeInstrumentSlot::destroyNow() { impl_->destroyNow(); }
bool NativeInstrumentSlot::hasPlugin() const noexcept { return impl_->has(); }
int  NativeInstrumentSlot::latencySamples() const noexcept { return impl_->latency.load(std::memory_order_acquire); }
void NativeInstrumentSlot::enqueueMidi(std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                                       std::uint32_t frameOffset) noexcept
{
    impl_->enqueueMidi(status, data1, data2, frameOffset);
}
void NativeInstrumentSlot::addMidiNow(std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                                      std::uint32_t frameOffset) noexcept
{
    impl_->addMidiNow(status, data1, data2, frameOffset);
}
void NativeInstrumentSlot::sequencerNoteNow(std::uint8_t channel, int note, std::uint8_t velocity,
                                            std::uint32_t frameOffset) noexcept
{
    impl_->sequencerNoteNow(channel, note, velocity, frameOffset);
}
void NativeInstrumentSlot::releaseSequencerNoteNow(std::uint32_t frameOffset) noexcept
{
    impl_->releaseSequencerNoteNow(frameOffset);
}
void NativeInstrumentSlot::allNotesOff() noexcept { impl_->allNotesOff(); }
bool NativeInstrumentSlot::renderInstrument(float* outL, float* outR, int numFrames,
                                            double bpm, bool isPlaying) noexcept
{
    return impl_->renderInstrument(outL, outR, numFrames, bpm, isPlaying);
}
std::string NativeInstrumentSlot::stateBase64() const { return impl_->stateB64(); }
std::string NativeInstrumentSlot::loadedName() const { return impl_->name(); }
void NativeInstrumentSlot::openEditor() { impl_->openEditor(); }
void NativeInstrumentSlot::closeEditor() { impl_->closeEditor(); }
void NativeInstrumentSlot::setEditorVisible(bool visible) { impl_->setEditorVisible(visible); }
int  NativeInstrumentSlot::programCount() const { return impl_->programCount(); }
int  NativeInstrumentSlot::currentProgram() const { return impl_->currentProgram(); }
std::string NativeInstrumentSlot::currentProgramName() const { return impl_->currentProgramName(); }
void NativeInstrumentSlot::setProgram(int index) { impl_->setProgram(index); }

} // namespace scoopyloops

#else // !SCOOPY_PLUGIN_HOST

// Stub implementation so the (JUCE-free) header still links if the host is
// disabled. Not reached in the ScoopyLoops target (which always defines the flag).
namespace scoopyloops {
int runPluginScanWorker(const std::string&, const std::string&) { return 1; }
class NativePluginScanner::Impl {};
NativePluginScanner::NativePluginScanner() = default;
NativePluginScanner::~NativePluginScanner() = default;
void NativePluginScanner::beginScan(std::function<void(float)>, std::function<void()> completion) { if (completion) completion(); }
bool NativePluginScanner::isScanning() const noexcept { return false; }
std::vector<ScannedPluginInfo> NativePluginScanner::results() const { return {}; }
std::string NativePluginScanner::knownPluginListXml() const { return {}; }
void NativePluginScanner::restoreFromXml(const std::string&) {}

class NativePluginSlot::Impl {};
NativePluginSlot::NativePluginSlot() = default;
NativePluginSlot::~NativePluginSlot() = default;
void NativePluginSlot::prepare(double, int) {}
void NativePluginSlot::loadAsync(NativePluginScanner&, const std::string&, const std::string&,
                                 std::function<void(bool, std::string)> completion) { if (completion) completion(false, {}); }
void NativePluginSlot::unload() {}
void NativePluginSlot::destroyNow() {}
bool NativePluginSlot::hasPlugin() const noexcept { return false; }
bool NativePluginSlot::isLoadedLockFree() const noexcept { return false; }
int  NativePluginSlot::latencySamples() const noexcept { return 0; }
bool NativePluginSlot::processStereoBlock(float*, float*, int, double, bool) noexcept { return false; }
std::string NativePluginSlot::stateBase64() const { return {}; }
std::string NativePluginSlot::loadedName() const { return {}; }
std::string NativePluginSlot::loadedIdentifier() const { return {}; }
void NativePluginSlot::openEditor() {}
void NativePluginSlot::closeEditor() {}
void NativePluginSlot::setEditorVisible(bool) {}
// The stub host has no plugins, so it has no editors — and saying so is what
// makes the headless dispatcher's refusal honest rather than a silent false.
bool NativePluginSlot::editorAvailable() const noexcept { return false; }
bool NativePluginSlot::editorVisible() const noexcept { return false; }

class NativeInstrumentSlot::Impl {};
NativeInstrumentSlot::NativeInstrumentSlot() = default;
NativeInstrumentSlot::~NativeInstrumentSlot() = default;
void NativeInstrumentSlot::prepare(double, int) {}
void NativeInstrumentSlot::loadAsync(NativePluginScanner&, const std::string&, const std::string&,
                                     std::function<void(bool, std::string)> completion) { if (completion) completion(false, {}); }
void NativeInstrumentSlot::unload() {}
void NativeInstrumentSlot::destroyNow() {}
bool NativeInstrumentSlot::hasPlugin() const noexcept { return false; }
int  NativeInstrumentSlot::latencySamples() const noexcept { return 0; }
void NativeInstrumentSlot::enqueueMidi(std::uint8_t, std::uint8_t, std::uint8_t, std::uint32_t) noexcept {}
void NativeInstrumentSlot::addMidiNow(std::uint8_t, std::uint8_t, std::uint8_t, std::uint32_t) noexcept {}
void NativeInstrumentSlot::sequencerNoteNow(std::uint8_t, int, std::uint8_t, std::uint32_t) noexcept {}
void NativeInstrumentSlot::releaseSequencerNoteNow(std::uint32_t) noexcept {}
void NativeInstrumentSlot::allNotesOff() noexcept {}
bool NativeInstrumentSlot::renderInstrument(float*, float*, int, double, bool) noexcept { return false; }
std::string NativeInstrumentSlot::stateBase64() const { return {}; }
std::string NativeInstrumentSlot::loadedName() const { return {}; }
void NativeInstrumentSlot::openEditor() {}
void NativeInstrumentSlot::closeEditor() {}
void NativeInstrumentSlot::setEditorVisible(bool) {}
int  NativeInstrumentSlot::programCount() const { return 0; }
int  NativeInstrumentSlot::currentProgram() const { return -1; }
std::string NativeInstrumentSlot::currentProgramName() const { return {}; }
void NativeInstrumentSlot::setProgram(int) {}
} // namespace scoopyloops

#endif // SCOOPY_PLUGIN_HOST
