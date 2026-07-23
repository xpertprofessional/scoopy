// Wizard shell: window chrome + a WebView serving the committed web bundle via
// JUCE's resource provider (no web server). This P0-06 increment proves boot +
// serve + engine linkage; the SLP transport (wzCommand / wzParam / wzHotFrame)
// lands in P0-07 and the duplex audio device in P0-11.
//
// Shell law (docs/ARCHITECTURE.md §1): a shell may contain ONLY EngineLink
// transport, window/menu chrome, file dialogs, lifecycle/permissions. Anything
// else here is a bug.
#include <juce_gui_extra/juce_gui_extra.h>

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

class MainWindow final : public juce::DocumentWindow {
public:
    explicit MainWindow(wz_engine* engineToUse)
        : juce::DocumentWindow("Wizard",
                               juce::Colours::black,
                               juce::DocumentWindow::allButtons),
          engine(engineToUse) {
        webView = std::make_unique<juce::WebBrowserComponent>(
            juce::WebBrowserComponent::Options{}
                .withNativeIntegrationEnabled()
                .withResourceProvider(provideResource));

        setUsingNativeTitleBar(true);
        setContentNonOwned(webView.get(), false);
        setResizable(true, false);
        centreWithSize(1280, 800);
        setVisible(true);

        webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
        // The engine is wired into the WebView's command/param/hotframe paths in
        // P0-07; held here so that increment is a pure addition.
        juce::ignoreUnused(engine);
    }

    void closeButtonPressed() override {
        juce::JUCEApplication::getInstance()->systemRequestedQuit();
    }

private:
    wz_engine* engine;
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
