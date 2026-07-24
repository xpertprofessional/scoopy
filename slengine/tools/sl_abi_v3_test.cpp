// SL ABI v3 — identity, unified create, planar render (SL-ABI-V3.md §1–2).
#include "sl_engine.h"

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
    // Identity. The constant and the function must agree — a header that says 3
    // over a library that says 2 is exactly the skew the version exists to catch.
    CHECK(sl_abi_version() == 3);
    CHECK(sl_abi_version() == SL_ABI_VERSION);
    CHECK(sl_engine_max_out_buses() >= 2); // main L/R at minimum

    // Unified create: no separate configure step, and the parameters echo back.
    sl_engine* e = sl_engine_create(48000.0, 512, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_sample_rate(e) == 48000.0);
    CHECK(sl_engine_max_block_frames(e) == 512);
    CHECK(sl_engine_schema_version(e) == 86); // HotFrame slot-0 echo (§1)

    // A create that cannot be configured returns NULL rather than a half-built
    // engine the caller would have no way to detect.
    CHECK(sl_engine_create(48000.0, 0, 86) == nullptr);
    CHECK(sl_engine_create(0.0, 512, 86) == nullptr);

    // Every accessor is null-safe: the ABI is a boundary, and a boundary that
    // segfaults on a null handle is not one.
    CHECK(sl_engine_sample_rate(nullptr) == 0.0);
    CHECK(sl_engine_max_block_frames(nullptr) == 0u);
    CHECK(sl_engine_schema_version(nullptr) == 0);
    CHECK(sl_engine_start(nullptr) == 0);
    sl_engine_stop(nullptr);
    sl_engine_destroy(nullptr);
    sl_render(nullptr, nullptr, 0, 0);
    sl_render_io(nullptr, nullptr, 0, nullptr, 0, 0);

    CHECK(sl_engine_start(e) == 1);

    // Planar render, the narrow (stereo) call — v2's shape as a special case.
    std::vector<float> l(512, 1.0f), r(512, 1.0f);
    float* buses[2] = {l.data(), r.data()};
    sl_render(e, buses, 2, 512);
    // Silent scene, but the lanes must have been WRITTEN (the 1.0f sentinels
    // are gone) and every sample must be finite — a NaN here would poison the
    // device buffer downstream.
    for (uint32_t i = 0; i < 512; ++i) {
        CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));
        CHECK(l[i] == 0.0f && r[i] == 0.0f);
    }

    // Renders past the configured block are refused outright — the scratch was
    // allocated for max_block_frames and the callback must not allocate.
    std::vector<float> big(1024, 7.0f);
    float* oneBus[1] = {big.data()};
    sl_render(e, oneBus, 1, 1024);
    CHECK(big[0] == 7.0f); // untouched: nothing was rendered
    sl_render(e, oneBus, 1, 0);
    CHECK(big[0] == 7.0f);

    // Buses beyond the engine's lane count are LEFT ALONE, not zeroed: the
    // caller owns them and may be mixing something else in.
    const uint32_t lanes = sl_engine_max_out_buses();
    std::vector<std::vector<float>> storage(lanes + 2, std::vector<float>(64, 5.0f));
    std::vector<float*> wide;
    for (auto& s : storage) wide.push_back(s.data());
    sl_render(e, wide.data(), lanes + 2, 64);
    CHECK(storage[lanes][0] == 5.0f);     // one past the last lane
    CHECK(storage[lanes + 1][0] == 5.0f);
    CHECK(storage[0][0] == 0.0f);         // a real lane WAS written

    // A null bus pointer inside an otherwise valid array is skipped, not fatal.
    float* holed[2] = {nullptr, r.data()};
    sl_render(e, holed, 2, 64);

    // Duplex: inputs ride the same callback on the same clock (zero SRC).
    std::vector<float> inL(512, 0.25f), inR(512, -0.25f);
    const float* ins[2] = {inL.data(), inR.data()};
    sl_render_io(e, ins, 2, buses, 2, 512);
    for (uint32_t i = 0; i < 512; ++i) CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));
    // Mono input is accepted and must not read the absent second channel.
    const float* mono[1] = {inL.data()};
    sl_render_io(e, mono, 1, buses, 2, 512);
    // A null input array degrades to the silent path rather than faulting.
    sl_render_io(e, nullptr, 0, buses, 2, 512);
    for (uint32_t i = 0; i < 512; ++i) CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));

    // D-WZ-RATE-01, the engine half. A rate change WHILE RUNNING is refused:
    // reconfiguring reallocates the very buffers the render callback reads, so
    // the tear-down/rebuild belongs to the host. The refusal is the guarantee.
    CHECK(sl_engine_set_sample_rate(e, 44100.0) == 0);
    CHECK(sl_engine_sample_rate(e) == 48000.0); // and it did NOT silently re-clock

    sl_engine_stop(e);
    CHECK(sl_engine_set_sample_rate(e, 44100.0) == 1);
    CHECK(sl_engine_sample_rate(e) == 44100.0);
    CHECK(sl_engine_max_block_frames(e) == 512); // block survives a rate change
    // A refused change leaves the engine honest about what it is running at.
    CHECK(sl_engine_set_sample_rate(e, 0.0) == 0);
    CHECK(sl_engine_sample_rate(e) == 44100.0);
    CHECK(sl_engine_set_sample_rate(nullptr, 48000.0) == 0);
    CHECK(sl_engine_start(e) == 1);

    sl_render(e, buses, 2, 512); // still renders after the rate change
    for (uint32_t i = 0; i < 512; ++i) CHECK(std::isfinite(l[i]));

    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("sl_abi_v3_test OK (abi v%d, %u out buses)\n",
                sl_abi_version(), sl_engine_max_out_buses());
    return 0;
}
