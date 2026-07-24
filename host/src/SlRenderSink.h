// RenderSink adapter for the merged engine (SL ABI v3 over scoopy's core).
//
// Split one-adapter-per-header on purpose: the shell renders wizard's engine
// and must not drag scoopy's entire core onto its link line just to name a
// type. Include the one you construct.
#pragma once

#include "RenderSink.h"

#include "sl_engine.h"

namespace wizard::host {

/** The merged engine: SL ABI v3 over scoopy's hash-pinned core (SL-ABI-V3.md).
    Bus order is the engine's lane order — 0/1 = main L/R — so a stereo device
    gets the main mix and a multi-out device gets the lanes the host maps. */
class SlRenderSink final : public RenderSink {
public:
    explicit SlRenderSink(sl_engine* e) noexcept : engine(e) {}

    uint32_t maxBlockFrames() const noexcept override {
        return engine == nullptr ? 0u : sl_engine_max_block_frames(engine);
    }

    // The D-WZ-RATE-01 rebuild, performed where the design doc puts it. stop()
    // is idempotent, and the engine is left STARTED because every caller sets
    // the rate immediately before attaching the device callback — an engine
    // that came back stopped would render silence and look like a dead device.
    bool setSampleRate(double sampleRate) noexcept override {
        if (engine == nullptr) return false;
        sl_engine_stop(engine);
        if (sl_engine_set_sample_rate(engine, sampleRate) != 1) return false;
        return sl_engine_start(engine) == 1;
    }

    void renderIo(const float* const* in, uint32_t inCount,
                  float* const* out, uint32_t outCount,
                  uint32_t frames) noexcept override {
        sl_render_io(engine, in, inCount, out, outCount, frames);
    }

private:
    sl_engine* engine;
};

} // namespace wizard::host
