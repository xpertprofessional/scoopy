// The merged shell — scoopy's real UI, hosted in JUCE, on the SL ABI v3 engine.
//
// This is what the P1 spike proved and the native foundation built toward: the
// committed scoopy webdist in multi-window JUCE WebViews, speaking the JuceLink
// contract to a REAL v3 engine that renders through AudioIO. Everything behind
// the transport is unit-tested (SlDispatch, SlWorldApply, sl_hotframe,
// FileSettingsStore, SlRenderSink); THIS is the assembly.
//
// THE ONLY HOST (D-SL-ONEHOST-01). There is one shell, one webdist, one engine
// tier; anything that looks like a second one is a leftover, not a peer.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A HEADER AND NOT JUST `MergedMain.cpp` (H3)
//
// The assembly used to be the app's translation unit, which meant the ONLY way
// to run it was to launch the app by hand. That is why every phase in this repo
// ends on an `awaiting-user` gate: P6-AUDIT, P7-G1, P8-G1, P9-G1 all wait on a
// human to confirm things a machine could have checked — not the visual claims,
// which are genuinely the user's (kickoff law 5), but reachability. This host
// has shipped an `slParam` listener that was EMPTY and a `__slPanelArg` that
// was never injected, both green, because no gate could see the JuceLink side
// at all: a Chromium walk has no `window.__JUCE__`.
//
// So the assembly becomes a library with two entry points:
//
//   shell/src/MergedMain.cpp    the app     — argv intercept + JUCE_MAIN_FUNCTION
//   shell/tools/merged_walk.cpp the gate    — the same app, driven by a script
//
// ONE source of truth for the host, two ways in. A walk that exercised a COPY
// of this file would prove nothing about the app that ships, which is the whole
// failure this arrangement exists to avoid.
#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include "AudioIO.h"
#include "RecordService.h"
#include "MidiClockOut.h"
#include "MidiHost.h"
#include "SlDispatch.h"
#include "SlRenderSink.h"
#include "SlSettingsStore.h"
#include "SlTakeDrainSource.h"

#include <functional>
#include <memory>
#include <vector>

#if SCOOPY_PLUGIN_HOST
 #include "NativePluginHost.hpp"
#endif

struct sl_engine;

namespace wizard::merged {

/** Must equal `web/protocol/schema.ts` SCHEMA_VERSION.
    Carried into `sl_engine_create` for the HotFrame slot-0 echo (sl_engine.h §1).
    ⚠️ Was **88** against a schema.ts of 96 — eight versions stale, because its
    only consumer is an echo nobody compared. Gated now: `npm run schema:check`. */
inline constexpr int kScoopySchemaVersion = 103;

/** The engine + device + settings the whole app shares. One engine, one device;
    every window is another view onto it. */
struct Backend {
    sl_engine* engine;
    wizard::host::SlRenderSink sink;
    wizard::host::AudioIO audioIO;
    /** S9: enumeration + role selection. See SlDispatch's MIDI block. */
    wizard::host::MidiHost midi;
    wizard::host::MidiClockOut midiClock;
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
    // take-writing implementation serves every engine, so a take is a take —
    // same crash-safe writer, same sidecar, same Law C-2 stamp handling.
    wizard::record::SlTakeDrainSource drainSource;
    wizard::record::Service recorder;
    wizard::sl::HostServices services;
#if SCOOPY_PLUGIN_HOST
    // The AU/VST3 scanner (P6-2). Constructed eagerly — its ctor only restores
    // the persisted scan cache; the expensive sweep runs on `rescanPlugins`.
    scoopyloops::NativePluginScanner pluginScanner;
#endif

