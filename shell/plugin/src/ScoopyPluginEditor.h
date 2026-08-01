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

private:
    void timerCallback() override;
    void handleParam(const juce::var& v);

    // NOT `processor` — AudioProcessorEditor already has a member by that name.
    ScoopyPluginProcessor& deck;
    std::unique_ptr<juce::WebBrowserComponent> webView;
    juce::Label loadError; // shown ONLY when the embedded bundle is absent
    std::vector<double> hotFrameBuf;
    int toolbarTick = 0; // 30 Hz ÷ 15 → the ~2 Hz toolbar push, same as the app
    HostSync::Snapshot lastTransport; // change-detected → hostTransport slEvent
    juce::StringArray warnedParams;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScoopyPluginEditor)
};

} // namespace wizard::plugin
