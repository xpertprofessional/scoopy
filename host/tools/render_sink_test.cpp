// The device callback's arithmetic, tested without a device (P1 plumbing).
//
// renderChunked is the part of AudioIO that can be wrong in ways nobody hears
// until a specific device shows up: a device block bigger than the engine's
// render block, a channel count past the callback ceiling, an engine that is
// not configured yet. The final case drives the REAL SlRenderSink through the
// same path, so the seam is proven by the engine that ships, not by a spy alone.
#include "SlRenderSink.h"
#include "RenderSink.h"

#include <cmath>
#include <cstdio>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

using namespace wizard::host;

namespace {

/** Records exactly what the chunk loop handed it, so the test can assert on the
    chunking rather than on audio. Writes a per-call marker into every output so
    coverage of the buffer is checkable too. */
class SpySink final : public RenderSink {
public:
    uint32_t block = 128;
    bool rateOk = true;
    std::vector<uint32_t> chunks;
    std::vector<uint32_t> inCounts, outCounts;
    std::vector<double> lastRates;
    int nullInputChannels = 0;

    uint32_t maxBlockFrames() const noexcept override { return block; }

    bool setSampleRate(double r) noexcept override {
        lastRates.push_back(r);
        return rateOk;
    }

    void renderIo(const float* const* in, uint32_t inCount,
                  float* const* out, uint32_t outCount,
                  uint32_t frames) noexcept override {
        chunks.push_back(frames);
        inCounts.push_back(inCount);
        outCounts.push_back(outCount);
        for (uint32_t c = 0; c < inCount; ++c)
            if (in[c] == nullptr) ++nullInputChannels;
        // Stamp the chunk index so gaps or overlaps in the offsetting show up.
        const auto marker = static_cast<float>(chunks.size());
        for (uint32_t c = 0; c < outCount; ++c)
            if (out[c] != nullptr)
                for (uint32_t i = 0; i < frames; ++i) out[c][i] = marker;
    }
};

} // namespace

