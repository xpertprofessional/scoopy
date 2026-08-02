#pragma once

#include <array>
#include <atomic>
#include <cstdint>

namespace wizard::host {

/**
 * WHICH ENGINE BUS GOES TO WHICH DEVICE CHANNEL (S5).
 *
 * ⚠️ TODAY THERE IS NO MAP AT ALL, and that is the gap this closes. The engine
 * renders straight into the device's channel buffers — bus 0 → channel 0, bus 1
 * → channel 1, for as many channels as the device has. `sl_engine.h` says the
 * desktop "maps it through the host's output map"; there was no such map, so
 * three declared protocol commands had nowhere to land:
 * `setDeckOutputChannels`, `setSendOutputChannel` and
 * `setPerTrackOutputRouting`, all specified and answered by nobody.
 *
 * The identity default reproduces the current behaviour EXACTLY, so installing
 * this changes nothing until something asks it to.
 *
 * ⚠️ THE BUG THE 1:1 NEVER HAD. Once a map exists, a device channel can have no
 * bus pointing at it — and the device hands us whatever was last in that memory.
 * Passing that through is an audible fault dressed as a quiet one, which is the
 * exact hazard `renderChunked` already documents for the unconfigured-engine
 * case. So an unrouted channel is CLEARED, every block, and that rule is tested.
 *
 * RT-SAFETY: read on the audio thread, written from the message thread. Plain
 * relaxed atomics, one per lane — no locks, no allocation, and an `int32` can
 * not tear. A caller sees either the old routing or the new one, never half of
 * each, which is all that is needed: routing is a preference, not a sample.
 */
class OutputMap {
public:
    /** Engine lanes this host will map. `sl_engine.h`'s lane order is main L/R,
        then sends, cue, per-deck outs and FX-return wets — 26 covers the
        current build with room, and a lane past the end is simply not routed. */
    static constexpr int kMaxBuses = 32;

    /** No device channel. The bus is rendered nowhere and is silent. */
    static constexpr int kNone = -1;

    OutputMap() { reset(); }

    /** Identity: bus i → channel i, which IS the behaviour before this existed. */
    void reset() noexcept {
        for (int i = 0; i < kMaxBuses; ++i)
            lane[static_cast<size_t>(i)].store(i, std::memory_order_relaxed);
    }

    /** Route one bus, or `kNone` to silence it. Out-of-range is ignored rather
        than clamped: clamping would silently send audio somewhere nobody asked
        for, which is worse than the routing not taking. */
    void set(int bus, int channel) noexcept {
        if (bus < 0 || bus >= kMaxBuses) return;
        lane[static_cast<size_t>(bus)].store(channel, std::memory_order_relaxed);
    }

    int channelFor(int bus) const noexcept {
        if (bus < 0 || bus >= kMaxBuses) return kNone;
        return lane[static_cast<size_t>(bus)].load(std::memory_order_relaxed);
    }

    /** Is any bus routed to this device channel? Drives the clear-the-rest rule
        above. Linear over 32 lanes on the audio thread, per block, which is
        nothing next to a render — and a reverse index would have to be kept
        coherent under concurrent writes for no measurable gain. */
    bool isTargeted(int channel) const noexcept {
        for (int i = 0; i < kMaxBuses; ++i)
            if (lane[static_cast<size_t>(i)].load(std::memory_order_relaxed) == channel) return true;
        return false;
    }

private:
    std::array<std::atomic<int>, kMaxBuses> lane;
};

} // namespace wizard::host
