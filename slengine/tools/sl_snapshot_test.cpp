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

// The generated frame layout — the deck playhead slots are how this test
// observes a deck's tempo (see stepCrossings below), same as sl_hotframe_test.
#include "sl_hotframe.inc"

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

/** How many STEP BOUNDARIES deck `deck` crosses over `blocks` rendered blocks.
 *
 * The deck-scope tempo params are only really testable through this. Reading
 * back what we wrote proves a variable holds a value; counting step crossings
 * proves the engine is actually running the deck faster, which is the claim.
 * Robust to the step index wrapping, because it counts CHANGES rather than
 * differencing the counter. */
static int stepCrossings(sl_engine* e, uint32_t deck, float* const* buses, int blocks) {
    std::vector<double> frame(sl_hotframe_length());
    const uint32_t slot = deck == 0   ? SL_HF_playheadStepDeck0
                          : deck == 1 ? SL_HF_playheadStepDeck1
                                      : SL_HF_playheadStepDeck2;
    double last = -1.0;
    int crossings = 0;
    for (int b = 0; b < blocks; ++b) {
        sl_render(e, buses, 2, 512);
        if (sl_hotframe(e, frame.data(), (uint32_t) frame.size()) == 0) continue;
        if (last >= 0.0 && frame[slot] != last) ++crossings;
        last = frame[slot];
    }
    return crossings;
}

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

        // Master sync: lock deck 1 (90 bpm) to a 120 master → ratio 120/90.
        // Invalid inputs are ignored (no crash, no corruption); a valid ratio
        // republishes and the deck keeps rendering (audible tempo change is a
        // human-pass, but the plumbing must hold).
        sl_deck_set_tempo_sync(nullptr, 1, 1.33);          // null engine
        sl_deck_set_tempo_sync(e, 99, 1.33);               // out of range
        sl_deck_set_tempo_sync(e, 1, 0.0);                 // non-positive ratio
        sl_deck_set_tempo_sync(e, 1, 120.0 / 90.0);        // valid: sync to 120
        double syncedPeak = 0.0;
        for (int block = 0; block < 60; ++block) {
            std::fill(l.begin(), l.end(), 0.0f);
            sl_render(e, buses, 2, 512);
            for (uint32_t i = 0; i < 512; ++i) syncedPeak = std::fmax(syncedPeak, std::fabs((double) l[i]));
        }
        CHECK(syncedPeak > 0.0001); // still sounding after the sync republish

        // ── DECK SCOPE (§3) ────────────────────────────────────────────────
        //
        // THE REGRESSION THIS SECTION EXISTS FOR. `sl_snapshot_begin` used to
        // reset tempoSyncRatio to 1.0, so every world publish — which is what
        // editing one step in the grid does — silently un-synced every synced
        // deck. The plane carried a re-assert pass to survive it. Deck-scope
        // params outlive a publish, so the re-assert can go away.
        //
        // Mutation check: restore that reset in sl_snapshot_begin and the
        // survival CHECK below fails.
        const int32_t syncId  = sl_param_id_for_name("syncRatio");
        const int32_t modeId  = sl_param_id_for_name("tempoMode");
        const int32_t rateId  = sl_param_id_for_name("rate");
        const int32_t transId = sl_param_id_for_name("transpose");
        const int32_t texId   = sl_param_id_for_name("texture");
        CHECK(syncId != SL_PARAM_UNKNOWN);
        CHECK(modeId != SL_PARAM_UNKNOWN);
        CHECK(rateId != SL_PARAM_UNKNOWN);
        CHECK(transId != SL_PARAM_UNKNOWN);
        CHECK(texId != SL_PARAM_UNKNOWN);
        CHECK(sl_param_id_for_name("nosuchparam") == SL_PARAM_UNKNOWN);
        CHECK(sl_param_id_for_name(nullptr) == SL_PARAM_UNKNOWN);

        // Name/id introspection round-trips for every declared param — a host
        // enumerating the surface must get back what it resolved.
        CHECK(sl_param_count() == 5);
        for (uint32_t k = 0; k < sl_param_count(); ++k) {
            const char* nm = sl_param_name(k);
            CHECK(nm != nullptr);
            CHECK(sl_param_id_for_name(nm) == (int32_t) k);
        }
        CHECK(sl_param_name(sl_param_count()) == nullptr); // out of range

        // The alias and the param are ONE value, not two that must be kept in
        // step — that is what makes the old spelling safe to keep.
        sl_param_set(e, 1, syncId, 1.5);
        CHECK(sl_deck_tempo_sync(e, 1) == 1.5);
        sl_deck_set_tempo_sync(e, 1, 120.0 / 90.0);
        CHECK(sl_param_get(e, 1, syncId) == 120.0 / 90.0);

        // Refusals: each leaves the previous value standing rather than landing
        // somewhere else. An unknown mode must NOT be rounded into a real one.
        sl_param_set(e, 1, syncId, -1.0);           // non-positive ratio
        sl_param_set(e, 1, modeId, 7.0);            // not a mode
        sl_param_set(e, 1, rateId, 0.0);            // non-positive rate
        sl_param_set(e, 1, transId, NAN);           // not a number
        sl_param_set(e, 1, 99, 1.0);                // unknown id
        sl_param_set(e, 99, syncId, 1.0);           // out-of-range deck
        sl_param_set(nullptr, 1, syncId, 1.0);      // null engine
        CHECK(sl_param_get(e, 1, syncId) == 120.0 / 90.0);
        CHECK(sl_param_get(e, 1, modeId) == 1.0);   // still timeStretch
        CHECK(sl_param_get(e, 1, rateId) == 1.0);
        CHECK(sl_param_get(e, 1, transId) == 0.0);
        CHECK(sl_param_get(e, 1, 99) == 0.0);       // unknown id reads 0, not a neighbour
        CHECK(sl_param_get(nullptr, 1, syncId) == 0.0);

        // Transpose is one of two params with a REALTIME setter: it round-trips
        // and the deck keeps sounding, but it never republishes — nothing here
        // can observe a world swap, which is exactly the property that matters.
        sl_param_set(e, 1, transId, -5.0);          // negative IS valid (down a fourth)
        CHECK(sl_param_get(e, 1, transId) == -5.0);
        sl_param_set(e, 1, transId, 0.0);

        // TEXTURE (WIN) — the donor's deckBusTexture, realtime like transpose.
        // Unlike transpose it is BOUNDED, and out of [0,1] is REFUSED rather
        // than clamped: a UI showing 1.7 when the engine took 1.0 is the silent
        // half-landing this seam's gate exists to prevent.
        CHECK(sl_param_get(e, 1, texId) == 0.0);    // defaults tight
        sl_param_set(e, 1, texId, 0.62);
        CHECK(sl_param_get(e, 1, texId) == 0.62);
        sl_param_set(e, 1, texId, 1.7);             // above range → refused
        sl_param_set(e, 1, texId, -0.1);            // below range → refused
        sl_param_set(e, 1, texId, NAN);             // not a number → refused
        CHECK(sl_param_get(e, 1, texId) == 0.62);   // all three left it standing
        sl_param_set(e, 1, texId, 1.0);             // the bounds themselves ARE valid
        CHECK(sl_param_get(e, 1, texId) == 1.0);
        sl_param_set(e, 1, texId, 0.0);
        CHECK(sl_param_get(e, 1, texId) == 0.0);

        // BOTH realtime params reset with the deck. They live as core atomics
        // rather than in the world, so clearing the world does NOT clear them —
        // miss this and the next strip in the slot inherits the last one's pitch
        // and grain. Checked on deck 2 so deck 1's run below is untouched.
        sl_param_set(e, 2, transId, 7.0);
        sl_param_set(e, 2, texId, 0.9);
        CHECK(sl_param_get(e, 2, transId) == 7.0);
        CHECK(sl_param_get(e, 2, texId) == 0.9);
        sl_deck_clear(e, 2);
        CHECK(sl_param_get(e, 2, transId) == 0.0);
        CHECK(sl_param_get(e, 2, texId) == 0.0);

        // SKIP-STEP — a request applied at the next step boundary inside
        // render(), so there is nothing to read back here: the property that
        // matters is that it is REFUSED cleanly and never corrupts the deck.
        // (Where the playhead lands is the walk's job, not the ABI's.)
        sl_deck_skip_step(nullptr, 1, 4);            // null engine
        sl_deck_skip_step(e, 99, 4);                 // out-of-range deck
        sl_deck_skip_step(e, 1, -1);                 // negative step
        sl_deck_skip_step(e, 1, 8);                  // valid
        {
            double afterSeekPeak = 0.0;
            for (int block = 0; block < 20; ++block) {
                std::fill(l.begin(), l.end(), 0.0f);
                sl_render(e, buses, 2, 512);
                for (uint32_t i = 0; i < 512; ++i) {
                    CHECK(std::isfinite(l[i]));
                    afterSeekPeak = std::fmax(afterSeekPeak, std::fabs((double) l[i]));
                }
            }
            CHECK(afterSeekPeak > 0.0001); // still sounding after the jump
        }

        // ── THE RATIO IS OBSERVED IN THE AUDIO, NOT READ BACK ──────────────
        //
        // Reading `sl_param_get` back only proves a variable holds a value. The
        // first version of this test did exactly that, and a mutation restoring
        // the old `d.tempoSyncRatio = 1.0` reset PASSED it — the param block
        // survived while the world it was supposed to reach did not. Counting
        // step crossings asks the engine instead.
        //
        // It also pins the DIRECTION, which was wrong in the shipped code:
        // `DeckWorld.tempoSyncRatio` is output/input DURATION, so a deck told to
        // run at 2× needs 0.5 there. Callers were passing 2.0 and getting a deck
        // at HALF speed. If the inversion in applyDeckParams is dropped, `faster`
        // comes back SLOWER than `base` and these fail.
        const int kMeasureBlocks = 400;

        sl_param_set(e, 1, modeId, 2.0);      // tempoOnly: the step clock alone
        sl_param_set(e, 1, syncId, 1.0);
        const int base = stepCrossings(e, 1, buses, kMeasureBlocks);
        CHECK(base > 4); // the deck is running at all

        sl_param_set(e, 1, syncId, 2.0);      // twice as fast
        const int faster = stepCrossings(e, 1, buses, kMeasureBlocks);
        CHECK(faster > base * 3 / 2); // ~2×, generously bounded against jitter

        // ── RE-SENDING AN UNCHANGED PARAM DOES NOT REPUBLISH ────────────────
        //
        // The plane pushes a deck's whole tempo axis on every change rather than
        // diffing locally, so one keystroke in the master tempo box arrives as
        // 3 sets per grid strip — nearly all of them the value already held.
        // A publish deep-copies every deck's snapshot and retains the old world
        // until the audio thread acknowledges, so that churn is not free.
        //
        // Counted through the COMMIT GENERATION, which increments once per
        // publish. No getter for it exists and none is added: an ABI point that
        // only a test uses is the dead ABI the coverage gate is for.
        {
            const uint64_t before = sl_snapshot_commit(e);
            sl_param_set(e, 1, syncId, sl_param_get(e, 1, syncId));   // same ratio
            sl_param_set(e, 1, modeId, sl_param_get(e, 1, modeId));   // same mode
            sl_param_set(e, 1, rateId, sl_param_get(e, 1, rateId));   // same rate
            const uint64_t after = sl_snapshot_commit(e);
            // Exactly ONE publish — this commit. Six unchanged sets published
            // nothing. Remove the `==` guards in sl_param_set and this is 4.
            CHECK(after == before + 1);

            // A CHANGED value still publishes, or the guard would be a bug that
            // silently stops sync working rather than an optimisation.
            const uint64_t base2 = sl_snapshot_commit(e);
            sl_param_set(e, 1, syncId, 1.75);
            const uint64_t moved = sl_snapshot_commit(e);
            CHECK(moved == base2 + 2); // the param's publish, then this commit
            CHECK(sl_param_get(e, 1, syncId) == 1.75);
            sl_param_set(e, 1, syncId, 2.0); // back to what the checks below expect
        }

        // THE SURVIVAL CHECK. Republish deck 1's session — the exact gesture a
        // grid edit makes — and the deck must STILL be running at 2×. Before
        // deck scope this is where it silently dropped back to its own tempo.
        CHECK(sl_snapshot_begin(e, 1, 90.0, 1, 0) == 1);
        CHECK(sl_snapshot_track_begin(e, "tone", all8, 8) == 1);
        sl_snapshot_track_set(e, volumeId, 1.0);
        sl_snapshot_track_end(e);
        CHECK(sl_snapshot_commit(e) > 0);
        CHECK(sl_param_get(e, 1, syncId) == 2.0);
        const int afterPublish = stepCrossings(e, 1, buses, kMeasureBlocks);
        CHECK(afterPublish > base * 3 / 2);

        // ALL THREE MODES REACH THE MASTER, each by its own mechanism. This is
        // the user-visible claim of the whole domain — "every element follows
        // the master" — and it is the assertion that would catch `applyDeckParams`
        // routing a ratio into a field that mode does not use, which would look
        // like a deck that simply ignores sync in one mode out of three.
        //
        //   timeStretch  the bus stretcher consumes source faster
        //   timePitch    masterSpeed AND the voice varispeed together
        //   tempoOnly    masterSpeed alone (measured as `faster`, above)
        //
        // What is NOT asserted here is the PITCH difference between them, and
        // that is deliberate rather than an omission: the modes differ in
        // spectral content, not in any scalar this tier can read, so proving it
        // is a listening test. The routing being right is what makes the
        // listening test meaningful, and that is what this checks.
        sl_param_set(e, 1, modeId, 1.0); // timeStretch
        const int stretched = stepCrossings(e, 1, buses, kMeasureBlocks);
        CHECK(stretched > base * 3 / 2);

        sl_param_set(e, 1, modeId, 0.0); // timePitch
        const int varispeeded = stepCrossings(e, 1, buses, kMeasureBlocks);
        CHECK(varispeeded > base * 3 / 2);

        // And every mode goes BACK to the deck's own tempo when sync is
        // released — a mode that could only ever speed a deck up would strand
        // it there, which is worse than never having synced it.
        for (double mode : {0.0, 1.0, 2.0}) {
            sl_param_set(e, 1, modeId, mode);
            sl_param_set(e, 1, syncId, 1.0);
            const int released = stepCrossings(e, 1, buses, kMeasureBlocks);
            CHECK(released < base * 3 / 2);
            sl_param_set(e, 1, syncId, 2.0);
        }
        sl_param_set(e, 1, syncId, 2.0);

        // Every mode renders finite audio, with a standalone `rate` on top.
        for (double mode : {0.0, 1.0, 2.0}) {
            sl_param_set(e, 1, modeId, mode);
            sl_param_set(e, 1, rateId, 1.25);
            double modePeak = 0.0;
            for (int block = 0; block < 40; ++block) {
                std::fill(l.begin(), l.end(), 0.0f);
                sl_render(e, buses, 2, 512);
                for (uint32_t i = 0; i < 512; ++i) {
                    CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));
                    modePeak = std::fmax(modePeak, std::fabs((double) l[i]));
                }
            }
            CHECK(modePeak > 0.0001); // sounding in every tempo mode
        }
        sl_param_set(e, 1, modeId, 1.0);
        sl_param_set(e, 1, rateId, 1.0);
        sl_param_set(e, 1, syncId, 1.0);

        // A strip dropping its deck: clear deck 1 (it goes silent); deck 0 is
        // retained. Out-of-range/null clears are ignored.
        sl_deck_clear(nullptr, 1);
        sl_deck_clear(e, 99);
        sl_deck_clear(e, 1);   // remove the second deck
        double afterClear = 0.0;
        for (int block = 0; block < 60; ++block) {
            std::fill(l.begin(), l.end(), 0.0f);
            sl_render(e, buses, 2, 512);
            for (uint32_t i = 0; i < 512; ++i) afterClear = std::fmax(afterClear, std::fabs((double) l[i]));
        }
        CHECK(afterClear > 0.0001); // deck 0 still plays after deck 1 was cleared
    }

    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("sl_snapshot_test OK (generation %llu, peak %.4f)\n",
                (unsigned long long) generation, peak);
    return 0;
}
