// The merged shell — scoopy's real UI, hosted in JUCE, on the SL ABI v3 engine.
//
// This is what the P1 spike proved and the native foundation built toward: the
// committed scoopy webdist (vendored, hash-pinned) in multi-window JUCE
// WebViews, speaking the JuceLink contract to a REAL v3 engine that renders
// through wizard's AudioIO. Everything behind the transport is unit-tested
// (SlDispatch, SlWorldApply, sl_hotframe, FileSettingsStore, SlRenderSink); this
// file is the assembly, which is GUI and so verified by RUNNING it, not by a
// headless test (kickoff law 5 — the visual pass is the user's).
//
// Runs alongside the legacy Wizard app (Main.cpp) until the P3 flip retires the
// wizard-UI host; this is additive, not a replacement.
#include <juce_gui_extra/juce_gui_extra.h>

#include "AudioIO.h"
#include "RecordService.h"
#include "SlDispatch.h"
#include "SlRenderSink.h"
#include "SlSettingsStore.h"
#include "SlTakeDrainSource.h"
#include "SlWorldApply.h"
#include "WebResources.h"
#include "sl_engine.h"

#include <memory>
#include <vector>

namespace {

constexpr int kScoopySchemaVersion = 87; // must equal scoopy schema.ts SCHEMA_VERSION

std::optional<juce::WebBrowserComponent::Resource>
provideResource(const juce::String& path) {
    const juce::File root{MERGED_WEBDIST_DIR}; // the vendored, hash-pinned webdist
    auto payload = wizard::webresources::load(root, path);
    if (!payload.has_value()) return std::nullopt;
    const auto* bytes = static_cast<const std::byte*>(payload->data.getData());
    return juce::WebBrowserComponent::Resource{
        std::vector<std::byte>(bytes, bytes + payload->data.getSize()),
        payload->mimeType,
    };
}

class GuardedWebView final : public juce::WebBrowserComponent {
public:
    using juce::WebBrowserComponent::WebBrowserComponent;
    bool pageAboutToLoad(const juce::String& newURL) override {
        // Same allowlist as the legacy shell: a stray drop must not navigate the
        // app away (P1 spike §Q3). Unit-tested in web_resources_test.
        return wizard::webresources::navigationAllowed(
            newURL, juce::WebBrowserComponent::getResourceProviderRoot());
    }
};

/** The engine + device + settings the whole app shares. One engine, one device;
    every window is another view onto it. */
struct Backend {
    sl_engine* engine;
    wizard::host::SlRenderSink sink;
    wizard::host::AudioIO audioIO;
    wizard::sl::FileSettingsStore settings;
    juce::String deviceError;

    // RECORDING. Added with the plane (merge P2 step 4), and it was genuinely
    // missing rather than merely unwired: only the legacy shell had a
    // RecordService, so on this host `sl_tape_record_start` filled a drain ring
    // nobody emptied and allocated no chunks ahead of the render. Pressing REC
    // would have produced no file and, once the pre-seeded capacity ran out, no
    // further audio either.
    //
    // The drain source is the ENGINE-AGNOSTIC seam (TakeDrainSource): one
    // take-writing implementation serves wizard's decks and this engine's tapes,
    // so a take is a take — same crash-safe writer, same sidecar, same Law C-2
    // stamp handling — regardless of which engine captured it.
    wizard::record::SlTakeDrainSource drainSource;
    wizard::record::Service recorder;
    wizard::sl::HostServices services;

