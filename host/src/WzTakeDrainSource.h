// TakeDrainSource adapter for wizard's donor engine (wz_deck_*).
//
// Split one-adapter-per-header on purpose: a host that records from the merged
// engine must not drag wizard's engine onto its link line just to name a type.
// Include the one you construct.
#pragma once

#include "TakeDrainSource.h"

#include "wz_engine.h"

namespace wizard::record {

/** Wizard's eight decks. The deck count is fixed by the engine (wz::kMaxDecks)
    and not exposed over its ABI, so it is stated here rather than guessed
    per-call. */
class WzTakeDrainSource final : public TakeDrainSource {
public:
    explicit WzTakeDrainSource(wz_engine* e) noexcept : engine(e) {}

    uint32_t slotCount() const noexcept override { return 8u; }

    void serviceAllocation() noexcept override { wz_deck_record_service(engine); }

    uint32_t drain(uint32_t slot, float* out, uint32_t capacityFrames,
                   uint64_t* outStartSample) noexcept override {
        return wz_deck_drain(engine, slot, out, capacityFrames, outStartSample);
    }

private:
    wz_engine* engine;
};

} // namespace wizard::record
