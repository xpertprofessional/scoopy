// Null smoke test: the engine builds, links, renders silence into N buses
// without NaNs, advances its clock, and round-trips keyed params by name.
#include "wz_engine.h"

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

int main() {
    CHECK(wz_abi_version() == WZ_ABI_VERSION);

    // Bad args are rejected, not crashed.
    CHECK(wz_engine_create(0.0, 512, 1) == nullptr);
    CHECK(wz_engine_create(48000.0, 0, 1) == nullptr);

    wz_engine* e = wz_engine_create(48000.0, 512, 1);
    CHECK(e != nullptr);

    // Keyed param contract: resolve by name, unknown names are inert.
    const int32_t gainId = wz_param_id_for_name("mainGain");
    CHECK(gainId != WZ_PARAM_UNKNOWN);
    CHECK(wz_param_id_for_name("noSuchParam") == WZ_PARAM_UNKNOWN);
    CHECK(wz_param_id_for_name(nullptr) == WZ_PARAM_UNKNOWN);
    CHECK(wz_param_get(e, 0, gainId) == 0.75); // unity detent (D-WZ-FADER-01)
    wz_param_set(e, 0, gainId, 0.5);
    CHECK(wz_param_get(e, 0, gainId) == 0.5);
    wz_param_set(e, 0, WZ_PARAM_UNKNOWN, 99.0); // must be ignored, not crash

    // Name table is total over [0, count).
    for (uint32_t i = 0; i < wz_param_count(); ++i) CHECK(wz_param_name(i) != nullptr);
    CHECK(wz_param_name(wz_param_count()) == nullptr);

    // Render silence into a 4-bus (4-channel) layout; every buffer stays 0.
    constexpr uint32_t kBuses = 4;
    constexpr uint32_t kFrames = 512;
    std::vector<std::vector<float>> busBufs(kBuses, std::vector<float>(kFrames, -1.0f));
    std::vector<float*> busPtrs(kBuses);
    for (uint32_t b = 0; b < kBuses; ++b) busPtrs[b] = busBufs[b].data();

    for (int block = 0; block < 4; ++block) {
        wz_engine_render(e, busPtrs.data(), kBuses, kFrames);
        for (uint32_t b = 0; b < kBuses; ++b)
            for (uint32_t i = 0; i < kFrames; ++i) {
                CHECK(std::isfinite(busBufs[b][i]));
                CHECK(busBufs[b][i] == 0.0f);
            }
    }
    // A null bus pointer in the array is skipped, not dereferenced.
    busPtrs[1] = nullptr;
    wz_engine_render(e, busPtrs.data(), kBuses, kFrames);

    // Block/rate introspection for the host device layer.
    CHECK(wz_engine_max_block_frames(e) == 512);
    CHECK(wz_engine_max_block_frames(nullptr) == 0);
    CHECK(wz_engine_sample_rate(e) == 48000.0);
    wz_engine_set_sample_rate(e, 44100.0);
    CHECK(wz_engine_sample_rate(e) == 44100.0);
    wz_engine_set_sample_rate(e, 0.0); // rejected
    CHECK(wz_engine_sample_rate(e) == 44100.0);

    // Empty world: frame = the 8 scalars exactly; short capacity refused.
    CHECK(wz_engine_hotframe_length(e) == 8);
    double hot[8] = {};
    CHECK(wz_engine_hotframe(e, hot, 8) == 8);
    CHECK(wz_engine_hotframe(e, hot, 7) == 0); // capacity < length → refused
    CHECK(hot[0] == 1.0);                      // schemaVersion echo
    CHECK(hot[1] == 5 * 512.0);                // engineTimeSamples: 5 render calls
    CHECK(hot[2] == 0.0);                      // cpuLoad placeholder
    CHECK(hot[3] == 0.0);                      // feedbackAlarm idle
    CHECK(hot[4] == 0.0 && hot[5] == 0.0);     // main peak L/R: silence (no channels)
    CHECK(hot[6] == 0.0 && hot[7] == 0.0);     // monitor peak L/R: silence

    // With channels in the world, the frame grows by one 7-slot block each and
    // the render path stays finite + silent when the strips have no live source.
    wz_world_begin(e);
    wz_world_channel_begin(e, "a");
    wz_world_channel_end(e);
    wz_world_channel_begin(e, "b");
    wz_world_channel_end(e);
    wz_world_commit(e);
    CHECK(wz_engine_hotframe_length(e) == 8 + 2 * 7);
    for (uint32_t b = 0; b < kBuses; ++b) busPtrs[b] = busBufs[b].data();
    wz_engine_render(e, busPtrs.data(), kBuses, kFrames);
    for (uint32_t i = 0; i < kFrames; ++i) CHECK(busBufs[0][i] == 0.0f);
    double big[8 + 14] = {};
    CHECK(wz_engine_hotframe(e, big, 8 + 14) == 8 + 14);
    CHECK(wz_engine_hotframe(e, big, 8) == 0); // scalar-only buffer now too short
    for (int i = 8; i < 8 + 14; ++i) CHECK(big[i] == 0.0); // silent strips meter 0

    wz_engine_destroy(e);
    std::printf("null_smoke OK\n");
    return 0;
}