    explicit Backend(sl_engine* e)
        : engine(e),
          sink(e),
          audioIO(sink),
          settings(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                       .getChildFile("WizardMerged/settings.json")),
          drainSource(e) {
        // Opening the device starts the engine (SlRenderSink::setSampleRate does
        // the D-WZ-RATE-01 stop→set→start). A failure leaves the app running,
        // silent, rather than refusing to open — the UI still comes up.
        deviceError = audioIO.open(sl_engine_sample_rate(engine));

        // Takes live beside the settings, under the app's own data directory,
        // unless the user has chosen a folder. Same key the settings quartet
        // already carries, so the Audio panel's picker points at this without
        // needing a second setting.
        const auto stored = settings.get("recordings.dir").toString();
        const auto takesDir =
            stored.isNotEmpty()
                ? juce::File(stored)
                : juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                      .getChildFile("WizardMerged/Takes");
        services.takesDir = takesDir.getFullPathName().toStdString();
        // start() creates the directory and launches the drain thread. If it
        // fails, `recorder` stays unstarted and the dispatcher's record commands
        // refuse honestly — the app still runs and still plays.
        if (recorder.start(drainSource, services.takesDir)) services.recorder = &recorder;
        services.audio = &audioIO; // the plane's input source picker reads this
    }

    ~Backend() {
        // Before the engine goes: the drain thread holds a reference to it, and
        // finalizes any take still open so a quit mid-record leaves a playable
        // file rather than a truncated one.
        recorder.stop();
    }
};

} // namespace

/** One panel window: a DocumentWindow whose content is a scoopy panel. Multiple
    of these is the spike's resolved multi-window model — each an independent
    React root with its own JuceLink, all onto the one Backend. */
class PanelWindow final : public juce::DocumentWindow {
public:
    using OpenPanel = std::function<void(const juce::String&)>;
    using CloseSelf = std::function<void(PanelWindow*)>;

    PanelWindow(Backend& backendToUse, juce::String panel, bool isMainToUse,
                OpenPanel openPanel, CloseSelf closeSelf)
        : juce::DocumentWindow("ScoopyLoops - " + panel, juce::Colours::black,
                               juce::DocumentWindow::allButtons),
          backend(backendToUse),
          panelName(std::move(panel)),
          isMain(isMainToUse),
          openPanelFn(std::move(openPanel)),
          closeSelfFn(std::move(closeSelf)) {
        webView = std::make_unique<GuardedWebView>(
            juce::WebBrowserComponent::Options{}
                .withNativeIntegrationEnabled()
                .withResourceProvider(provideResource)
                // Panel identity, the same hook the mac shell uses: scoopy's
                // App.tsx reads window.__slPanel first (P1 spike §Q2).
                .withUserScript("window.__slPanel = \"" + panelName + "\";")
                .withNativeFunction(
                    "slCommand",
                    [this](const juce::Array<juce::var>& args,
                           juce::WebBrowserComponent::NativeFunctionCompletion complete) {
                        complete(handleCommand(args));
                    })
                // Live control writes. §3 (the deck-scope param surface) is not
                // in v3 yet, so these are received and dropped rather than
                // misrouted — the snapshot/worldPublish path is what plays.
                .withEventListener("slParam", [](juce::var) {}));

        setUsingNativeTitleBar(true);
        setContentNonOwned(webView.get(), false);
        setResizable(true, false);
        centreWithSize(1200, 780);
        setVisible(true);
        webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    }

    void closeButtonPressed() override {
        // The main window closing quits the app; a spawned panel just closes.
        if (isMain) juce::JUCEApplication::getInstance()->systemRequestedQuit();
        else closeSelfFn(this);
    }

