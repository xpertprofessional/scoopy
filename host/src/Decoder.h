// Host file decode for deck loading (docs/specs/routing.md §7).
//
// decode → (rate mismatch? SINC_BEST resample to the engine rate, off the
// audio thread — D-WZ-DECKSRC-01) → planar float32 the caller hands to
// wz_deck_load with the render callback detached. Backend-neutral surface so
// an FFmpeg backend can slot in later (parlante D-DECODE-01 precedent).
#pragma once

#include <juce_core/juce_core.h>

#include <vector>

namespace wizard::decode {

struct DeckAudio {
    bool ok = false;
    juce::String error;
    uint32_t channels = 0;
    double sourceRate = 0.0;   // the FILE's native rate
    uint64_t sourceFrames = 0; // frames at the native rate
    // Planar samples AT THE ENGINE RATE (resampled when sourceRate differs).
    std::vector<std::vector<float>> data;
    uint64_t engineFrames() const { return data.empty() ? 0 : data[0].size(); }
};

/** Decode `file` and (if needed) resample to `engineRate`. Blocking; call on
    the message thread BEFORE suspending the render callback — only the cheap
    wz_deck_load copy needs the engine detached. */
DeckAudio loadForDeck(const juce::File& file, double engineRate);

} // namespace wizard::decode
