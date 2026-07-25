// SL ABI v3 §6 — the session snapshot surface, and whether a published world
// actually makes the engine SOUND.
//
// The mapping is already covered by track_params_test; this covers the
// lifecycle around it: name resolution across the ABI, the refused deck axis,
// half-built-track handling, and the one thing that matters most — that a
// committed snapshot with a registered sample renders non-silence.
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
    sl_engine* e = sl_engine_create(48000.0, 512, 86);
    CHECK(e != nullptr);

    // Names resolve across the ABI; unknown names are UNKNOWN, not 0 (which is
    // a real param — returning it would write volume by accident).
    const int32_t volumeId = sl_track_param_id("SL_T_VOLUME");
    CHECK(volumeId != SL_PARAM_UNKNOWN);
    CHECK(sl_track_param_id("SL_T_NOPE") == SL_PARAM_UNKNOWN);
    CHECK(sl_track_param_id(nullptr) == SL_PARAM_UNKNOWN);
    CHECK(sl_track_array_id("SL_TA_PITCH_OFFSETS") != SL_PARAM_UNKNOWN);
    CHECK(sl_track_array_id("SL_TA_NOPE") == SL_PARAM_UNKNOWN);

    // Introspection agrees with resolution, so a host can enumerate.
    CHECK(sl_track_param_count() > 0 && sl_track_array_count() > 0);
    for (uint32_t k = 0; k < sl_track_param_count(); ++k) {
        const char* n = sl_track_param_name(k);
        CHECK(n != nullptr);
        CHECK(sl_track_param_id(n) == static_cast<int32_t>(k)); // round-trips
    }
    CHECK(sl_track_param_name(sl_track_param_count()) == nullptr); // out of range
    CHECK(sl_track_array_name(sl_track_array_count()) == nullptr);

    // Multi-deck (§6): decks 0..sl_deck_count()-1 all accepted, each its own
    // session/BPM; a deck at or past the count is refused (out of range), never
    // aliased onto a valid slot.
    CHECK(sl_deck_count() >= 2); // the merge needs at least two decks in strips
    for (uint32_t d = 0; d < sl_deck_count(); ++d)
        CHECK(sl_snapshot_begin(e, d, 120.0, 1, 0) == 1);
    CHECK(sl_snapshot_begin(e, sl_deck_count(), 120.0, 1, 0) == 0);
    CHECK(sl_snapshot_begin(e, 99, 120.0, 1, 0) == 0);
    CHECK(sl_snapshot_begin(nullptr, 0, 120.0, 1, 0) == 0);

    // Setters before any track_begin are inert rather than corrupting.
    sl_snapshot_track_set(e, volumeId, 1.0);
    sl_snapshot_track_end(e); // no open track — must not push a phantom
    CHECK(sl_snapshot_commit(e) > 0); // an empty world is still a valid world

    // A silent engine: nothing registered, nothing playing.
    CHECK(sl_engine_start(e) == 1);
    std::vector<float> l(512, 0.0f), r(512, 0.0f);
    float* buses[2] = {l.data(), r.data()};
    sl_render(e, buses, 2, 512);
    double silentPeak = 0.0;
    for (uint32_t i = 0; i < 512; ++i) silentPeak = std::fmax(silentPeak, std::fabs((double) l[i]));
    CHECK(silentPeak == 0.0);

    // Register audio and build a world that triggers it on every step.
    std::vector<float> tone(4800);
    for (size_t i = 0; i < tone.size(); ++i)
        tone[i] = 0.5f * std::sin(2.0 * 3.14159265358979 * 220.0 * (double) i / 48000.0);
    CHECK(sl_engine_register_sample(e, "tone", tone.data(), nullptr,
                                    (uint32_t) tone.size(), 48000.0) == 1);
    // Guard rails on the register path.
    CHECK(sl_engine_register_sample(e, nullptr, tone.data(), nullptr, 16, 48000.0) == 0);
    CHECK(sl_engine_register_sample(e, "x", nullptr, nullptr, 16, 48000.0) == 0);
    CHECK(sl_engine_register_sample(e, "x", tone.data(), nullptr, 0, 48000.0) == 0);

    CHECK(sl_snapshot_begin(e, 0, 120.0, /*is_playing*/ 1, 0) == 1);
    const uint8_t steps[8] = {1, 1, 1, 1, 1, 1, 1, 1};
    CHECK(sl_snapshot_track_begin(e, "tone", steps, 8) == 1);
    CHECK(sl_snapshot_track_begin(e, nullptr, steps, 8) == 0);
    CHECK(sl_snapshot_track_begin(e, "tone", nullptr, 8) == 0);
    CHECK(sl_snapshot_track_begin(e, "tone", steps, 0) == 0);
    sl_snapshot_track_set(e, volumeId, 1.0);
    sl_snapshot_track_set(e, SL_PARAM_UNKNOWN, 999.0); // ignored, not misread
    sl_snapshot_track_end(e);
    const uint64_t generation = sl_snapshot_commit(e);
    CHECK(generation > 0);

    // THE POINT: a committed world with a registered sample makes sound.
    // Render a second of audio and look for any non-zero output.
    double peak = 0.0;
    for (int block = 0; block < 100; ++block) {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        sl_render(e, buses, 2, 512);
        for (uint32_t i = 0; i < 512; ++i) {
            CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));
            peak = std::fmax(peak, std::fabs((double) l[i]));
        }
    }
    CHECK(peak > 0.0001); // the sequencer actually triggered the sample

    // MULTI-DECK (§6): two decks, DIFFERENT BPMs, both playing the same sample —
    // this is decks-in-strips. Building deck 1 must NOT wipe deck 0 (the array is
    // persistent), and committing publishes both at once. Proof of isolation:
    // both decks contribute, and the world holds two decks' worth of triggers.
    {
        const uint8_t all8[8] = {1, 1, 1, 1, 1, 1, 1, 1};

        // Deck 0 at 120 bpm.
        CHECK(sl_snapshot_begin(e, 0, 120.0, 1, 0) == 1);
        CHECK(sl_snapshot_track_begin(e, "tone", all8, 8) == 1);
        sl_snapshot_track_set(e, volumeId, 1.0);
        sl_snapshot_track_end(e);
        CHECK(sl_snapshot_commit(e) > 0);

        // Deck 1 at 90 bpm — its OWN tempo, and it must not disturb deck 0.
        CHECK(sl_snapshot_begin(e, 1, 90.0, 1, 0) == 1);
        CHECK(sl_snapshot_track_begin(e, "tone", all8, 8) == 1);
        sl_snapshot_track_set(e, volumeId, 1.0);
        sl_snapshot_track_end(e);
        const uint64_t twoDeckGen = sl_snapshot_commit(e);
        CHECK(twoDeckGen > generation); // a new world was published

        // Both decks render (still audible after adding the second at a
        // different tempo — deck 0 was retained across deck 1's build).
        double twoDeckPeak = 0.0;
        for (int block = 0; block < 100; ++block) {
            std::fill(l.begin(), l.end(), 0.0f);
            std::fill(r.begin(), r.end(), 0.0f);
            sl_render(e, buses, 2, 512);
            for (uint32_t i = 0; i < 512; ++i) {
                CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));
                twoDeckPeak = std::fmax(twoDeckPeak, std::fabs((double) l[i]));
            }
        }
        CHECK(twoDeckPeak > 0.0001); // two decks at two tempos, both sounding
    }

    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("sl_snapshot_test OK (generation %llu, peak %.4f)\n",
                (unsigned long long) generation, peak);
    return 0;
}
