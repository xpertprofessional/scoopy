// Wizard shell: window chrome + a WebView serving the committed web bundle via
// JUCE's resource provider (no web server). This P0-06 increment proves boot +
// serve + engine linkage; the SLP transport (wzCommand / wzParam / wzHotFrame)
// lands in P0-07 and the duplex audio device in P0-11.
//
// Shell law (docs/ARCHITECTURE.md §1): a shell may contain ONLY EngineLink
// transport, window/menu chrome, file dialogs, lifecycle/permissions. Anything
// else here is a bug.
#include <juce_gui_extra/juce_gui_extra.h>

#include "AudioIO.h"
#include "WzRenderSink.h"
#include "CommandDispatch.h"
#include "PackageStore.h"
#include "SessionStore.h"
#include "Decoder.h"
#include "RecordService.h"
#include "WZProtocol.h"
#include "WebResources.h"
#include "wz_engine.h"

namespace {

std::optional<juce::WebBrowserComponent::Resource>
provideResource(const juce::String& path) {
    const juce::File root{WIZARD_WEBDIST_DIR};
    auto payload = wizard::webresources::load(root, path);
    if (!payload.has_value()) return std::nullopt;

    const auto* bytes = static_cast<const std::byte*>(payload->data.getData());
    return juce::WebBrowserComponent::Resource{
        std::vector<std::byte>(bytes, bytes + payload->data.getSize()),
        payload->mimeType,
    };
}

/** The shell's WebView, with a navigation policy. A plain WebBrowserComponent
    will happily navigate away from the app when a file is dropped on it — the
    running UI is replaced by a media page and its state is gone. Policy lives
    in WebResources so it is unit-tested without a GUI. */
class GuardedWebView final : public juce::WebBrowserComponent {
public:
    using juce::WebBrowserComponent::WebBrowserComponent;

    bool pageAboutToLoad(const juce::String& newURL) override {
        return wizard::webresources::navigationAllowed(
            newURL, juce::WebBrowserComponent::getResourceProviderRoot());
    }
};

} // namespace

