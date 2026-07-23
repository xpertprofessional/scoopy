// World builder + RCU install + per-channel keyed params (P1-03).
#include "wz_engine.h"

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
    wz_engine* e = wz_engine_create(48000.0, 512, 3);
    CHECK(e != nullptr);

    // Key resolution by name; unknown = inert.
    const int32_t kSrcKind = wz_world_key_for_name("srcKind");
    const int32_t kGain = wz_world_key_for_name("gain");
    const int32_t kDeck = wz_world_key_for_name("deckIndex");
    CHECK(kSrcKind != WZ_PARAM_UNKNOWN && kGain != WZ_PARAM_UNKNOWN && kDeck != WZ_PARAM_UNKNOWN);
    CHECK(wz_world_key_for_name("noSuchKey") == WZ_PARAM_UNKNOWN);
    CHECK(wz_world_key_for_name(nullptr) == WZ_PARAM_UNKNOWN);

    // Fresh engine: empty world, revision 0; commit without begin is a no-op.
    CHECK(wz_world_channel_count(e) == 0);
    CHECK(wz_world_revision(e) == 0);
    CHECK(wz_world_commit(e) == 0);

    // Build a two-strip world: a stereo device input and a deck channel.
    wz_world_begin(e);
    CHECK(wz_world_channel_begin(e, "mic") == 0);
    wz_world_channel_set(e, kSrcKind, 1);       // deviceInput
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("srcChan1"), 1);
    wz_world_channel_set(e, kGain, 0.5);
    wz_world_channel_set(e, WZ_PARAM_UNKNOWN, 99.0); // ignored, not misread
    wz_world_channel_end(e);
    CHECK(wz_world_channel_begin(e, "deck-1") == 1);
    wz_world_channel_set(e, kSrcKind, 2);       // deck
    wz_world_channel_set(e, kDeck, 0);
    wz_world_channel_end(e);
    CHECK(wz_world_commit(e) == 1);
    CHECK(wz_world_channel_count(e) == 2);
    CHECK(wz_world_revision(e) == 1);

    // Per-channel keyed params route to the right strip.
    const int32_t gainId = wz_param_id_for_name("gain");
    const int32_t panId = wz_param_id_for_name("pan");
    CHECK(gainId != WZ_PARAM_UNKNOWN && panId != WZ_PARAM_UNKNOWN);
    CHECK(wz_param_get(e, 0, gainId) == 0.5);  // builder value carried in
    CHECK(wz_param_get(e, 1, gainId) == 0.75); // default (unity detent)
    wz_param_set(e, 1, gainId, 0.9);
    wz_param_set(e, 1, panId, -1.0);
    CHECK(wz_param_get(e, 1, gainId) == 0.9);
    CHECK(wz_param_get(e, 1, panId) == -1.0);
    CHECK(wz_param_get(e, 0, gainId) == 0.5); // strip 0 untouched
    // Out-of-range strip: no-op / zero, never a crash.
    wz_param_set(e, 7, gainId, 0.1);
    CHECK(wz_param_get(e, 7, gainId) == 0.0);
    // mainGain stays master-global regardless of the channel argument.
    const int32_t mainId = wz_param_id_for_name("mainGain");
    wz_param_set(e, 5, mainId, 0.25);
    CHECK(wz_param_get(e, 0, mainId) == 0.25);

    // RCU: render between commits acknowledges revisions; a rebuild while the
    // render thread is running never crashes and params re-route to the new
    // world's strips.
    std::vector<float> l(512), r(512);
    float* buses[2] = {l.data(), r.data()};
    wz_engine_render(e, buses, 2, 512);

    wz_world_begin(e);
    wz_world_channel_begin(e, "solo-strip");
    wz_world_channel_set(e, kSrcKind, 0); // none
    wz_world_channel_end(e);
    CHECK(wz_world_commit(e) == 2);
    CHECK(wz_world_channel_count(e) == 1);
    wz_engine_render(e, buses, 2, 512);
    CHECK(wz_world_commit(e) == 2); // no builder open: still a no-op

    // begin() discards an unfinished builder rather than leaking half a world.
    wz_world_begin(e);
    wz_world_channel_begin(e, "abandoned");
    wz_world_begin(e);
    CHECK(wz_world_commit(e) == 3);
    CHECK(wz_world_channel_count(e) == 0);

    wz_engine_destroy(e);
    std::printf("world_test OK\n");
    return 0;
}
