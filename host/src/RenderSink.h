// The seam between the device layer and whichever engine is rendering.
//
// ⚠️ THE REASON THIS EXISTS CHANGED AT H2a. It was built because P1 of the merge
// ran TWO engines side by side — wizard's wz_engine (the donor) and the merged
// SL ABI v3 over scoopy's core (the survivor) — so the P3 ownership flip could
// be a change of which sink is constructed. That flip happened and the donor is
// retired; SlRenderSink is the only implementation left.
//
// It stays because the seam is also what keeps wz_audio_io ABI-free: the device
// library names no engine, so it links none (H2a deleted a `PRIVATE wz_engine`
// that had already been vestigial for exactly this reason). It is additionally
// what render_sink_test drives — the chunking, offsetting and channel-ceiling
// arithmetic is tested against a spy sink, with no engine and no device at all.
//
// Deliberately NOT a template: AudioIO is compiled once, and the cost is one
// virtual call per CHUNK (not per sample), which is noise next to a render.
#pragma once

#include "OutputMap.h"

namespace wizard::host {

class RenderSink {
public:
    virtual ~RenderSink() = default;

    /** The largest block the engine will render in one call. 0 means the engine
        is not configured — the caller must then produce silence rather than
        guess a block size. */
    virtual uint32_t maxBlockFrames() const noexcept = 0;

    /** Point the engine at `sampleRate`, ready to render. False if it could not
        be done — the caller must then treat the device as unusable at this rate
        rather than let the engine run at a rate it is not clocked for.

        Called with the device callback DETACHED, immediately before attach().
        SL ABI v3 refuses a rate change on a running engine (it reallocates the
        buffers the callback reads), so its adapter performs the stop → set →
        start rebuild here — this is the "tears down and rebuilds at the host
        layer" half of D-WZ-RATE-01, and the sink is that host layer. */
    virtual bool setSampleRate(double sampleRate) noexcept = 0;

    /** Duplex render. Inputs ride the SAME callback on the SAME clock (zero SRC,
        D-WZ-RATE-01). `frames` never exceeds maxBlockFrames(). RT-safe. */
    virtual void renderIo(const float* const* in, uint32_t inCount,
                          float* const* out, uint32_t outCount,
                          uint32_t frames) noexcept = 0;
};

/** The device callback's whole body, extracted so it can be tested without a
    device or a display.

    Chunks the device block down to the engine's max render block (a device may
    hand over more frames than the engine allocated for), offsetting both sides
    together so inputs and outputs stay sample-aligned. An unconfigured engine
    (maxBlockFrames() == 0) yields SILENCE, never stale buffer contents — the
    device hands us whatever was last in that memory, and passing it through
    would be an audible fault dressed up as a quiet one. */
/** `map` is OPTIONAL and null means the identity routing this had before it
    existed — bus i straight into device channel i. Supplied, every engine bus
    is written to the channel the map names, and any device channel no bus
    points at is CLEARED rather than left holding whatever the device had. */
void renderChunked(RenderSink& sink,
                   const float* const* input, int numInputChannels,
                   float* const* output, int numOutputChannels,
                   int numSamples, const OutputMap* map = nullptr) noexcept;

/** Channel ceiling for one callback. Device pointer arrays are stack-copied per
    chunk to offset them, so the bound is fixed and generous rather than dynamic
    — an allocation here would be a glitch. */
inline constexpr int kMaxCallbackChannels = 32;

} // namespace wizard::host
