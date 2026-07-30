// The seam between the take-writing service and whichever engine holds the
// drain rings.
//
// ⚠️ THE REASON THIS EXISTS CHANGED AT H2a — read the new one before deleting it
// as a one-implementation abstraction.
//
// It was built because the merge ran TWO engines side by side (wizard's
// wz_engine and the merged SL ABI v3 over scoopy's core) with identical
// drain-to-disk logic, so the P3 ownership flip could be a change of which
// source is constructed. That flip happened, the donor is retired, and exactly
// one implementation (SlTakeDrainSource) remains.
//
// What survives is the second, independent reason, and it is the stronger one:
// THIS HEADER NAMES NO ENGINE. That is what lets wz_record link no ABI at all
// and stay free of JUCE — the stated precondition for a future WASM/companion
// build reusing the crash-safe writer, the sidecar, the naming and the Law C-2
// stamp handling verbatim rather than reimplementing them. Collapsing this seam
// into a direct sl_* call would buy one virtual call per ~20 ms drain tick and
// spend the portability it was also protecting (P1-STATUS decision 4 — a
// combined header once made the shell pull in a whole core to name a type it
// did not use).
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
