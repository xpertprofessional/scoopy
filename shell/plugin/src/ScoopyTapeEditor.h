// ScoopyTape's editor: ONE WebBrowserComponent speaking the same JuceLink lanes
// as a PanelWindow, minus the window layer — the same shape ScoopyPluginEditor
// has, pointed at the `plugintape` face.
//
// Deliberately a SIBLING of ScoopyPluginEditor rather than a base class it also
// derives from. The two share ~40 lines of WebView assembly and differ in every
// line that matters (route, param lane, chrome, what the timer pushes), and a
// shared base would have to be parameterised on all of them. The pieces that
// are genuinely common — the resource provider and the navigation guard — are
// already shared through EmbeddedWeb and wizard::webresources, which is the
// level where sharing costs nothing.
#pragma once

#include "ScoopyTapeProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

namespace wizard::plugin {

class ScoopyTapeEditor final : public juce::AudioProcessorEditor,
                               private juce::Timer {
public:
    explicit ScoopyTapeEditor(ScoopyTapeProcessor& p);
    ~ScoopyTapeEditor() override;

    void resized() override;
    void paint(juce::Graphics&) override;

    /** THE CHROME STRIP along the bottom, inherited wholesale from the deck's
        hard-won finding: JUCE puts its ResizableCornerComponent at
        (w-18, h-18, 18, 18), but WebBrowserComponent on macOS is a real
        WKWebView NSView child and a native subview always renders above
        CoreGraphics-drawn JUCE content whatever the z-order says. Full-bleed
        means the grip is invisible AND unhittable — reported from the real host
        as "window still not expandable". Trimming by exactly the resizer's
        height gives the corner somewhere the page cannot cover. */
    static constexpr int kChromeH = 18;

    /** THE EDITOR MUST TAKE OS KEYBOARD FOCUS or none of the web tier's key
        handling is reachable inside a DAW — the D-SL-DECKPLUGIN-02 · D3 finding,
        which is about WebViews in plugin windows and not about decks, so it
        applies here unchanged. Both hooks are needed: `mouseDown` is "the user
        came back to us", `visibilityChanged` is "the window just opened". */
    void mouseDown(const juce::MouseEvent&) override;
    void visibilityChanged() override;

private:
    /** Take first responder if we can. Deliberately quiet on failure: a host
        that refuses focus must not produce a log line per click. */
    void reclaimKeyboard();

    void timerCallback() override;

    // NOT `processor` — AudioProcessorEditor already has a member by that name.
    ScoopyTapeProcessor& tape;
    std::unique_ptr<juce::WebBrowserComponent> webView;
    juce::Label loadError; // shown ONLY when the embedded bundle is absent
    std::vector<double> hotFrameBuf;
    int toolbarTick = 0; // 30 Hz ÷ 15 → the ~2 Hz toolbar push, same as the app

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScoopyTapeEditor)
};

} // namespace wizard::plugin