// Hosts the WebView and owns the three WZP transport paths:
//   Command    — native function "wzCommand" -> CommandDispatch
//   ParamWrite — event "wzParam" {id, value}, keyed by NAME across the ABI
//   HotFrame   — 30 Hz timer emitting "wzHotFrame" as a flat Float64 array
class MainWindow final : public juce::DocumentWindow,
                         private juce::Timer {
public:
    explicit MainWindow(wz_engine* engineToUse)
        : juce::DocumentWindow("Wizard",
                               juce::Colours::black,
                               juce::DocumentWindow::allButtons),
          engine(engineToUse),
          engineSink(engineToUse),
          audioIO(engineSink) {
        // Open the default duplex device at the engine's rate (D-WZ-RATE-01).
        // A failure (no device / unsupported rate) leaves the app running,
        // silent; the boot tone simply won't be audible until a device opens.
        deviceError = audioIO.open(wz_engine_sample_rate(engine));
        // Takes live beside the session; a dedicated dir until P7's package.
        takesRoot = juce::File::getSpecialLocation(juce::File::userMusicDirectory)
                        .getChildFile("Wizard/Takes");
        recorder.start(engine, takesRoot.getFullPathName().toStdString());
        webView = std::make_unique<GuardedWebView>(
            juce::WebBrowserComponent::Options{}
                .withNativeIntegrationEnabled()
                .withResourceProvider(provideResource)
                .withNativeFunction(
                    "wzCommand",
                    [this](const juce::Array<juce::var>& args,
                           juce::WebBrowserComponent::NativeFunctionCompletion complete) {
                        const auto method = args.size() > 0 ? args[0].toString() : juce::String();
                        const auto params = args.size() > 1 ? args[1] : juce::var();
                        // Shell-owned: needs the host device layer, so it is
                        // answered here rather than in the pure dispatcher
                        // (parlante's chooseAndLoadFile precedent).
                        if (method == "getDeviceInfo") {
                            complete(deviceInfoReply());
                            return;
                        }
                        if (method == "deckRecordStart" || method == "deckRecordStop" ||
                            method == "listTakes" || method == "deleteTake" ||
                            method == "revealTake") {
                            complete(recordCommand(method, params));
                            return;
                        }
                        // deckLoadTake decodes a take file, so it takes the same
                        // off-thread path as deckLoadFile (P1-11) — never the
                        // synchronous recordCommand path that would block here.
                        // INSERT decodes a file then splices with the render
                        // detached — the same off-thread decode as a load, but
                        // the buffer surgery must not race the reader.
                        if (method == "deckInsertTake") {
                            complete(insertTake(params));
                            return;
                        }
                        if (method == "deckLoadTake") {
                            const auto deck = static_cast<uint32_t>(
                                static_cast<int>(params.getProperty("deck", 0)));
                            const juce::File file(params.getProperty("path", "").toString());
                            startDeckLoad(deck, file, /*fromDialog*/ false, std::move(complete));
                            return;
                        }
                        if (method == "saveAutosave" || method == "loadAutosave") {
                            complete(sessionCommand(method, params));
                            return;
                        }
                        // Package save/load need the window + an async native
                        // dialog, so they live here rather than in the pure
                        // dispatcher (same reason as deckLoadFile).
                        if (method == "savePackage") {
                            savePackage(params, std::move(complete));
                            return;
                        }
                        if (method == "loadPackage") {
                            loadPackage(std::move(complete));
                            return;
                        }
                        if (method == "listDevices") {
                            complete(listDevicesReply());
                            return;
                        }
                        if (method == "setDevice") {
                            complete(setDeviceReply(params));
                            return;
                        }
                        // File-open needs the window + an async native dialog,
                        // so it lives here rather than in the pure dispatcher.
                        if (method == "deckLoadFile") {
                            const auto deck = static_cast<uint32_t>(
                                static_cast<int>(params.getProperty("deck", 0)));
                            deckLoadFile(deck, std::move(complete));
                            return;
                        }
                        complete(wizard::command::dispatch(engine, method, params));
                    })
                .withEventListener(
                    "wzParam", [this](juce::var payload) {
                        // Keyed by NAME across the ABI (never a hardcoded id):
                        // JS resolved the name at boot, the engine resolves it
                        // again here. `channel` selects the strip; master-global
                        // params (mainGain) ignore it.
                        const auto name = payload.getProperty("id", juce::var()).toString();
                        const auto channel = static_cast<uint32_t>(
                            static_cast<int>(payload.getProperty("channel", 0)));
                        const auto value = static_cast<double>(payload.getProperty("value", 0.0));
                        const auto id = wz_param_id_for_name(name.toRawUTF8());
                        if (id != WZ_PARAM_UNKNOWN) wz_param_set(engine, channel, id, value);
                    }));

        setUsingNativeTitleBar(true);
        setContentNonOwned(webView.get(), false);
        setResizable(true, false);
        centreWithSize(1280, 800);
        setVisible(true);

        webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
        startTimerHz(30);
    }

    ~MainWindow() override { stopTimer(); }

    void closeButtonPressed() override {
        juce::JUCEApplication::getInstance()->systemRequestedQuit();
    }

private:
    // Async native file-open → hand the chosen file to the off-thread loader.
    void deckLoadFile(uint32_t deck,
                      juce::WebBrowserComponent::NativeFunctionCompletion complete) {
        fileChooser = std::make_unique<juce::FileChooser>(
            "Load audio into deck " + juce::String(deck + 1), juce::File{},
            "*.wav;*.aiff;*.aif;*.flac;*.ogg;*.mp3;*.m4a");
        const auto chooserFlags = juce::FileBrowserComponent::openMode |
                                  juce::FileBrowserComponent::canSelectFiles;
        fileChooser->launchAsync(chooserFlags, [this, deck, complete](const juce::FileChooser& fc) {
            const auto file = fc.getResult();
            if (file == juce::File{}) { // dialog cancelled — not a load at all
                auto* result = new juce::DynamicObject();
                result->setProperty("ok", false);
                result->setProperty("path", "");
                result->setProperty("channels", 0);
                result->setProperty("sampleRate", 0.0);
                result->setProperty("engineFrames", static_cast<juce::int64>(0));
                complete(wrapResult(result));
                return;
            }
            startDeckLoad(deck, file, /*fromDialog*/ true, complete);
        });
    }

    // Decode + SINC_BEST resample run on a worker thread, NOT the message thread
    // (P1-11): a multi-minute file at an off-engine rate used to freeze the UI
    // and stall the HotFrame meters for the whole conversion. Only the cheap
    // wz_deck_load buffer swap needs the render callback detached, and that hops
    // back to the message thread. A newer load for the same deck SUPERSEDES an
    // in-flight one (generation check) so a rapid reload never swaps stale audio
    // in after the fresh one.
    void startDeckLoad(uint32_t deck, const juce::File& file, bool fromDialog,
                       juce::WebBrowserComponent::NativeFunctionCompletion complete) {
        if (deck >= deckLoadGen.size()) { // out of range: fail honestly, don't crash
            auto* result = new juce::DynamicObject();
            result->setProperty("ok", false);
            if (fromDialog) {
                result->setProperty("path", "");
                result->setProperty("channels", 0);
                result->setProperty("sampleRate", 0.0);
                result->setProperty("engineFrames", static_cast<juce::int64>(0));
            } else {
                result->setProperty("channels", 0);
                result->setProperty("engineFrames", static_cast<juce::int64>(0));
                result->setProperty("error", "deck index out of range");
            }
            complete(wrapResult(result));
            return;
        }
        const uint32_t myGen = ++deckLoadGen[deck];
        const double engineRate = wz_engine_sample_rate(engine);
        emitDeckLoad(deck, 0.0f, /*loading*/ true); // a definite "started" before any decode
        loadPool.addJob([this, deck, file, fromDialog, myGen, engineRate, complete] {
            wizard::decode::LoadControl ctl;
            ctl.isCancelled = [this, deck, myGen] {
                return deckLoadGen[deck].load() != myGen; // a newer load arrived
            };
            ctl.onProgress = [this, deck, myGen](float p) {
                // Progress fires on THIS worker thread; the WebView may only be
                // touched from the message thread. Drop the tick if a newer load
                // has taken over — its own ticks are the ones that matter now.
                juce::MessageManager::callAsync([this, deck, myGen, p] {
                    if (deckLoadGen[deck].load() == myGen) emitDeckLoad(deck, p, true);
                });
            };
            auto audio = std::make_shared<wizard::decode::DeckAudio>(
                wizard::decode::loadForDeck(file, engineRate, ctl));
            juce::MessageManager::callAsync([this, deck, fromDialog, myGen, engineRate, file,
                                             audio, complete]() mutable {
                const bool stale = deckLoadGen[deck].load() != myGen;
                bool loaded = false;
                if (audio->ok && !stale) {
                    std::vector<const float*> planar;
                    planar.reserve(audio->data.size());
                    for (const auto& ch : audio->data) planar.push_back(ch.data());
                    audioIO.whileSuspended([&] {
                        loaded = wz_deck_load(engine, deck, audio->channels,
                                              audio->engineFrames(), planar.data(),
                                              engineRate) == 1;
                    });
                }
                auto* result = new juce::DynamicObject();
                result->setProperty("ok", loaded);
                if (fromDialog) {
                    result->setProperty("path", loaded ? file.getFullPathName() : juce::String());
                    result->setProperty("channels", static_cast<int>(audio->channels));
                    result->setProperty("sampleRate", audio->sourceRate);
                    result->setProperty("engineFrames",
                                        static_cast<juce::int64>(audio->engineFrames()));
                } else {
                    result->setProperty("channels", static_cast<int>(audio->channels));
                    result->setProperty("engineFrames",
                                        static_cast<juce::int64>(audio->engineFrames()));
                    result->setProperty("error",
                                        loaded ? "" : (stale ? "superseded" : audio->error));
                }
                // Terminal event: the bar settles. A superseded load stays quiet
                // — the newer load owns the deck's progress now and will emit its
                // own terminal event, so emitting here would fight it.
                if (!stale) emitDeckLoad(deck, loaded ? 1.0f : 0.0f, /*loading*/ false);
                complete(wrapResult(result));
            });
        });
    }

    /** Push deck-load progress to the web (P1-11a). Message thread only — it
        touches the WebView. Mirrors the wzHotFrame emit path. */
    void emitDeckLoad(uint32_t deck, float progress, bool loading) {
        if (webView == nullptr) return;
        auto* o = new juce::DynamicObject();
        o->setProperty("deck", static_cast<int>(deck));
        o->setProperty("progress", static_cast<double>(progress));
        o->setProperty("loading", loading);
        webView->emitEventIfBrowserIsVisible("wzDeckLoad", juce::var(o));
    }

    static juce::var strArray(const juce::StringArray& in) {
        juce::Array<juce::var> a;
        for (const auto& s : in) a.add(s);
        return juce::var(a);
    }

    // Record commands are shell-owned: they need the host RecordService (file
    // paths, drain thread) which the pure dispatcher must not know about.
    juce::var recordCommand(const juce::String& method, const juce::var& params) {
        auto* result = new juce::DynamicObject();
        if (method == "deckRecordStart") {
            const auto deck = static_cast<uint32_t>(static_cast<int>(params.getProperty("deck", 0)));
            const auto c0 = static_cast<int32_t>(static_cast<int>(params.getProperty("chan0", 0)));
            const auto c1 = static_cast<int32_t>(static_cast<int>(params.getProperty("chan1", -1)));
            const auto desc = params.getProperty("sourceDesc", "").toString();
            wz_deck_set_record_source(engine, deck, c0, c1);
            wz_deck_record_service(engine); // pre-allocate before capture begins
            wz_deck_record_start(engine, deck);
            const bool ok = recorder.beginTake(deck, c1 >= 0 ? 2u : 1u,
                                               wz_engine_sample_rate(engine),
                                               0 /* stamped by the engine */,
                                               desc.toStdString());
            result->setProperty("ok", ok);
            result->setProperty("error", ok ? "" : "could not open take file");
        } else if (method == "deckRecordStop") {
            const auto deck = static_cast<uint32_t>(static_cast<int>(params.getProperty("deck", 0)));
            const auto stamp = wz_deck_record_stop(engine, deck);
            // Hand the engine's true start to the writer: the reply already
            // carried it, but the FILE, the sidecar and the TakeInfo did not.
            const bool ok = recorder.endTake(deck, stamp);
            result->setProperty("ok", ok);
            result->setProperty("startEngineSample", static_cast<juce::int64>(stamp));
            const auto all = recorder.takes();
            result->setProperty("take", all.empty() ? juce::var()
                                                    : takeToVar(all.back()));
        } else if (method == "listTakes") {
            juce::Array<juce::var> arr;
            for (const auto& t : recorder.takes()) arr.add(takeToVar(t));
            result->setProperty("takes", juce::var(arr));
        } else if (method == "deleteTake") {
            const auto path = params.getProperty("path", "").toString();
            // Forget it first: a take still being recorded is refused, and we
            // never want the list pointing at files we just moved away.
            const bool forgotten = recorder.forgetTake(path.toStdString());
            bool trashed = false;
            if (forgotten) {
                const juce::File wav(path);
                const juce::File sidecar(path + ".json");
                // moveToTrash, NOT delete: a mis-click stays recoverable.
                trashed = wav.moveToTrash();
                if (sidecar.existsAsFile()) sidecar.moveToTrash();
            }
            result->setProperty("ok", forgotten && trashed);
            result->setProperty("error",
                                !forgotten ? "take is still recording or unknown"
                                           : (trashed ? "" : "could not move the file to the Trash"));
        } else if (method == "revealTake") {
            const juce::File f(params.getProperty("path", "").toString());
            const bool ok = f.existsAsFile();
            if (ok) f.revealToUser();
            result->setProperty("ok", ok);
        }
        // NOTE: deckLoadTake is intentionally NOT handled here — it decodes a
        // file and so is routed to the off-thread startDeckLoad path (P1-11).
        auto* env = new juce::DynamicObject();
        env->setProperty("ok", true);
        env->setProperty("result", juce::var(result));
        return juce::var(env);
    }

    static juce::var takeToVar(const wizard::record::TakeInfo& t) {
        auto* o = new juce::DynamicObject();
        o->setProperty("deckId", static_cast<int>(t.deckId));
        o->setProperty("path", juce::String(t.path));
        o->setProperty("startEngineSample", static_cast<juce::int64>(t.startEngineSample));
        o->setProperty("frames", static_cast<juce::int64>(t.frames));
        o->setProperty("sampleRate", t.sampleRate);
        o->setProperty("channels", static_cast<int>(t.channels));
        o->setProperty("sourceDesc", juce::String(t.sourceDesc));
        return juce::var(o);
    }

    // Session persistence (P7-03). Shell-owned: the UI never touches paths.
    juce::File sessionDir() const {
        return juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
            .getChildFile("Wizard");
    }

    /** Where a package's embedded takes are extracted to. Beside the app's own
        takes rather than into them: a package's contents are the package's, and
        mixing them into the user's own recordings would make the two
        indistinguishable the moment they open a second package. */
    juce::File packageTakesDir(const juce::File& pkg) const {
        return sessionDir()
            .getChildFile("Packages")
            .getChildFile(pkg.getFileNameWithoutExtension());
    }

    void savePackage(const juce::var& params,
                     juce::WebBrowserComponent::NativeFunctionCompletion complete) {
        fileChooser = std::make_unique<juce::FileChooser>(
            "Save Wizard package", juce::File{}, "*.wizard");
        const auto flags = juce::FileBrowserComponent::saveMode |
                           juce::FileBrowserComponent::canSelectFiles |
                           juce::FileBrowserComponent::warnAboutOverwriting;
        const auto text = params.getProperty("text", "").toString();
        juce::Array<wizard::package::Entry> takes;
        juce::StringArray excluded;
        juce::StringArray used;
        if (const auto* arr = params.getProperty("takes", juce::var()).getArray()) {
            for (const auto& t : *arr) {
                const juce::File f(t.toString());
                // Only Wizard's OWN recordings travel. A file the user loaded
                // from their library stays a reference: copying someone's
                // library into our package is not ours to do (spec §1), and a
                // package that quietly absorbs gigabytes of their sample folder
                // is not one they would have agreed to share.
                if (!f.isAChildOf(takesRoot)) {
                    excluded.add(f.getFullPathName());
                    continue;
                }
                takes.add({f, wizard::package::entryNameFor(f, used)});
            }
        }
        fileChooser->launchAsync(flags, [takes, text, excluded,
                                         complete](const juce::FileChooser& fc) {
            auto* result = new juce::DynamicObject();
            auto file = fc.getResult();
            if (file == juce::File{}) { // cancelled — not an error
                result->setProperty("ok", false);
                result->setProperty("path", "");
                result->setProperty("missing", juce::var(juce::Array<juce::var>{}));
                result->setProperty("excluded", juce::var(juce::Array<juce::var>{}));
                result->setProperty("error", "");
            } else {
                if (!file.hasFileExtension("wizard")) file = file.withFileExtension("wizard");
                const auto r = wizard::package::save(file, text, takes);
                juce::Array<juce::var> missing;
                for (const auto& m : r.missing) missing.add(m);
                juce::Array<juce::var> notEmbedded;
                for (const auto& e : excluded) notEmbedded.add(e);
                result->setProperty("ok", r.ok);
                result->setProperty("path", r.ok ? file.getFullPathName() : juce::String());
                result->setProperty("missing", juce::var(missing));
                result->setProperty("excluded", juce::var(notEmbedded));
                result->setProperty("error", r.error);
            }
            complete(wrapResult(result));
        });
    }

    void loadPackage(juce::WebBrowserComponent::NativeFunctionCompletion complete) {
        fileChooser = std::make_unique<juce::FileChooser>(
            "Open Wizard package", juce::File{}, "*.wizard");
        const auto flags = juce::FileBrowserComponent::openMode |
                           juce::FileBrowserComponent::canSelectFiles;
        fileChooser->launchAsync(flags, [this, complete](const juce::FileChooser& fc) {
            auto* result = new juce::DynamicObject();
            const auto file = fc.getResult();
            juce::Array<juce::var> takes;
            if (file == juce::File{}) { // cancelled — not an error
                result->setProperty("ok", false);
                result->setProperty("text", "");
                result->setProperty("error", "");
            } else {
                const auto r = wizard::package::load(file, packageTakesDir(file));
                for (const auto& t : r.takes) {
                    auto* e = new juce::DynamicObject();
                    e->setProperty("name", t.name);
                    e->setProperty("path", t.source.getFullPathName());
                    takes.add(juce::var(e));
                }
                result->setProperty("ok", r.ok);
                result->setProperty("text", r.sessionText);
                result->setProperty("error", r.error);
            }
            result->setProperty("takes", juce::var(takes));
            complete(wrapResult(result));
        });
    }

    static juce::var wrapResult(juce::DynamicObject* result) {
        auto* env = new juce::DynamicObject();
        env->setProperty("ok", true);
        env->setProperty("result", juce::var(result));
        return juce::var(env);
    }

    /** Splice a take into a deck at its playhead (P3-14). Decode on this thread
        (a take is short and this is a deliberate edit, not a live gesture), then
        do the buffer surgery with the render callback DETACHED — wz_deck_insert
        rebuilds the deck's storage and must never race the reader. */
    juce::var insertTake(const juce::var& params) {
        auto* result = new juce::DynamicObject();
        const auto deck = static_cast<uint32_t>(static_cast<int>(params.getProperty("deck", 0)));
        const juce::File file(params.getProperty("path", "").toString());
        const auto engineRate = wz_engine_sample_rate(engine);
        const auto audio = wizard::decode::loadForDeck(file, engineRate);
        bool ok = false;
        if (audio.ok) {
            std::vector<const float*> planar;
            planar.reserve(audio.data.size());
            for (const auto& ch : audio.data) planar.push_back(ch.data());
            const auto at = static_cast<uint64_t>(wz_deck_playhead(engine, deck));
            audioIO.whileSuspended([&] {
                ok = wz_deck_insert(engine, deck, at, audio.channels, audio.engineFrames(),
                                    planar.data()) == 1;
            });
        }
        result->setProperty("ok", ok);
        result->setProperty("engineFrames",
                            static_cast<juce::int64>(ok ? wz_deck_frames(engine, deck) : 0));
        result->setProperty("error", ok ? "" : (audio.ok ? "could not splice (deck empty or cap reached)" : audio.error));
        return wrapResult(result);
    }

    juce::var sessionCommand(const juce::String& method, const juce::var& params) {
        auto* result = new juce::DynamicObject();
        const wizard::session::Store store{sessionDir()};

        if (method == "saveAutosave") {
            const bool ok = store.write(params.getProperty("text", "").toString());
            result->setProperty("ok", ok);
            result->setProperty("error", ok ? "" : "could not write the session");
        } else { // loadAutosave
            const auto loaded = store.read();
            result->setProperty("text", loaded.text);
            result->setProperty(
                "source", loaded.source == wizard::session::Source::primary  ? "primary"
                          : loaded.source == wizard::session::Source::backup ? "backup"
                                                                            : "none");
        }
        auto* env = new juce::DynamicObject();
        env->setProperty("ok", true);
        env->setProperty("result", juce::var(result));
        return juce::var(env);
    }

    juce::var listDevicesReply() const {
        auto* result = new juce::DynamicObject();
        result->setProperty("inputs", strArray(audioIO.availableInputDevices()));
        result->setProperty("outputs", strArray(audioIO.availableOutputDevices()));
        result->setProperty("currentInput", audioIO.inputDeviceName());
        result->setProperty("currentOutput", audioIO.deviceName());
        auto* env = new juce::DynamicObject();
        env->setProperty("ok", true);
        env->setProperty("result", juce::var(result));
        return juce::var(env);
    }

    juce::var setDeviceReply(const juce::var& params) {
        const auto in = params.getProperty("input", "").toString();
        const auto out = params.getProperty("output", "").toString();
        // Re-open at the current engine rate; decks survive (the engine is not
        // recreated). whileSuspended isn't needed — setDevices detaches/attaches
        // the callback itself around the switch.
        const auto err = audioIO.setDevices(in, out, wz_engine_sample_rate(engine));
        deviceError = err;
        auto* result = new juce::DynamicObject();
        result->setProperty("ok", err.isEmpty());
        result->setProperty("error", err);
        auto* env = new juce::DynamicObject();
        env->setProperty("ok", true);
        env->setProperty("result", juce::var(result));
        return juce::var(env);
    }

    juce::var deviceInfoReply() const {
        auto* result = new juce::DynamicObject();
        result->setProperty("deviceName", audioIO.deviceName());
        result->setProperty("inputDeviceName", audioIO.inputDeviceName());
        result->setProperty("error", deviceError);
        result->setProperty("sampleRate", audioIO.openedSampleRate());
        juce::Array<juce::var> inputs;
        const auto names = audioIO.activeInputChannelNames();
        for (int i = 0; i < names.size(); ++i) {
            auto* in = new juce::DynamicObject();
            in->setProperty("index", i);
            in->setProperty("name", names[i]);
            inputs.add(juce::var(in));
        }
        result->setProperty("inputs", juce::var(inputs));
        const auto outs = audioIO.activeOutputChannelCount();
        result->setProperty("outputChannels", outs);
        // routing.md §4: the cue pair exists only on a ≥4-output device.
        result->setProperty("monitorAvailable", outs >= 4);
        result->setProperty("mappableBuses",
                            static_cast<int>(wz_engine_mappable_buses(
                                static_cast<uint32_t>(outs))));
        auto* envelope = new juce::DynamicObject();
        envelope->setProperty("ok", true);
        envelope->setProperty("result", juce::var(result));
        return juce::var(envelope);
    }

    void timerCallback() override {
        // Frame length follows the world (scalars + per-channel + per-deck
        // blocks); the buffer is grown-only so steady state never reallocates.
        const auto len = wz_engine_hotframe_length(engine);
        if (hotFrameBuf.size() < len) hotFrameBuf.resize(len, 0.0);
        const auto n = wz_engine_hotframe(engine, hotFrameBuf.data(),
                                          static_cast<uint32_t>(hotFrameBuf.size()));
        juce::Array<juce::var> values;
        for (uint32_t i = 0; i < n; ++i) values.add(hotFrameBuf[i]);
        webView->emitEventIfBrowserIsVisible("wzHotFrame", juce::var(values));
    }

    wz_engine* engine;
    // Declared before audioIO: the device layer holds a REFERENCE to the sink,
    // so the sink must outlive it, and member destruction runs in reverse.
    wizard::host::WzRenderSink engineSink;
    std::vector<double> hotFrameBuf; // grown-only hotframe staging
    std::unique_ptr<juce::FileChooser> fileChooser; // kept alive across async dialog
    wizard::host::AudioIO audioIO;
    juce::File takesRoot;             // P7: only OUR recordings travel in a package
    wizard::record::Service recorder;
    // P1-11: deck decode/resample runs here, off the message thread. One worker
    // so loads serialise (a second load waits rather than fighting for cores);
    // deckLoadGen supersedes an in-flight load when a newer one for the same
    // deck arrives. Declared before nothing that outlives it — the pool joins on
    // destruction so a job never touches a half-torn-down window.
    std::array<std::atomic<uint32_t>, 8> deckLoadGen{};
    juce::ThreadPool loadPool{1}; // P3: drain thread -> take files // host device layer (host/), drives render
    juce::String deviceError;      // non-empty if the device wouldn't open at rate
    std::unique_ptr<juce::WebBrowserComponent> webView;
};

class WizardApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "Wizard"; }
    const juce::String getApplicationVersion() override { return "0.0.1"; }

    void initialise(const juce::String&) override {
        // Prove shell↔engine linkage and the schema handshake path from boot.
        // The real device rate + quantum replace these placeholders in P0-11.
        engine = wz_engine_create(48000.0, 512, wz::protocol::kSchemaVersion);
        jassert(engine != nullptr);
        jassert(wz_abi_version() == WZ_ABI_VERSION);
        window = std::make_unique<MainWindow>(engine);
    }

    void shutdown() override {
        window.reset();
        wz_engine_destroy(engine);
        engine = nullptr;
    }

private:
    std::unique_ptr<MainWindow> window;
    wz_engine* engine = nullptr;
};

START_JUCE_APPLICATION(WizardApplication)
