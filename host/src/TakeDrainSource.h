// The seam between the take-writing service and whichever engine holds the
// drain rings.
//
// Same shape, and the same reason, as RenderSink: the merge runs TWO engines
// side by side — wizard's wz_engine (the donor) and the merged SL ABI v3 over
// scoopy's core (the survivor) — and the drain-to-disk logic is identical for
// both. A take is a take: the crash-safe writer, the sidecar, the naming, the
// Law C-2 stamp handling and the thread that never blocks the render do not
// care which engine captured the audio. So the service is parameterised on this
// interface rather than duplicated, and the P3 ownership flip becomes a change
// of which source is constructed.
//
// This header names NO engine, which is the point: wz_record can then link
// neither of them, and a host drags only the engine it actually constructs onto
// its link line (P1-STATUS decision 4 — a combined header once made the shell
// pull in a whole core just to name a type it did not use).
//
// Deliberately NOT a template: the service is compiled once, and the cost is one
// virtual call per DRAIN TICK (~20 ms), which is not a measurable thing.
#pragma once

#include <cstdint>

namespace wizard::record {

class TakeDrainSource {
public:
    virtual ~TakeDrainSource() = default;

    /** How many independently recordable slots this engine has (wizard decks,
        merged tapes). The service allocates one file writer per slot. */
    virtual uint32_t slotCount() const noexcept = 0;

    /** Called on the service thread every tick: keep record-buffer chunks
        allocated AHEAD of the render's write position. Allocation belongs on
        this thread and never on the audio one. Cheap when nothing is recording. */
    virtual void serviceAllocation() noexcept = 0;

    /** Pull up to `capacityFrames` interleaved frames out of `slot`'s lock-free
        drain ring; returns frames actually read (0 = empty, which is normal, not
        an underrun). `outStartSample` receives the take's Law C-2 stamp.

        `out` must hold capacityFrames × channelsOf(slot) floats. */
    virtual uint32_t drain(uint32_t slot, float* out, uint32_t capacityFrames,
                           uint64_t* outStartSample) noexcept = 0;
};

} // namespace wizard::record
