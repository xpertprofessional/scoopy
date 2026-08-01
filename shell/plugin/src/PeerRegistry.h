// THE ONE THING THE HOST CLOCK CANNOT ANSWER (D-SL-DECKPLUGIN-03, step 4).
//
// Launch quantize works across instances with nothing shared, because every
// instance resolves the same host `ppqPosition` independently — that is steps
// 1-3 and it needs no registry at all. What it CANNOT do is let deck B wait on
// deck A's *cycle*: B has to know A's cycle length and where its boundaries
// fall, and the DAW's playhead does not carry that.
//
// So this is four numbers for one question, not a general mirror of every
// instance's state. D4 (D-SL-DECKPLUGIN-02) rejected the latter and that
// rejection stands; D-SL-DECKPLUGIN-03 amends it for exactly this.
//
// ⚠️ PER PROCESS, AND THAT IS A REAL LIMIT, not a caveat to bury:
//   · Bitwig sandboxes each plugin into its own process — peers never see each
//     other there, at all.
//   · A VST3 instance and an AU instance are different binaries in the same
//     process and do not share these statics either.
//   · Two DAWs open at once are two processes.
// A reference that is not in this process must fall back to the host grid and
// SAY so on screen. Never wait for a deck that cannot appear — that is a deck
// silent forever with no error anywhere, which is the failure this project
// keeps paying for.
//
// LOCK-FREE because a reader may run from the message thread while a writer
// runs on another instance's message thread; a seqlock per row keeps `cycle`
// and `anchor` coherent, since they are one anchor rather than two readings
// (the same lesson HostSync's capture learned).
#pragma once

#include <array>
#include <atomic>
#include <cstdint>

namespace wizard::plugin {

class PeerRegistry {
public:
    /** What one instance publishes about itself. PPQ throughout, because that
        is the only clock every instance already agrees on. */
    struct Row {
        /** The deck's cycle length in quarter notes. 0 = no resolvable cycle
            (an empty session), which reads as "cannot be a reference". */
        double cyclePpq = 0.0;
        /** A ppq at which one of this deck's cycle boundaries falls. Its
            boundaries are every `anchorPpq + n · cyclePpq`. Set from the launch
            that started it, so it is the host-grid boundary it came in on. */
        double anchorPpq = 0.0;
        bool playing = false;
        /** The session name, for the UI to say WHAT it is waiting on. Fixed
            storage: a std::string here would allocate under a reader. */
        char name[32] = {};
    };

    /** Take a slot for this instance's lifetime. -1 when the table is full,
        which is not an error — the deck simply cannot be a reference, and
        everything else about it still works. */
    static int claim() noexcept;
    static void release(int slot) noexcept;

    /** Publish this instance's row. Message thread. */
    static void publish(int slot, const Row& row) noexcept;

    /** Copy every PLAYING peer's row except `excludeSlot`, in slot order.
        Returns how many were written. Slot order is the tiebreak that makes
        `auto` predictable rather than clever — D-SL-QUANTUM-01's rule, applied
        across instances instead of across strips. */
    static int peers(Row* out, int max, int excludeSlot) noexcept;

    /** Slots this build provides. Not a limit anyone should hit: it is decks in
        one DAW project, not tracks. */
    static constexpr int kSlots = 8;

private:
    struct Slot {
        std::atomic<uint32_t> seq{0};   // odd = a write in flight
        std::atomic<bool> taken{false};
        Row row{};                      // guarded by seq
    };
    static std::array<Slot, kSlots>& table() noexcept;
};

} // namespace wizard::plugin
