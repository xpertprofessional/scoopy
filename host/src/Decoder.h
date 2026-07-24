// Host file decode for deck loading (docs/specs/routing.md §7).
//
// decode → (rate mismatch? SINC_BEST resample to the engine rate, off the
// audio thread — D-WZ-DECKSRC-01) → planar float32 the caller hands to
// wz_deck_load with the render callback detached. Backend-neutral surface so
// an FFmpeg backend can slot in later (parlante D-DECODE-01 precedent).
#pragma once

#include <juce_core/juce_core.h>

#include <functional>
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

/** Optional progress + cancellation for an off-thread load (P1-11). Both are
    called from loadForDeck's own thread — the caller marshals to the UI thread
    if it needs to. Kept out of DeckAudio because they are inputs, not results. */
struct LoadControl {
    /** Monotonic 0..1. Reported at phase boundaries (a SINC_BEST resample is
        not internally chunked here, so a single long channel is one step). */
    std::function<void(float)> onProgress;
    /** Polled between the expensive phases. Returning true aborts the load ASAP
        with ok=false, error "cancelled" — used to drop a superseded load rather
        than finish decoding a file the user has already replaced. */
    std::function<bool()> isCancelled;
};

/** Decode `file` and (if needed) resample to `engineRate`. Blocking, so a long
    SINC_BEST conversion must run OFF the message thread (P1-11); only the cheap
    wz_deck_load copy that follows needs the engine detached. */
DeckAudio loadForDeck(const juce::File& file, double engineRate, const LoadControl& ctl = {});

} // namespace wizard::decode
