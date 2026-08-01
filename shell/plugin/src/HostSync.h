// The genuinely new component of ScoopyDeck: the DAW's playhead becomes the
// deck's master tempo source (D-SL-DECKPLUGIN-01).
//
// Two halves, two threads, one rule:
//
//   RT half      capture() at the top of every processBlock — reads the host
//                playhead into relaxed atomics and nothing else. It never
//                touches a param: `sl_param_set(syncRatio/tempoMode)`
//                REPUBLISHES THE WORLD (deep copy, allocates — sl_engine.h §3),
//                which is exactly what an audio thread must never do.
//   message half pump() at ~40 Hz from a juce::Timer on the PROCESSOR (tempo
//                follow must survive a closed editor). It computes
//                ratio = hostBpm · pulseMultiplier / sessionBpm and writes it
//                through the same deck-param seam the plane's slDeck path uses,
//                epsilon-gated — the shipping app follows tempo at control
//                rate too (DJModeView's 25 ms debounce), and the ABI dedups
//                identical values, so a parked host costs nothing.
//
// THE TEMPO LAW IS NOT HERE. djSyncLaw (djMix.ts, golden-pinned) stays the
// authority; the web pushes its resolved recipe (sessionBpm / tempoMode /
// pulseMultiplier) through `hostSyncConfig`, and this pump performs only the
// one multiplication that must keep running with no editor open. An engine
// that took a master bpm would be a second tempo authority — the exact thing
// the shell's kParamMap refuses.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <cstdint>

struct sl_engine;

namespace wizard::plugin {

/** What the web tier resolved for us. sessionBpm == 0 means "no session yet" —
    the pump then writes nothing rather than inventing a ratio. */
struct HostSyncRecipe {
    double sessionBpm = 0.0;
    int tempoMode = 1; // 0 timePitch · 1 timeStretch · 2 tempoOnly (sl_engine.h §3)
    double pulseMultiplier = 1.0;
    bool syncEnabled = true;
    bool followTransport = true; // host play launches the deck, host stop stops it
    /** THE MASTER TEMPO SOURCE (D-SL-DECKPLUGIN-02 · D2). 0 = follow the host's
        playhead, which is the default and what shipped first. A POSITIVE value
        is an INTERNAL master the user typed: the pump then stretches against
        that number and ignores the DAW's tempo entirely.

        It lives in the recipe rather than in the web tier alone because a DAW
        plays projects with the editor CLOSED. Without it, a deck set to an
        internal 140 would silently revert to following the host the moment the
        window shut — the same class of defect as the transport recipe, and the
        reason `hostSyncConfig` doubles as a read.

        Still not a second tempo AUTHORITY (D-SL-DECKPLUGIN-01): djSyncLaw
        resolves the law and this is its output, exactly as `pulseMultiplier`
        is. All that changes is WHICH number gets multiplied. */
    double masterBpm = 0.0;
};

class HostSync {
public:
    /** RT half. Reads the playhead (absent/invalid fields leave the last
        value standing) and pairs it with the engine clock at this instant —
        the anchor a later host-grid launch computation needs. */
    void capture(juce::AudioPlayHead* playhead, const sl_engine* engine) noexcept;

    /** Message-thread half. Applies the recipe to deck 0 of `engine`.
        Returns true when a follow-enabled transport EDGE fired this tick —
        the processor then re-applies its cached world with isPlaying flipped
        (deck transport is snapshot state, sl_engine.h §6).

        `writeRatio` false = observe only: track the host and the transport
        edges, but do NOT touch syncRatio/tempoMode. The processor passes false
        while an editor is open, because the web tier is then the tempo
        authority and two writers at 40 Hz make a deck wobble between tempi. */
    bool pump(sl_engine* engine, bool writeRatio = true);

    // Recipe access — message thread only.
    void setRecipe(const HostSyncRecipe& r) { recipe = r; }
    const HostSyncRecipe& currentRecipe() const { return recipe; }

    /** The last-captured host state, for the `hostTransport` slEvent and for
        tests. Safe from the message thread. */
    struct Snapshot {
        double bpm = 0.0;
        double ppq = 0.0;
        bool playing = false;
        bool valid = false;
        uint64_t engineTime = 0;
    };
    Snapshot snapshot() const noexcept;

private:
    // RT → message handoff. The stores stay relaxed and the SEQLOCK below is
    // what makes them coherent — see it for which pairing stopped being
    // tolerable and why.
    std::atomic<double> hostBpm{0.0};
    std::atomic<double> hostPpq{0.0};
    std::atomic<bool> hostPlaying{false};
    std::atomic<bool> hasPlayhead{false};
    std::atomic<uint64_t> engineTimeAtCapture{0};
    /** SEQLOCK over the capture, and it exists for exactly one reader.
     *
     *  The fields above are individually meaningful at control rate, so relaxed
     *  stores were fine while the only consumers were a tempo readout and a
     *  transport lamp — a torn pairing costs one pump tick and heals.
     *
     *  `ppq` and `engineTime` are NOT independent, though: together they are the
     *  ANCHOR that converts a musical boundary into an engine frame
     *  (D-SL-DECKPLUGIN-03). Read them from different blocks and the anchor is
     *  off by a block, which puts the launch off by a block — the precise error
     *  the whole feature exists to avoid, and one that would look like jitter
     *  rather than like a bug. Odd = a write in progress. */
    std::atomic<uint32_t> captureSeq{0};

    // Message-thread state.
    HostSyncRecipe recipe;
    double lastRatio = -1.0;
    int lastMode = -1;
    bool lastPlaying = false;
    int32_t idSyncRatio = -2; // -2 = unresolved; resolved once on first pump
    int32_t idTempoMode = -2;
};

} // namespace wizard::plugin
