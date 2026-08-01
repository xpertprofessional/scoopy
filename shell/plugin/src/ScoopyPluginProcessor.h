// ScoopyDeck's AudioProcessor — the third entry point onto the shell libraries
// (D-SL-DECKPLUGIN-01): the DAW's callback drives the same sl_render_io the
// app's AudioIO drives, through the same dispatcher the app's windows speak.
//
// Thread law, restated because a plugin makes it easy to break:
//   processBlock        render + playhead capture ONLY. Never sl_param_set,
//                       never a snapshot, never sl_tape_load (they allocate /
//                       republish — sl_engine.h §3, §5).
//   message thread      everything else: dispatchFromUi (the editor's
//                       slCommand), the 40 Hz HostSync pump, state save/load.
#pragma once

#include "HostSync.h"
#include "LaneMap.h"
#include "PluginBackend.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <functional>
#include <memory>

struct sl_engine;

namespace wizard::plugin {

class ScoopyPluginProcessor final : public juce::AudioProcessor,
                                    private juce::Timer {
public:
    ScoopyPluginProcessor();
    ~ScoopyPluginProcessor() override;

    // ── AudioProcessor ──────────────────────────────────────────────────────
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Scoopy Deck"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; } // inert until v2 — declared in v0 so the ID never changes
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // ── The editor's doors (message thread) ─────────────────────────────────
    /** The slCommand adapter: intercepts what the plugin host must own
        (world caching for transport follow, hostSyncConfig), forwards the rest
        to wizard::sl::dispatch. */
    juce::var dispatchFromUi(const juce::String& method, const juce::var& params);

    PluginBackend& pluginBackend() { return *backend; }
    sl_engine* engineForTest() const { return engine; }
    HostSync& hostSync() { return sync; }

    /** The pump body, public so the headless ctest can tick it without a
        running message loop. The 40 Hz timer calls exactly this. */
    void pumpHostSync();

    /** ARM A LAUNCH ON THE HOST'S GRID (D-SL-DECKPLUGIN-03, step 2).
     *
     *  `quantumBeats` is the musical grid to land on — 4 for a bar of 4/4, 16
     *  for four bars, 1 for a beat. The deck is held and released on the next
     *  multiple of that on the DAW's timeline.
     *
     *  THIS IS WHAT LINES UP ACROSS INSTANCES, and it needs nothing shared:
     *  every instance resolves the same host `ppqPosition` to the same musical
     *  boundary, converts it through its OWN clock, and releases there.
     *
     *  MESSAGE THREAD, and it can be — which is the part worth not
     *  rediscovering. `capture()` stores ppq and the engine frame as one
     *  anchored pair, so a boundary computed from a snapshot taken up to a pump
     *  tick ago is still EXACT: the staleness is in the anchor, not in the
     *  arithmetic. That is why nothing here has to run on the audio thread,
     *  and why the arm may safely republish the world (which allocates).
     *
     *  Returns the absolute engine frame armed, or 0 if it could not arm — no
     *  playhead, a stopped host, or a nonsense quantum. A caller that gets 0
     *  should launch immediately rather than leave the deck held. */
    uint64_t armHostQuantizedLaunch(double quantumBeats);

    /** How the processor reaches the page. The EDITOR owns the WebView and may
        not exist, so it registers this on construction and clears it on
        destruction — the processor never holds a raw editor pointer, which is
        the shape that outlives its target. Message thread only. */
    std::function<void(const juce::String&, const juce::var&)> emitToEditor;

    /** Ask the editor to resize itself. Same lifetime contract as
        `emitToEditor` — registered on editor construction, cleared on
        destruction, never a raw editor pointer. Null when no window is open,
        which is the normal state of a plugin the DAW is merely playing. */
    std::function<void(int, int)> resizeEditor;

    /** THE EDITOR'S SIZE, PERSISTED (DECKPLUGIN v2 §5).
     *
     *  The editor has always been resizable and the size was never written
     *  down, so every reopen threw away the window the user had arranged —
     *  inside a DAW, where the plugin window is furniture you set up once.
     *
     *  ⚠️ ONE size. There were briefly TWO, swapped on the PERF edge — which
     *  meant arming a locator drag RESIZED YOUR WINDOW. Same overreach the user
     *  rejected on 2026-08-01 ("the PERF button was abused for view changes we
     *  did not request"): PERF is a pointer mode and must not move furniture.
     *
     *  Zero = "never set", which restores the built-in default rather than
     *  collapsing the window to nothing — the shape a chunk written before this
     *  restores as. */
    int editorW = 0, editorH = 0;

    /** WHICH SESSION THIS INSTANCE HOLDS (real-host report, 2026-08-01).
     *
     *  The chunk carried the world, the samples and the sync recipe — but never
     *  the document's IDENTITY. So a reloaded DAW project replayed the right
     *  audio while the editor had no idea what it was, called `newSession()`,
     *  and showed an empty Untitled grid over a correctly-playing engine. The
     *  same call is what filled the shared library with `Untitled N` folders,
     *  one per insert, because `createSession` ends in `saveSession`.
     *
     *  Identity belongs HERE rather than in a global "most recent" pointer, and
     *  that is the whole reason it works with several instances open: each deck
     *  remembers its own, and nothing races to be the newest. */
    juce::String sessionName;

    /** THE LAUNCH QUANTUM, per instance (D-SL-DECKPLUGIN-03, step 3).
     *
     *  The web's own vocabulary — "off" · "1" · "2" · "4" · "8" · "16" ·
     *  "cycle" — carried opaquely. The scale, and the fact that the numbers are
     *  STEPS (16ths, so "16" is a bar of 4/4), belong to `audio/launchQuantum.ts`
     *  where they were ported from the donor; duplicating that reading here
     *  would be a second place for it to drift.
     *
     *  PER INSTANCE and in the chunk, by user ruling: two decks in one set can
     *  run different quantums — one on cycle, one on a bar — which is a real
     *  performance setup a shared preference could not express.
     *
     *  Defaults to "cycle", which is the donor's own default
     *  (`DJModeManager.globalLaunchQuantize`). */
    juce::String launchQuantum { "cycle" };


    /** The startStep the last host-driven launch actually published. Exists
        for the phase-alignment gate: reading it back beats inferring the
        alignment from a rendered transient, which would also be measuring the
        pump's granularity and the stretch group delay. */
    int lastStartStepForTest() const { return lastStartStep; }

private:
    static BusesProperties makeBuses(); // BusesProperties is protected — must be named in-class
    void timerCallback() override { pumpHostSync(); }
    void applyCachedWorld(bool playing);
    /** Which step the deck should come in on for the host's current bar
        position — phase sync, the other half of following a tempo. */
    int hostAlignedStartStep() const;
    int lastStartStep = 0; // what the last host-driven launch published
    /** Re-report PDC if (and only if) the tempo MODE changed — see the .cpp. */
    void updateLatency();
    int reportedMode = -1; // the tempoMode setLatencySamples currently reflects

    sl_engine* engine = nullptr;
    std::unique_ptr<PluginBackend> backend;
    HostSync sync;
    LaneMap laneMap;

    // Input is copied per chunk before rendering: with in-place plugin
    // buffers the record-in channels ALIAS main-out, and the engine writes
    // main while reading input.
    std::vector<float> inScratch;

    // The last published world (message thread only) — transport follow
    // re-applies it with isPlaying flipped, because deck transport is
    // snapshot state, not a param.
    juce::var lastWorld;

    // ── THE REPLAY JOURNAL ──────────────────────────────────────────────────
    //
    // A DAW project must reopen and make sound WITHOUT the editor ever being
    // opened — the web tier is where the document normally lives, and it is
    // not running until someone clicks the plugin. So the processor keeps
    // everything the engine would need to rebuild itself, and getState writes
    // it into the host's project file.
    //
    // Samples ride ALONG (the user's call: self-contained projects) as raw
    // float32 rather than JSON numbers — a JSON array of floats is ~10 bytes
    // per sample of text for 4 bytes of audio, which turns a modest kit into
    // a project file nobody can open.
    struct CachedSample {
        juce::String id;
        std::vector<float> left;
        std::vector<float> right; // empty = mono (the engine duplicates)
        double rate = 48000.0;
    };
    std::vector<CachedSample> samples;

    void captureSample(const juce::var& params);
    void replayJournal();

    // ── DAW MIDI IN ─────────────────────────────────────────────────────────
    //
    // The audio thread cannot allocate, cannot take a lock and cannot touch a
    // WebView, so it may not deliver MIDI anywhere directly. It writes packed
    // events into a fixed ring; the 40 Hz pump drains them and emits them on
    // the slEvent lane.
    //
    // ⚠️ THE ENGINE HAS NO MIDI SURFACE AT ALL — no note door, no live-trigger
    // door (sl_engine.h). So these events reach the WEB tier or nothing, which
    // means MIDI does nothing while the editor is closed. That is a real limit,
    // stated rather than hidden; closing it needs an engine feature, not more
    // wiring here.
    struct MidiEvent {
        uint8_t status, data1, data2;
    };
    // A textbook SPSC ring: ONE producer (the audio thread) owns `midiWrite`,
    // ONE consumer (the pump) owns `midiRead`, and each reads the other's index
    // atomically. Both must be atomic — the producer needs the read index to
    // know if it is full, and a plain int shared across those two threads is a
    // data race however benign it looks.
    static constexpr int kMidiRingSize = 256; // ~6 blocks of dense CC at 40 Hz
    std::array<MidiEvent, kMidiRingSize> midiRing{};
    std::atomic<uint32_t> midiWrite{0};
    std::atomic<uint32_t> midiRead{0};
    /** Drain the ring onto the slEvent lane. Message thread. */
    void drainMidi();

    // The render-detach guard (Dekker pair with renderActive in processBlock).
    // withRenderDetached() is FOR the dispatch verbs that reallocate
    // render-visible storage (sl_tape_load/insert, sl_engine.h §5) — none of
    // which the merged dispatcher exposes yet, so it has no caller in v0; it
    // exists so the first verb that needs it has a correct seam to use instead
    // of a race. processBlock renders silence while muted.
    void withRenderDetached(const std::function<void()>& fn);
    std::atomic<bool> renderMuted{false};
    std::atomic<bool> renderActive{false};

    /** Guards the document state (`lastWorld`, `samples`, the recipe) and the
        applyWorld path against the host restoring a project on its own thread
        while the 40 Hz pump is republishing. NEVER taken on the audio thread —
        processBlock touches none of this. */
    juce::CriticalSection stateLock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScoopyPluginProcessor)
};

} // namespace wizard::plugin
