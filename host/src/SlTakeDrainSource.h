// TakeDrainSource adapter for the merged engine (SL ABI v3 tapes).
//
// Split one-adapter-per-header on purpose: the legacy shell records from
// wizard's engine and must not drag scoopy's entire core onto its link line
// just to name a type. Include the one you construct.
#pragma once

#include "TakeDrainSource.h"

#include "sl_engine.h"

namespace wizard::record {

/** The merged engine's tapes (SL-ABI-V3 §5). Note this is the TAPE index space,
    which is independent of the grid decks — a tape is the continuous
    record/scrub/loop buffer, and grid decks have no drain of their own because
    a sequenced session is not captured audio. */
class SlTakeDrainSource final : public TakeDrainSource {
public:
    explicit SlTakeDrainSource(sl_engine* e) noexcept : engine(e) {}

    uint32_t slotCount() const noexcept override { return sl_tape_count(); }

    void serviceAllocation() noexcept override { sl_tape_record_service(engine); }

    uint32_t drain(uint32_t slot, float* out, uint32_t capacityFrames,
                   uint64_t* outStartSample) noexcept override {
        return sl_tape_drain(engine, slot, out, capacityFrames, outStartSample);
    }

private:
    sl_engine* engine;
};

} // namespace wizard::record
