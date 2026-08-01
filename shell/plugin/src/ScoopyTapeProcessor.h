// ScoopyTape's AudioProcessor — the looper strip as a DAW INSERT EFFECT.
//
// The fourth entry point onto the shell libraries, and the first that is not a
// source: WizardMerged (the app), MergedWalk (the scripted app), ScoopyDeck
// (the instrument) and this. It shares the whole plugin spine — EmbeddedWeb,
// HostSync, PluginBackend — and differs from ScoopyDeck in exactly the ways an
// effect differs from an instrument. See docs/merge/TAPEPLUGIN-KICKOFF.md.
//
//   ScoopyDeck                         ScoopyTape
//   IS_SYNTH TRUE                      IS_SYNTH FALSE (A1)
//   1 optional in, 5 out (Main+S1-4)   1 main in, 1 main out — an insert
//   26 engine lanes through LaneMap    bus_count = 2, main L/R, no LaneMap
//   HostSync::pump writes deck params  capture/snapshot only — see below
//
// Thread law, unchanged and restated because a plugin makes it easy to break:
//   processBlock        render + playhead capture ONLY. Never sl_param_set,
//                       never a snapshot, never sl_tape_load (they allocate /
//                       republish — sl_engine.h §3, §5).
//   message thread      everything else: dispatchFromUi (the editor's
//                       slCommand), the 40 Hz timer, state save/load.
#pragma once

#include "HostSync.h"
#include "PluginBackend.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <functional>
#include <memory>
#include <vector>

struct sl_engine;

namespace wizard::plugin {

class ScoopyTapeProcessor final : public juce::AudioProcessor,
                                  private juce::Timer {
public:
    ScoopyTapeProcessor();
    ~ScoopyTapeProcessor() override;

    // ── AudioProcessor ──────────────────────────────────────────────────────
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Scoopy Tape"; }
    /** DECLARED IN §1 THOUGH NOTHING READS IT YET, and that is the same
        forward-compat move ScoopyDeck made with MIDI out: adding a port later
        changes the plugin's ID in some hosts and silently breaks every saved
        project that used it. Mapping notes/CC to record, overdub, retrigger and
        snapshot select is a named later quality in the kickoff, so the port has
        to exist from the first build that ships. */
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // ── The editor's doors (message thread) ─────────────────────────────────
    /** The slCommand adapter. §1 forwards everything to wizard::sl::dispatch;
        the interception layer ScoopyDeck grew (world caching, hostSyncConfig)
        arrives with the verbs that need it in §2/§3. */
    juce::var dispatchFromUi(const juce::String& method, const juce::var& params);

    PluginBackend& pluginBackend() { return *backend; }
    sl_engine* engineForTest() const { return engine; }
    HostSync& hostSync() { return sync; }

    /** How the processor reaches the page. The EDITOR owns the WebView and may
        not exist, so it registers this on construction and clears it on
        destruction — the processor never holds a raw editor pointer, which is
        the shape that outlives its target. Message thread only. */
    std::function<void(const juce::String&, const juce::var&)> emitToEditor;

    int editorW = 0, editorH = 0;

private:
    static BusesProperties makeBuses(); // BusesProperties is protected

    /** WHY THERE IS NO HostSync::pump HERE.
     *
     *  `pump` resolves a tempo ratio and writes it to DECK 0 through
     *  sl_param_set(syncRatio/tempoMode). A tape has no deck and no steps: its
     *  tempo relation is a signed RATE (sl_tape_set_rate) resolved by
     *  tapeEffectiveRate in the web tier, and pumping deck params from here
     *  would write to a deck this product does not present — silently, at
     *  40 Hz, with no visible effect until something else read it back.
     *
     *  So §1 uses the RT half only: capture() feeds the playhead into atomics
     *  and this timer emits the `hostTransport` slEvent from snapshot(). The
     *  write half arrives in §2, where quantized capture-length is the first
     *  thing that genuinely needs the host's grid, and it will write tape rate
     *  rather than deck params. */
    void timerCallback() override;
    HostSync::Snapshot lastTransport{};

    sl_engine* engine = nullptr;
    std::unique_ptr<PluginBackend> backend;
    HostSync sync;

    // Input is copied per chunk before rendering: an insert effect's buffer is
    // in-place, so the input channels ALIAS the output the engine is writing.
    std::vector<float> inScratch;
    // Where the engine's main L/R land before they are summed onto the dry.
    std::vector<float> outScratch;

    /** The render-detach guard (Dekker pair with renderActive in processBlock).
        FOR the dispatch verbs that reallocate render-visible storage —
        sl_tape_load / sl_tape_insert (sl_engine.h §5). ScoopyDeck carries the
        same seam and has never had a caller; this product's snapshot flip (§3)
        is the first verb that genuinely needs it, which is why it is here from
        the start rather than bolted on beside a race. */
    void withRenderDetached(const std::function<void()>& fn);
    std::atomic<bool> renderMuted{false};
    std::atomic<bool> renderActive{false};

    /** Guards document state against the host restoring a project on its own
        thread while the timer or a dispatch is touching it. NEVER taken on the
        audio thread — processBlock touches none of it. */
    juce::CriticalSection stateLock;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScoopyTapeProcessor)
};

} // namespace wizard::plugin