    explicit Backend(sl_engine* e);
    ~Backend();
};

/** One panel window: a DocumentWindow whose content is a scoopy panel. Multiple
    of these is the spike's resolved multi-window model — each an independent
    React root with its own JuceLink, all onto the one Backend. */
class PanelWindow final : public juce::DocumentWindow {
public:
    using OpenPanel = std::function<void(const juce::String&, const juce::String&)>;
    using CloseSelf = std::function<void(PanelWindow*)>;
    /** Fired once this window's page has finished loading (H3). The app leaves
        it null; `merged_walk` uses it to start driving. */
    using PageLoaded = std::function<void(PanelWindow&)>;

    PanelWindow(Backend& backendToUse, juce::String panel, juce::String panelArgToUse,
                bool isMainToUse, OpenPanel openPanel, CloseSelf closeSelf,
                PageLoaded pageLoaded = nullptr);
    ~PanelWindow() override;

    void closeButtonPressed() override;

    /** Push one HotFrame to this window's UI (message thread; touches the view). */
    void emitHotFrame(const juce::Array<juce::var>& frame);

    /** P3-C1: broadcast lane for window-lifecycle events (`slPanelClosed`).
        The emitHotFrame loop's twin — there is no other cross-window channel;
        the compose ownership handoff rides events + disk, never shared memory. */
    void emitEvent(const juce::String& name, const juce::var& payload);

    /** Run a script IN THIS WINDOW'S PAGE and hand back what it evaluated to
        (H3, for merged_walk). Message thread only. This is deliberately the
        REAL WebView's evaluator and not a test seam: a walk that asserted
        against a stub would be measuring the stub. */
    void evaluate(const juce::String& script,
                  juce::WebBrowserComponent::EvaluationCallback callback);

    const juce::String& panel() const { return panelName; }
    const juce::String& arg() const { return panelArg; }

private:
    juce::var handleCommand(const juce::Array<juce::var>& args);
    void handleParam(const juce::var& v);

    Backend& backend;
    juce::String panelName;
    bool isMain;
    OpenPanel openPanelFn;
    juce::String panelArg;
    CloseSelf closeSelfFn;
    PageLoaded pageLoadedFn;
    juce::StringArray warnedParams;
    std::unique_ptr<juce::WebBrowserComponent> webView;
};

/** The application object: owns the engine, the Backend and every window, and
    runs the 30 Hz HotFrame broadcast. `merged_walk` constructs one of these
    directly rather than through START_JUCE_APPLICATION. */
class MergedApplication : public juce::JUCEApplication,
                          private juce::Timer {
public:
    const juce::String getApplicationName() override { return "Scoopy Studio"; }
    const juce::String getApplicationVersion() override { return "0.0.1"; }

    void initialise(const juce::String&) override;
    void shutdown() override;

protected:
    /** Called once the FIRST window's page has loaded. The app does nothing;
        merged_walk overrides it to start its script. Hooking the page rather
        than `initialise` matters: at initialise the WebView exists but has not
        run a line of the bundle, so every assertion would race the boot. */
    virtual void firstPageLoaded(PanelWindow&) {}

    /**
     * Which face to open at boot, or `{}` to ASK (D-SL-CHOOSER-01).
     *
     * ⚠️ THE WALK MUST NOT BE ASKED. `merged_walk` inherits `initialise()`, and
     * a chooser it never clicks is a gate that hangs rather than fails — the
     * worst shape a test can have. It overrides this to name "plane" outright,
     * which is also honest about what that walk covers: the plane's boot path,
     * not the chooser's.
     */
    virtual juce::String launchFaceOverride() const { return {}; }

    void openPanel(const juce::String& panel, const juce::String& arg, bool isMain = false);

    sl_engine* engine = nullptr;
    std::unique_ptr<Backend> backend;
    std::vector<std::unique_ptr<PanelWindow>> windows;

private:
    void removeWindow(PanelWindow* w);
    void timerCallback() override;

    std::vector<double> hotFrameBuf;
    int toolbarTick = 0; // 30 Hz timer ÷ 15 → the ~2 Hz toolbar push (P6-2)
    bool sawFirstPage = false;
};

} // namespace wizard::merged
