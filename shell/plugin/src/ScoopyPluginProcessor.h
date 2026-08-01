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

    /** How the processor reaches the page. The EDITOR owns the WebView and may
        not exist, so it registers this on construction and clears it on
        destruction — the processor never holds a raw editor pointer, which is
        the shape that outlives its target. Message thread only. */
    std::function<void(const juce::String&, const juce::var&)> emitToEditor;

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
