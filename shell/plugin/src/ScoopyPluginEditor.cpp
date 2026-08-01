#include "ScoopyPluginEditor.h"

#include "EmbeddedWeb.h"
#include "WebResources.h"
#include "sl_engine.h"

namespace wizard::plugin {

namespace {

/** Serves the EMBEDDED bundle — never the source tree. A plugin runs on
    machines that have no copy of this repo (see EmbeddedWeb.h). */
std::optional<juce::WebBrowserComponent::Resource>
provideResource(const juce::String& path) {
    auto payload = EmbeddedWeb::shared().load(path);
    if (!payload.has_value()) return std::nullopt;
    const auto* bytes = static_cast<const std::byte*>(payload->data.getData());
    return juce::WebBrowserComponent::Resource{
        std::vector<std::byte>(bytes, bytes + payload->data.getSize()),
        payload->mimeType,
    };
}

/** The same navigation allowlist the app's PanelWindow carries: a stray drop
    must not navigate the UI away — and inside a DAW there is no window chrome
    to navigate back with. */
class GuardedWebView final : public juce::WebBrowserComponent {
public:
    explicit GuardedWebView(const Options& options) : juce::WebBrowserComponent(options) {}

    bool pageAboutToLoad(const juce::String& newURL) override {
        return wizard::webresources::navigationAllowed(
            newURL, juce::WebBrowserComponent::getResourceProviderRoot());
    }
};

} // namespace

ScoopyPluginEditor::ScoopyPluginEditor(ScoopyPluginProcessor& p)
    : juce::AudioProcessorEditor(&p), deck(p) {
    webView = std::make_unique<GuardedWebView>(
        juce::WebBrowserComponent::Options{}
            .withNativeIntegrationEnabled()
            .withResourceProvider(provideResource)
            // SCOOPY DECK's own face. Two earlier routes and why neither
            // survived, because both looked like a broken plugin in Logic:
            //
            //   `debug`    a diagnostics readout with no UI. It proved the
            //              bridge works inside a DAW (linked · schema v98 ·
            //              HotFrame, 2026-08-01) and showed nothing else.
            //   `compose`  the real composer — but it opens a session only
            //              when ADDRESSED, and a freshly inserted plugin has
            //              no address, so the grid sat on "waiting for pattern
            //              state…" forever.
            //
            // `plugindeck` ensures a session before rendering, which is what
            // an instrument dropped on a track has to do. See PluginDeckPanel.
            .withUserScript("window.__slPanel = \"plugindeck\";")
            .withNativeFunction(
                "slCommand",
                [this](const juce::Array<juce::var>& args,
                       juce::WebBrowserComponent::NativeFunctionCompletion complete) {
                    const auto method = args.size() > 0 ? args[0].toString() : juce::String();
                    const auto params = args.size() > 1 ? args[1] : juce::var();
                    complete(deck.dispatchFromUi(method, params));
                })
            .withEventListener("slParam", [this](juce::var v) { handleParam(v); }));

    addAndMakeVisible(webView.get());
    setResizable(true, true);
    setResizeLimits(720, 480, 3000, 2000);
    // RESTORE THE ARRANGED WINDOW (§5). The editor was resizable and the size
    // was never written down, so every reopen threw away the window the user had
    // set up — inside a DAW, where a plugin window is furniture. Zero means a
    // project saved before this, or one whose editor was never opened; that
    // falls back to the built-in default rather than collapsing to nothing.
    {
        const int w = deck.editorPerforming ? deck.performW : deck.editorW;
        const int h = deck.editorPerforming ? deck.performH : deck.editorH;
        setSize(w > 0 && h > 0 ? w : 1100, w > 0 && h > 0 ? h : 720);
    }
    // The processor drives the window when PERF flips; same lifetime contract as
    // `emitToEditor` (registered here, cleared in the destructor — never a raw
    // editor pointer held across a close).
    deck.resizeEditor = [this](int w, int h) { setSize(w, h); };

    // D3: ScoopyDeck claims its keys while the WebView holds OS focus. That is
    // only possible if this component will ACCEPT focus at all — without it,
    // `grabKeyboardFocus` below is a no-op and the DAW keeps first responder
    // forever, so every deck shortcut (Space included) is dead in-host no
    // matter how well the web tier handles it.
    setWantsKeyboardFocus(true);

    // A missing archive would otherwise be a BLANK EDITOR — the silent-failure
    // shape this project keeps paying for. Say it on screen instead.
    jassert(EmbeddedWeb::shared().isValid());
    if (!EmbeddedWeb::shared().isValid()) {
        webView->goToURL("about:blank");
        addAndMakeVisible(loadError);
        loadError.setText("Scoopy Deck: the embedded UI bundle is missing from this build.\n"
                          "Rebuild with `cmake --build build --target ScoopyDeck_All`.",
                          juce::dontSendNotification);
        loadError.setJustificationType(juce::Justification::centred);
        loadError.setColour(juce::Label::textColourId, juce::Colours::white);
        return;
    }
    webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

    // The processor's route to the page (DAW MIDI, and anything later that
    // originates off the editor). Cleared in the destructor — a callback that
    // outlived this object would be a use-after-free on the next MIDI note.
    deck.emitToEditor = [this](const juce::String& name, const juce::var& payload) {
        if (webView != nullptr) webView->emitEventIfBrowserIsVisible(name, payload);
    };

    startTimerHz(30); // the HotFrame broadcast, for as long as there are eyes
}

ScoopyPluginEditor::~ScoopyPluginEditor() {
    deck.emitToEditor = nullptr;
    deck.resizeEditor = nullptr;
    stopTimer();
}

void ScoopyPluginEditor::resized() {
    if (webView != nullptr) webView->setBounds(getLocalBounds());
    loadError.setBounds(getLocalBounds());
    // Record the arrangement as it happens, into whichever mode is showing —
    // this is the only moment the size is known, and the editor may be closed
    // by the host without any teardown we would otherwise see. Guarded on >0 so
    // a transient zero-size layout pass never writes a window nobody can reopen.
    if (getWidth() > 0 && getHeight() > 0) {
        if (deck.editorPerforming) {
            deck.performW = getWidth();
            deck.performH = getHeight();
        } else {
            deck.editorW = getWidth();
            deck.editorH = getHeight();
        }
    }
}

void ScoopyPluginEditor::reclaimKeyboard() {
    // The WEBVIEW is the thing that must end up holding it — keys the page
    // handles are delivered to whatever has first responder, and that is the
    // child, not this wrapper. Falling back to the editor itself keeps the
    // no-bundle case (webView pointed at about:blank) from silently doing
    // nothing at all.
    if (webView != nullptr && webView->isShowing())
        webView->grabKeyboardFocus();
    else if (isShowing())
        grabKeyboardFocus();
}

void ScoopyPluginEditor::mouseDown(const juce::MouseEvent&) {
    // "The user came back to us." A click on any DAW surface hands focus back to
    // the host, and nothing reclaimed it — so the deck answered keys until the
    // first time you touched the mixer and then never again.
    reclaimKeyboard();
}

void ScoopyPluginEditor::visibilityChanged() {
    // "The window just opened, or was revealed." A plugin window you have not
    // clicked in yet should still answer the deck's keys — requiring a click
    // first is the behaviour that reads as "the shortcuts don't work".
    if (isVisible()) reclaimKeyboard();
}

/** THE PARAM LANE. Same two-entry map as the app's PanelWindow, and short for
    the same reasons (see the omission list there): tempo intent is resolved by
    the TS tempo law into a per-deck ratio, and in THIS host the master half of
    that law is the DAW — which reaches the engine through HostSync's pump, not
    through here. `transpose` and `texture` are the two the ABI carries as
    realtime writes, so they are the two a fader can ride. */
void ScoopyPluginEditor::handleParam(const juce::var& v) {
    auto* obj = v.getDynamicObject();
    if (obj == nullptr) return;
    const auto name = obj->getProperty("p").toString();
    const auto deckIndex = (int) obj->getProperty("deck");
    const double value = (double) obj->getProperty("v");

    const char* engineName = nullptr;
    if (name == "deckTranspose") engineName = "transpose";
    else if (name == "deckBusTexture") engineName = "texture";

    if (engineName == nullptr) {
        if (!warnedParams.contains(name)) {
            warnedParams.add(name);
            DBG("slParam: '" << name << "' has no engine deck param in ScoopyDeck");
        }
        return;
    }
    auto* engine = deck.engineForTest();
    if (engine == nullptr) return;
    if (deckIndex < 0 || deckIndex >= (int) sl_deck_count()) return;
    const int32_t id = sl_param_id_for_name(engineName);
    if (id == SL_PARAM_UNKNOWN) return; // engine and shell disagree — refuse, never guess
    sl_param_set(engine, (uint32_t) deckIndex, id, value);
}

void ScoopyPluginEditor::timerCallback() {
    if (webView == nullptr) return;
    auto* engine = deck.engineForTest();

    const auto len = sl_hotframe_length();
    if (hotFrameBuf.size() < len) hotFrameBuf.resize(len, 0.0);
    const auto n = sl_hotframe(engine, hotFrameBuf.data(),
                               static_cast<uint32_t>(hotFrameBuf.size()));
    juce::Array<juce::var> frame;
    frame.ensureStorageAllocated(static_cast<int>(n));
    for (uint32_t i = 0; i < n; ++i) frame.add(hotFrameBuf[i]);
    webView->emitEventIfBrowserIsVisible("slHotFrame", juce::var(frame));

    // THE HOST TRANSPORT, pushed because nothing else can tell the UI.
    // There is no transport slot in the HotFrame — the web tier mirrors the
    // last transport it COMMANDED (nativeAudio.ts) — so in a plugin, where the
    // DAW can start and stop the deck behind the UI's back, that mirror would
    // silently lie. Change-detected rather than sent every tick.
    const auto t = deck.hostSync().snapshot();
    if (t.valid && (t.playing != lastTransport.playing ||
                    std::abs(t.bpm - lastTransport.bpm) > 1e-6)) {
        lastTransport = t;
        auto* payload = new juce::DynamicObject();
        payload->setProperty("type", "hostTransport");
        payload->setProperty("playing", t.playing);
        payload->setProperty("bpm", t.bpm);
        payload->setProperty("ppq", t.ppq);
        webView->emitEventIfBrowserIsVisible("slEvent", juce::var(payload));
    }

    if (++toolbarTick >= 15) {
        toolbarTick = 0;
        auto* payload = new juce::DynamicObject();
        payload->setProperty("topic", "toolbar");
        payload->setProperty("state",
                             wizard::sl::toolbarState(engine, &deck.pluginBackend().services));
        webView->emitEventIfBrowserIsVisible("slUiState", juce::var(payload));
    }
}

} // namespace wizard::plugin
