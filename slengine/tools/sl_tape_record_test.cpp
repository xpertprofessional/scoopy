// Recording from a device input: capture fidelity, the 256 MB cap, the
// crash-safe drain, and Law C-2 stamps across staggered takes.
// Ported from wizard's record_cap_test + deck_stamp_test.
#include "sl_engine.h"

#include <cstdio>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr uint32_t kQ = 64;
constexpr double kRate = 48000.0;
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    std::vector<float> zero(kQ, 0.0f), inA(kQ), inB(kQ), l(kQ), r(kQ);
    const float* ins[4] = {zero.data(), zero.data(), inA.data(), inB.data()};
    float* outs[2] = {l.data(), r.data()};

    // An unknown record-source kind is REFUSED, never silently treated as
    // input 0 — a mis-sourced take records the wrong thing at full confidence.
    CHECK(sl_tape_set_record_source(e, 0, 99, 2, -1) == 0);
    CHECK(sl_tape_set_record_source(e, sl_tape_count(), 0, 2, -1) == 0);

    // --- STEREO capture is sample-exact -------------------------------------
    CHECK(sl_tape_set_record_source(e, 0, 0 /* deviceInput */, 2, 3) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    for (uint32_t i = 0; i < kQ; ++i) { inA[i] = 0.25f; inB[i] = -0.5f; }
    sl_render_io(e, ins, 4, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 0) == kQ);
    CHECK(sl_tape_channels(e, 0) == 2); // two named input channels ⇒ a stereo take
    // A recording tape's playback pass is SILENT — it is capturing, not playing.
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.0f);

    // The drain carries exactly what was captured, interleaved, for the host's
    // WAV writer. This is what makes a take survive a crash mid-recording.
    // The buffer is sized frames × CHANNELS: the ring is interleaved at the
    // tape's own width, and getting that wrong overflows the caller (it did,
    // once, when this port sized every ring at a guessed stereo).
    std::vector<float> drained(kQ * sl_tape_channels(e, 0), 0.0f);
    uint64_t drainStamp = 12345;
    const uint32_t got = sl_tape_drain(e, 0, drained.data(), kQ, &drainStamp);
    CHECK(got == kQ);
    CHECK(drainStamp == 0); // the take's Law C-2 stamp travels with the audio
    for (uint32_t i = 0; i < kQ; ++i) {
        CHECK(drained[i * 2 + 0] == 0.25f);
        CHECK(drained[i * 2 + 1] == -0.5f);
    }
    // Draining an empty ring is normal, not an underrun.
    CHECK(sl_tape_drain(e, 0, drained.data(), kQ, nullptr) == 0);
    sl_tape_record_stop(e, 0);
    sl_render_io(e, ins, 4, outs, 2, kQ);

    // --- MONO fans out to both sides on playback ----------------------------
    CHECK(sl_tape_set_record_source(e, 1, 0, 2, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 1);
    for (uint32_t i = 0; i < kQ; ++i) inA[i] = 0.75f;
    sl_render_io(e, ins, 4, outs, 2, kQ);
    sl_tape_set_loop(e, 1, 1, 0, 0);
    sl_tape_record_stop(e, 1);
    sl_render_io(e, ins, 4, outs, 2, kQ); // handoff block
    for (uint32_t i = 0; i < kQ; ++i) {
        CHECK(l[i] == 0.75f);
        CHECK(r[i] == 0.75f);
    }
    sl_tape_trigger(e, 1, 2); // park it so it stops summing into main

    // --- THE CAP (D-WZ-DECK-01) ---------------------------------------------
    // Set AFTER record_start, which seeds the signed default for the take's
    // channel count. Recording must stop itself exactly at the cap, light the
    // flag, and leave the audio intact and loopable — a bounded stop, not a
    // glitch and not a lost take.
    CHECK(sl_tape_set_record_source(e, 2, 0, 2, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 2);
    const uint64_t cap = kQ + 10; // mid-block, so the cut lands inside a render
    sl_tape_set_record_cap_frames(e, 2, cap);
    CHECK(sl_tape_record_cap_reached(e, 2) == 0);
    for (uint32_t i = 0; i < kQ; ++i) inA[i] = 0.5f;
    sl_render_io(e, ins, 4, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 2) == kQ);
    sl_render_io(e, ins, 4, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 2) == cap);              // stopped exactly at the cap
    CHECK(sl_tape_record_cap_reached(e, 2) == 1);    // and said so
    CHECK(sl_tape_state(e, 2) == 0);                 // stopped itself, cleanly
    sl_render_io(e, ins, 4, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 2) == cap);              // and stays put
    // The audio is fine — that is the point of a cap rather than a crash.
    sl_tape_set_loop(e, 2, 1, 0, cap);
    sl_tape_trigger(e, 2, 0);
    sl_render_io(e, ins, 4, outs, 2, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.5f);
    sl_tape_trigger(e, 2, 2);
    sl_render_io(e, ins, 4, outs, 2, kQ);

    // Cap 0 restores the signed 256 MB default for the tape's channels.
    sl_tape_set_record_cap_frames(e, 2, 0);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 2);
    for (int b = 0; b < 3; ++b) sl_render_io(e, ins, 4, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 2) == 3 * kQ); // no longer capped at kQ+10
    sl_tape_record_stop(e, 2);
    sl_render_io(e, ins, 4, outs, 2, kQ);

    // --- LAW C-2: the stamp delta between two takes IS the real gap ---------
    // This is the whole point of one monotonic clock: drop both files at 0:00
    // in a DAW and the session reproduces, because realignment is a pure
    // subtraction rather than a guess about when each file started.
    CHECK(sl_tape_set_record_source(e, 4, 0, 2, -1) == 1);
    CHECK(sl_tape_set_record_source(e, 5, 0, 3, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 4);
    sl_render_io(e, ins, 4, outs, 2, kQ);
    const uint64_t t4 = sl_engine_time_samples(e);
    constexpr int kGapBlocks = 5;
    for (int b = 0; b < kGapBlocks; ++b) sl_render_io(e, ins, 4, outs, 2, kQ);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 5);
    sl_render_io(e, ins, 4, outs, 2, kQ);
    const uint64_t stamp4 = sl_tape_record_stop(e, 4);
    const uint64_t stamp5 = sl_tape_record_stop(e, 5);
    CHECK(stamp5 - stamp4 == static_cast<uint64_t>(kGapBlocks + 1) * kQ);
    CHECK(stamp4 == t4 - kQ); // tape 4 was stamped at the block it armed into

    // The clock counts every rendered frame and nothing else — a refused
    // render advances it by zero, because it rendered zero.
    const uint64_t before = sl_engine_time_samples(e);
    sl_render(e, outs, 2, kQ * 4); // past the configured block → refused
    CHECK(sl_engine_time_samples(e) == before);
    sl_render(e, outs, 2, 0);
    CHECK(sl_engine_time_samples(e) == before);
    sl_render(e, outs, 2, kQ);
    CHECK(sl_engine_time_samples(e) == before + kQ);

    sl_engine_destroy(e);
    std::printf("sl_tape_record_test OK\n");
    return 0;
}
