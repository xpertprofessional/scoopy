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
#include "CommandDispatch.h"
#include "Decoder.h"
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
          audioIO(engineToUse) {
        // Open the default duplex device at the engine's rate (D-WZ-RATE-01).
        // A failure (no device / unsupported rate) leaves the app running,
        // silent; the boot tone simply won't be audible until a device opens.
        deviceError = audioIO.open(wz_engine_sample_rate(engine));
        webView = std::make_unique<juce::WebBrowserComponent>(
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
    // Async native file-open → decode + SINC_BEST resample (off the render
    // path) → wz_deck_load with the render callback detached. Cancel = ok:false.
    void deckLoadFile(uint32_t deck,
                      juce::WebBrowserComponent::NativeFunctionCompletion complete) {
        fileChooser = std::make_unique<juce::FileChooser>(
            "Load audio into deck " + juce::String(deck + 1), juce::File{},
            "*.wav;*.aiff;*.aif;*.flac;*.ogg;*.mp3;*.m4a");
        const auto chooserFlags = juce::FileBrowserComponent::openMode |
                                  juce::FileBrowserComponent::canSelectFiles;
        fileChooser->launchAsync(chooserFlags, [this, deck, complete](const juce::FileChooser& fc) {
            const auto file = fc.getResult();
            auto* result = new juce::DynamicObject();
            if (file == juce::File{}) { // cancelled
                result->setProperty("ok", false);
                result->setProperty("path", "");
                result->setProperty("channels", 0);
                result->setProperty("sampleRate", 0.0);
                result->setProperty("engineFrames", static_cast<juce::int64>(0));
            } else {
                // Decode + resample BEFORE suspending: only the cheap buffer
                // copy needs the engine detached (D-WZ-DECKSRC-01).
                const auto engineRate = wz_engine_sample_rate(engine);
                const auto audio = wizard::decode::loadForDeck(file, engineRate);
                bool loaded = false;
                if (audio.ok) {
                    std::vector<const float*> planar;
                    planar.reserve(audio.data.size());
                    for (const auto& ch : audio.data) planar.push_back(ch.data());
                    audioIO.whileSuspended([&] {
                        loaded = wz_deck_load(engine, deck, audio.channels,
                                              audio.engineFrames(), planar.data(),
                                              engineRate) == 1;
                    });
                }
                result->setProperty("ok", loaded);
                result->setProperty("path", file.getFullPathName());
                result->setProperty("channels", static_cast<int>(audio.channels));
                result->setProperty("sampleRate", audio.sourceRate);
                result->setProperty("engineFrames",
                                    static_cast<juce::int64>(audio.engineFrames()));
            }
            auto* envelope = new juce::DynamicObject();
            envelope->setProperty("ok", true); // the command itself succeeded
            envelope->setProperty("result", juce::var(result));
            complete(juce::var(envelope));
        });
    }

    juce::var deviceInfoReply() const {
        auto* result = new juce::DynamicObject();
        result->setProperty("deviceName", audioIO.deviceName());
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
    std::vector<double> hotFrameBuf; // grown-only hotframe staging
    std::unique_ptr<juce::FileChooser> fileChooser; // kept alive across async dialog
    wizard::host::AudioIO audioIO; // host device layer (host/), drives render
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
