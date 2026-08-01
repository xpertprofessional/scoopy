// ScoopyDeck's editor: ONE WebBrowserComponent speaking the same five JuceLink
// lanes as a PanelWindow, minus the window layer.
//
// v0 hosts the `debug` panel (the App.tsx fallback: capabilities handshake +
// HotFrame proof) — enough to see the bridge alive inside a DAW. v1 replaces
// the route with `plugindeck` and lifts the shared assembly into a
// ScoopyWebView component both PanelWindow and this editor wrap.
//
// The HotFrame timer lives HERE, not on the processor: frames only matter
// with eyes on them, and the processor's own 40 Hz pump (tempo, transport)
// is the half that must survive a closed editor.
#pragma once

#include "ScoopyPluginProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

namespace wizard::plugin {

class ScoopyPluginEditor final : public juce::AudioProcessorEditor,
                                 private juce::Timer {
public:
    explicit ScoopyPluginEditor(ScoopyPluginProcessor& p);
    ~ScoopyPluginEditor() override;

    void resized() override;
    void paint(juce::Graphics&) override;

    /** THE CHROME STRIP along the bottom, and why the UI is not full-bleed.
     *
     *  JUCE puts its `ResizableCornerComponent` at (w-18, h-18, 18, 18) and
     *  calls `setAlwaysOnTop(true)` on it — which does nothing here. The corner
     *  is a LIGHTWEIGHT JUCE component; `WebBrowserComponent` on macOS is a real
     *  `WKWebView` NSView child, and a native subview always renders above
     *  CoreGraphics-drawn JUCE content whatever the internal z-order says. So
     *  the grip was painted underneath the page: invisible, and unhittable.
     *
     *  Reported from the real host as "window still not expandable"
     *  (2026-08-01). Trimming the webview by exactly the resizer's height gives
     *  the corner somewhere to live that the page cannot cover. */
    static constexpr int kChromeH = 18;

    /** THE EDITOR MUST TAKE OS KEYBOARD FOCUS, or none of the web tier's key
        handling is reachable inside a DAW (D-SL-DECKPLUGIN-02 · D3).
        `PluginDeckPanel`'s `claimKeyboard(PLUGIN_DECK)` sets only the
        WEB-INTERNAL claim — arbitration between mounted decks — and cannot
        grant first responder. Until the user happened to click inside the
        webview the DAW kept it, and any click back on a DAW surface took it
        away again with nothing reclaiming it.

        Both hooks are needed and they cover different moments: `mouseDown` is
        "the user came back to us", `visibilityChanged` is "the window just
        opened / was revealed" — a plugin window you have not clicked in yet
        should still answer the deck's keys. */
    void mouseDown(const juce::MouseEvent&) override;
    void visibilityChanged() override;

private:
    /** Take first responder if we can. Deliberately quiet on failure: a host
        that refuses focus (some plugin wrappers do) must not produce a log line
        per click, and the visible controls remain the reliable path — D3's
        stated cost is that the key claim is BEST-EFFORT. */
    void reclaimKeyboard();

    void timerCallback() override;
    void handleParam(const juce::var& v);

    // NOT `processor` — AudioProcessorEditor already has a member by that name.
    ScoopyPluginProcessor& deck;
    std::unique_ptr<juce::WebBrowserComponent> webView;
    juce::Label loadError; // shown ONLY when the embedded bundle is absent
    std::vector<double> hotFrameBuf;
    /** THE STRIP'S READOUT, painted NATIVELY (2026-08-01).
     *
     *  "Playhead is not working" is three different faults wearing one symptom:
     *  the deck's clock is not running, the frames are not reaching the page, or
     *  the page is not drawing them. From inside a DAW they are
     *  indistinguishable — there is no console, and the web tier cannot report
     *  on its own absence.
     *
     *  So the chrome strip says what the ENGINE says, straight from
     *  `sl_hotframe`, with no web tier in the path at all. A moving step here
     *  and a still grid is a web bug; a still step here is the clock. */
    int lastShownStep = -2; // -2 = never painted, so the first tick always does
    bool lastShownPlaying = false;
    int toolbarTick = 0; // 30 Hz ÷ 15 → the ~2 Hz toolbar push, same as the app
    HostSync::Snapshot lastTransport; // change-detected → hostTransport slEvent
    juce::StringArray warnedParams;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScoopyPluginEditor)
};

} // namespace wizard::plugin