    /** Push one HotFrame to this window's UI (message thread; touches the view). */
    void emitHotFrame(const juce::Array<juce::var>& frame) {
        if (webView != nullptr) webView->emitEventIfBrowserIsVisible("slHotFrame", juce::var(frame));
    }

private:
    juce::var handleCommand(const juce::Array<juce::var>& args) {
        const auto method = args.size() > 0 ? args[0].toString() : juce::String();
        const auto params = args.size() > 1 ? args[1] : juce::var();

        // Window-spawning is shell-owned (it needs the window layer), like the
        // legacy shell answers device/dialog commands before the pure
        // dispatcher. This IS the multi-window model: the UI asks, the shell
        // opens another DocumentWindow.
        if (method == "openInstrumentWindow" || method == "openFxSlotWindow" ||
            method == "openAudioRoutingWindow" || method == "openPanelWindow") {
            // openPanelWindow is the plane's own spawn verb (merge P2 step 4):
            // it names the panel rather than encoding it in the method, which is
            // what "compose beside the map" needs — the plane opens a compose
            // window per strip and cannot know at schema-writing time which
            // panels a strip will want.
            const auto panel = method == "openFxSlotWindow"         ? juce::String("fxslot")
                               : method == "openAudioRoutingWindow" ? juce::String("audio")
                               : method == "openPanelWindow"
                                   ? params.getProperty("panel", "companion").toString()
                                   : juce::String("instrument");
            openPanelFn(panel);
            auto* env = new juce::DynamicObject();
            env->setProperty("ok", true);
            env->setProperty("result", juce::var(new juce::DynamicObject()));
            return juce::var(env);
        }

        // Everything else (the boot handshake, the worldPublish play path and
        // the plane's strip surface) is the pure, unit-tested dispatcher.
        return wizard::sl::dispatch(method, params, backend.settings, backend.engine,
                                    &backend.services);
    }

    Backend& backend;
    juce::String panelName;
    bool isMain;
    OpenPanel openPanelFn;
    CloseSelf closeSelfFn;
    std::unique_ptr<GuardedWebView> webView;
};

class MergedApplication final : public juce::JUCEApplication,
                                private juce::Timer {
public:
    const juce::String getApplicationName() override { return "WizardMerged"; }
    const juce::String getApplicationVersion() override { return "0.0.1"; }

    void initialise(const juce::String&) override {
        engine = sl_engine_create(48000.0, 512, kScoopySchemaVersion);
        jassert(engine != nullptr);
        jassert(sl_abi_version() == SL_ABI_VERSION);
        backend = std::make_unique<Backend>(engine);

        // The primary window is the PLANE — the merged app's top-level surface
        // (merge P2 step 4): strips, their elements and the patchbay. The
        // companion shell stays reachable as a spawned panel; it is where a
        // session is composed, which is a different job from performing a set.
        openPanel("plane", /*isMain*/ true);
        startTimerHz(30); // the HotFrame broadcast
    }

    void shutdown() override {
        stopTimer();
        windows.clear();
        backend.reset();
        if (engine != nullptr) { sl_engine_destroy(engine); engine = nullptr; }
    }

private:
    void openPanel(const juce::String& panel, bool isMain = false) {
        windows.push_back(std::make_unique<PanelWindow>(
            *backend, panel, isMain,
            [this](const juce::String& p) { openPanel(p, false); },
            [this](PanelWindow* w) { removeWindow(w); }));
    }

    void removeWindow(PanelWindow* w) {
        // DEFERRED: this is called from w's own closeButtonPressed, so erasing
        // the owning unique_ptr here would delete `w` while its method is still
        // on the stack — a use-after-free the moment control returns. Hop to a
        // later message so the window is torn down after its callback unwinds.
        juce::MessageManager::callAsync([this, w] {
            windows.erase(std::remove_if(windows.begin(), windows.end(),
                                         [w](const std::unique_ptr<PanelWindow>& p) { return p.get() == w; }),
                          windows.end());
        });
    }

    void timerCallback() override {
        const auto len = sl_hotframe_length();
        if (hotFrameBuf.size() < len) hotFrameBuf.resize(len, 0.0);
        const auto n = sl_hotframe(engine, hotFrameBuf.data(),
                                   static_cast<uint32_t>(hotFrameBuf.size()));
        juce::Array<juce::var> frame;
        frame.ensureStorageAllocated(static_cast<int>(n));
        for (uint32_t i = 0; i < n; ++i) frame.add(hotFrameBuf[i]);
        for (auto& w : windows) w->emitHotFrame(frame);
    }

    sl_engine* engine = nullptr;
    std::unique_ptr<Backend> backend;
    std::vector<std::unique_ptr<PanelWindow>> windows;
    std::vector<double> hotFrameBuf;
};

START_JUCE_APPLICATION(MergedApplication)