int main() {
    // A device block larger than the engine's render block is chunked, and the
    // chunks tile the buffer exactly — no gap, no overlap, no short last chunk
    // that silently drops frames.
    {
        SpySink spy;
        spy.block = 128;
        std::vector<float> l(300, -1.0f), r(300, -1.0f);
        float* outs[2] = {l.data(), r.data()};
        renderChunked(spy, nullptr, 0, outs, 2, 300);
        CHECK(spy.chunks.size() == 3);
        CHECK(spy.chunks[0] == 128 && spy.chunks[1] == 128 && spy.chunks[2] == 44);
        uint32_t total = 0;
        for (auto c : spy.chunks) total += c;
        CHECK(total == 300);
        // Every sample was written exactly once, by the chunk that owns it.
        for (int i = 0; i < 300; ++i) {
            const float expected = i < 128 ? 1.0f : (i < 256 ? 2.0f : 3.0f);
            CHECK(l[i] == expected && r[i] == expected);
        }
    }

    // An exact multiple must not produce a trailing zero-frame call — an engine
    // asked to render 0 frames is a call that should never have happened.
    {
        SpySink spy;
        spy.block = 64;
        std::vector<float> buf(256, 0.0f);
        float* outs[1] = {buf.data()};
        renderChunked(spy, nullptr, 0, outs, 1, 256);
        CHECK(spy.chunks.size() == 4);
        for (auto c : spy.chunks) CHECK(c == 64);
    }

    // An unconfigured engine yields SILENCE, not whatever the device left in
    // the buffer, and never calls the engine.
    {
        SpySink spy;
        spy.block = 0;
        std::vector<float> buf(64, 0.7f);
        float* outs[1] = {buf.data()};
        renderChunked(spy, nullptr, 0, outs, 1, 64);
        CHECK(spy.chunks.empty());
        for (float v : buf) CHECK(v == 0.0f);
    }

    // Degenerate shapes are refused rather than reasoned about.
    {
        SpySink spy;
        std::vector<float> buf(64, 0.5f);
        float* outs[1] = {buf.data()};
        renderChunked(spy, nullptr, 0, outs, 0, 64);   // no channels
        renderChunked(spy, nullptr, 0, outs, 1, 0);    // no frames
        renderChunked(spy, nullptr, 0, nullptr, 1, 64); // no output array
        CHECK(spy.chunks.empty());
        for (float v : buf) CHECK(v == 0.5f); // untouched
    }

    // Inputs are offset in lockstep with outputs: chunk 2 must see input frame
    // 128, not input frame 0. A ramp makes a mis-offset obvious.
    {
        SpySink spy;
        spy.block = 128;
        std::vector<float> in(300);
        for (int i = 0; i < 300; ++i) in[i] = static_cast<float>(i);
        std::vector<float> out(300, 0.0f);
        const float* ins[1] = {in.data()};
        float* outs[1] = {out.data()};

        class OffsetCheck final : public RenderSink {
        public:
            int bad = 0;
            uint32_t seen = 0;
            uint32_t maxBlockFrames() const noexcept override { return 128; }
            bool setSampleRate(double) noexcept override { return true; }
            void renderIo(const float* const* i, uint32_t inCount,
                          float* const*, uint32_t, uint32_t frames) noexcept override {
                if (inCount >= 1 && i[0] != nullptr && i[0][0] != static_cast<float>(seen)) ++bad;
                seen += frames;
            }
        } offsetCheck;
        renderChunked(offsetCheck, ins, 1, outs, 1, 300);
        CHECK(offsetCheck.bad == 0);
        CHECK(offsetCheck.seen == 300);
        (void) spy;
    }

    // Channels past the callback ceiling are cleared, not left stale — nothing
    // else writes them because the engine is never told they exist.
    {
        SpySink spy;
        spy.block = 64;
        const int over = kMaxCallbackChannels + 2;
        std::vector<std::vector<float>> storage(static_cast<size_t>(over),
                                                std::vector<float>(64, 9.0f));
        std::vector<float*> outs;
        for (auto& s : storage) outs.push_back(s.data());
        renderChunked(spy, nullptr, 0, outs.data(), over, 64);
        CHECK(!spy.outCounts.empty() && spy.outCounts[0] == kMaxCallbackChannels);
        CHECK(storage[0][0] == 1.0f);                                   // rendered
        CHECK(storage[static_cast<size_t>(kMaxCallbackChannels)][0] == 0.0f);     // cleared
        CHECK(storage[static_cast<size_t>(kMaxCallbackChannels) + 1][0] == 0.0f);
    }

    // A null channel inside the array is skipped, not dereferenced: JUCE hands
    // null for an inactive channel.
    {
        SpySink spy;
        spy.block = 64;
        std::vector<float> buf(64, 0.0f);
        float* outs[2] = {nullptr, buf.data()};
        const float* ins[2] = {nullptr, nullptr};
        renderChunked(spy, ins, 2, outs, 2, 64);
        CHECK(spy.chunks.size() == 1);
        CHECK(spy.nullInputChannels == 2); // passed through as null, not faked
        for (float v : buf) CHECK(v == 1.0f);
    }

    // The real thing: SL ABI v3 renders through the same path, and the sink
    // performs the D-WZ-RATE-01 stop → set → start rebuild.
    {
        sl_engine* e = sl_engine_create(48000.0, 256, 86);
        CHECK(e != nullptr);
        SlRenderSink slSink(e);
        CHECK(slSink.maxBlockFrames() == 256);

        // Rate change while running: refused by the ABI, performed by the sink.
        CHECK(sl_engine_start(e) == 1);
        CHECK(sl_engine_set_sample_rate(e, 44100.0) == 0); // the raw ABI refuses
        CHECK(slSink.setSampleRate(44100.0));              // the host layer rebuilds
        CHECK(sl_engine_sample_rate(e) == 44100.0);
        // …and leaves it started, so the callback that follows renders audio
        // rather than silence.
        CHECK(sl_engine_set_sample_rate(e, 48000.0) == 0);

        // A device block larger than the engine's is chunked into it.
        std::vector<float> l(600, 3.0f), r(600, 3.0f);
        float* outs[2] = {l.data(), r.data()};
        renderChunked(slSink, nullptr, 0, outs, 2, 600);
        for (int i = 0; i < 600; ++i) {
            CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));
            CHECK(l[i] == 0.0f && r[i] == 0.0f); // silent scene, but WRITTEN
        }

        sl_engine_stop(e);
        sl_engine_destroy(e);

        // A null engine behind the sink is a silent device, not a crash.
        SlRenderSink dead(nullptr);
        CHECK(dead.maxBlockFrames() == 0);
        CHECK(!dead.setSampleRate(48000.0));
        std::vector<float> buf(32, 4.0f);
        float* deadOuts[1] = {buf.data()};
        renderChunked(dead, nullptr, 0, deadOuts, 1, 32);
        for (float v : buf) CHECK(v == 0.0f);
    }

    std::printf("render_sink_test OK\n");
    return 0;
}
