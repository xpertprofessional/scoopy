#include "ScoopyTapeEditor.h"

#include "EmbeddedWeb.h"
#include "SlDispatch.h"
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

/** The same navigation allowlist the app's PanelWindow and the deck carry: a
    stray drop must not navigate the UI away — and inside a DAW there is no
    window chrome to navigate back with. */
class GuardedWebView final : public juce::WebBrowserComponent {
public:
    explicit GuardedWebView(const Options& options) : juce::WebBrowserComponent(options) {}

    bool pageAboutToLoad(const juce::String& newURL) override {
        return wizard::webresources::navigationAllowed(
            newURL, juce::WebBrowserComponent::getResourceProviderRoot());
    }
};

} // namespace

ScoopyTapeEditor::ScoopyTapeEditor(ScoopyTapeProcessor& p)
    : juce::AudioProcessorEditor(&p), tape(p) {
    webView = std::make_unique<GuardedWebView>(
        juce::WebBrowserComponent::Options{}
            .withNativeIntegrationEnabled()
            .withResourceProvider(provideResource)
            // SCOOPY TAPE's own face. The deck learned the hard way that a
            // route which opens a document only when ADDRESSED leaves a freshly
            // inserted plugin waiting forever, because a new instance has no
            // address. `plugintape` ensures its strip before rendering, the
            // sink-first ordering — see PluginTapePanel.tsx.
            .withUserScript("window.__slPanel = \"plugintape\";")
            .withNativeFunction(
                "slCommand",
                [this](const juce::Array<juce::var>& args,
                       juce::WebBrowserComponent::NativeFunctionCompletion complete) {
                    const auto method = args.size() > 0 ? args[0].toString() : juce::String();
                    const auto params = args.size() > 1 ? args[1] : juce::var();
                    complete(tape.dispatchFromUi(method, params));
                }));
    // ⚠️ NO `slParam` LANE IN §1, and that is rule 7 rather than an oversight:
    // the realtime param lane exists to carry a fader, and this product's
    // faders are A7's host-automatable parameters, whose IDs are not signed
    // yet. Wiring a lane now would mean either inventing names §8 has to keep
    // or shipping a door that reaches nothing.

    addAndMakeVisible(webView.get());
    setResizable(true, true);
    setResizeLimits(640, 360, 3000, 2000);
    {
        const bool remembered = tape.editorW > 0 && tape.editorH > 0;
        // Wider than tall by default: the display is the whole point (A5), and
        // a waveform wants horizontal ground more than it wants height.
        setSize(remembered ? tape.editorW : 900, remembered ? tape.editorH : 420);
    }

    // Without this `grabKeyboardFocus` is a no-op and the DAW keeps first
    // responder forever — every key the page handles is dead in-host.
    setWantsKeyboardFocus(true);

    // A missing archive would otherwise be a BLANK EDITOR — the silent-failure
    // shape this project keeps paying for. Say it on screen instead.
    jassert(EmbeddedWeb::shared().isValid());
    if (!EmbeddedWeb::shared().isValid()) {
        webView->goToURL("about:blank");
        addAndMakeVisible(loadError);
        loadError.setText("Scoopy Tape: the embedded UI bundle is missing from this build.\n"
                          "Rebuild with `cmake --build build --target ScoopyTape_All`.",
                          juce::dontSendNotification);
        loadError.setJustificationType(juce::Justification::centred);
        loadError.setColour(juce::Label::textColourId, juce::Colours::white);
        return;
    }
    webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

    // The processor's route to the page (the hostTransport broadcast, and
    // anything later that originates off the editor). Cleared in the destructor
    // — a callback that outlived this object would be a use-after-free.
    tape.emitToEditor = [this](const juce::String& name, const juce::var& payload) {
        if (webView != nullptr) webView->emitEventIfBrowserIsVisible(name, payload);
    };

    startTimerHz(30); // the HotFrame broadcast, for as long as there are eyes
}

ScoopyTapeEditor::~ScoopyTapeEditor() {
    tape.emitToEditor = nullptr;
    stopTimer();
}

void ScoopyTapeEditor::paint(juce::Graphics& g) {
    // The strip the webview is trimmed off. Painted rather than left blank so a
    // deliberate piece of chrome does not read as the page failing to fill the
    // window.
    g.fillAll(juce::Colour(0xff121212));
    const auto strip = getLocalBounds().removeFromBottom(kChromeH).reduced(6, 0);
    g.setColour(juce::Colour(0xff6a6a6a));
    g.setFont(juce::FontOptions(11.0f));
    g.drawText(juce::String(getWidth()) + " x " + juce::String(getHeight()) +
                   "  -  drag the corner to resize",
               strip.withTrimmedRight(kChromeH), juce::Justification::centredLeft, true);
}

void ScoopyTapeEditor::resized() {
    // TRIMMED, not full-bleed — see kChromeH.
    if (webView != nullptr) webView->setBounds(getLocalBounds().withTrimmedBottom(kChromeH));
    loadError.setBounds(getLocalBounds());
    // Guarded on >0 so a transient zero-size layout pass never writes a window
    // nobody can reopen.
    if (getWidth() > 0 && getHeight() > 0) {
        tape.editorW = getWidth();
        tape.editorH = getHeight();
    }
}

void ScoopyTapeEditor::reclaimKeyboard() {
    // The WEBVIEW is the thing that must end up holding it — keys the page
    // handles go to whatever has first responder, and that is the child.
    if (webView != nullptr && webView->isShowing())
        webView->grabKeyboardFocus();
    else if (isShowing())
        grabKeyboardFocus();
}

void ScoopyTapeEditor::mouseDown(const juce::MouseEvent&) { reclaimKeyboard(); }

void ScoopyTapeEditor::visibilityChanged() {
    if (isVisible()) reclaimKeyboard();
}

void ScoopyTapeEditor::timerCallback() {
    if (webView == nullptr) return;
    auto* engine = tape.engineForTest();

    const auto len = sl_hotframe_length();
    if (hotFrameBuf.size() < len) hotFrameBuf.resize(len, 0.0);
    const auto n = sl_hotframe(engine, hotFrameBuf.data(),
                               static_cast<uint32_t>(hotFrameBuf.size()));
    juce::Array<juce::var> frame;
    frame.ensureStorageAllocated(static_cast<int>(n));
    for (uint32_t i = 0; i < n; ++i) frame.add(hotFrameBuf[i]);
    webView->emitEventIfBrowserIsVisible("slHotFrame", juce::var(frame));

    // ⚠️ `hostTransport` is NOT pushed from here, unlike the deck. It lives on
    // the PROCESSOR's 40 Hz timer, because §2's capture-length quantize needs
    // the host's grid whether or not a window is open. Two emitters would race
    // to describe the same transport at two rates.

    if (++toolbarTick >= 15) {
        toolbarTick = 0;
        auto* payload = new juce::DynamicObject();
        payload->setProperty("topic", "toolbar");
        payload->setProperty("state",
                             wizard::sl::toolbarState(engine, &tape.pluginBackend().services));
        webView->emitEventIfBrowserIsVisible("slUiState", juce::var(payload));
    }
}

} // namespace wizard::plugin
