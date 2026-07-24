// RenderSink adapter for wizard's own engine — the donor (removed at the P3 flip).
//
// Split one-adapter-per-header on purpose: the shell renders wizard's engine
// and must not drag scoopy's entire core onto its link line just to name a
// type. Include the one you construct.
#pragma once

#include "RenderSink.h"

#include "wz_engine.h"

namespace wizard::host {

/** wizard's own engine — the donor. Removed at the P3 ownership flip. */
class WzRenderSink final : public RenderSink {
public:
    explicit WzRenderSink(wz_engine* e) noexcept : engine(e) {}

    uint32_t maxBlockFrames() const noexcept override {
        return engine == nullptr ? 0u : wz_engine_max_block_frames(engine);
    }

    // wz_engine has no start/stop: the rate is simply set.
    bool setSampleRate(double sampleRate) noexcept override {
        if (engine == nullptr) return false;
        wz_engine_set_sample_rate(engine, sampleRate);
        return true;
    }

    void renderIo(const float* const* in, uint32_t inCount,
                  float* const* out, uint32_t outCount,
                  uint32_t frames) noexcept override {
        wz_engine_render_io(engine, in, inCount, out, outCount, frames);
    }

private:
    wz_engine* engine;
};

} // namespace wizard::host
