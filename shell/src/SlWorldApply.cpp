#include "SlWorldApply.h"

#include "sl_engine.h"

#include <vector>

namespace wizard::sl {

namespace {

// scoopy WorldTrack field -> engine param NAME (kWorldScalarMap / kWorldArrayMap),
// GENERATED from the pinned worklet's SCALAR_FIELDS / ARRAY_FIELDS. Never edit
// here: `npm run worldmap:generate`, and CI's worldmap:check fails on drift.
#include "sl_worldmap.inc"

juce::var applied(bool ok, const juce::String& error) {
    auto* o = new juce::DynamicObject();
    o->setProperty("applied", ok);
    o->setProperty("error", error.isEmpty() ? juce::var() : juce::var(error));
    return juce::var(o);
}

} // namespace

bool registerSample(sl_engine* engine, const juce::var& sample) {
    if (engine == nullptr) return false;
    const auto id = sample.getProperty("id", juce::var()).toString();
    const auto* left = sample.getProperty("left", juce::var()).getArray();
    if (id.isEmpty() || left == nullptr || left->isEmpty()) return false;

    const auto frames = static_cast<uint32_t>(left->size());
    std::vector<float> l(frames);
    for (uint32_t i = 0; i < frames; ++i) l[i] = static_cast<float>((double) left->getReference((int) i));

    const auto* right = sample.getProperty("right", juce::var()).getArray();
    std::vector<float> r;
    const float* rp = nullptr;
    if (right != nullptr && right->size() == (int) frames) {
        r.resize(frames);
        for (uint32_t i = 0; i < frames; ++i) r[i] = static_cast<float>((double) right->getReference((int) i));
        rp = r.data();
    }

    const auto rate = (double) sample.getProperty("sampleRate", 48000.0);
    return sl_engine_register_sample(engine, id.toRawUTF8(), l.data(), rp, frames, rate) == 1;
}

juce::var applyWorld(sl_engine* engine, const juce::var& world) {
    if (engine == nullptr) return applied(false, "no engine");

    const auto deck = static_cast<uint32_t>((int) world.getProperty("deck", 0));
    const auto bpm = (double) world.getProperty("bpm", 120.0);
    const auto isPlaying = (bool) world.getProperty("isPlaying", false);
    const auto startStep = (int32_t) (int) world.getProperty("startStep", 0);

    if (sl_snapshot_begin(engine, deck, bpm, isPlaying ? 1 : 0, startStep) != 1)
        // Deck 0 only today (the ABI refuses >0 rather than aliasing) — report
        // it as the honest reason instead of a silent empty world.
        return applied(false, "snapshot_begin refused (deck " + juce::String((int) deck) +
                              " out of range — max is " + juce::String((int) sl_deck_count() - 1) + ")");

    const auto* tracks = world.getProperty("tracks", juce::var()).getArray();
    if (tracks == nullptr) return applied(false, "world.tracks missing or not an array");

    int index = 0;
    for (const auto& track : *tracks) {
        const auto sampleId = track.getProperty("sampleId", juce::var()).toString();
        const auto* steps = track.getProperty("steps", juce::var()).getArray();
        // A track with no sample or no steps would render silence that reads as
        // a broken engine — refuse the whole publish rather than commit a world
        // with a hole in it (worldFromSession.ts's own "never drop quietly" law).
        if (sampleId.isEmpty() || steps == nullptr || steps->isEmpty())
            return applied(false, "track " + juce::String(index) + " has no sampleId or no steps");

        std::vector<uint8_t> stepBytes(static_cast<size_t>(steps->size()));
        for (int i = 0; i < steps->size(); ++i)
            stepBytes[static_cast<size_t>(i)] = (int) steps->getReference(i) != 0 ? 1u : 0u;

        if (sl_snapshot_track_begin(engine, sampleId.toRawUTF8(), stepBytes.data(),
                                    static_cast<uint32_t>(stepBytes.size())) != 1)
            return applied(false, "track " + juce::String(index) + " (" + sampleId + ") could not begin");

        // The flat WorldTrack (worldFromSession.ts): each mapped scalar field the
        // track carries is renamed to its engine param and set. A field the
        // track doesn't carry is simply skipped (the engine keeps its default);
        // a field whose param the engine doesn't know resolves UNKNOWN and is
        // ignored — forward-compatible, never misread.
        for (int m = 0; m < SL_WORLD_SCALAR_MAP_COUNT; ++m) {
            const auto& map = kWorldScalarMap[m];
            if (!track.hasProperty(map.field)) continue;
            const int32_t id = sl_track_param_id(map.param);
            if (id != SL_PARAM_UNKNOWN)
                sl_snapshot_track_set(engine, id, (double) track.getProperty(map.field, 0.0));
        }

        // Per-step arrays, same rename; only actual arrays are applied.
        for (int m = 0; m < SL_WORLD_ARRAY_MAP_COUNT; ++m) {
            const auto& map = kWorldArrayMap[m];
            const auto* arr = track.getProperty(map.field, juce::var()).getArray();
            if (arr == nullptr) continue;
            const int32_t id = sl_track_array_id(map.param);
            if (id == SL_PARAM_UNKNOWN) continue;
            std::vector<double> values(static_cast<size_t>(arr->size()));
            for (int i = 0; i < arr->size(); ++i)
                values[static_cast<size_t>(i)] = (double) arr->getReference(i);
            sl_snapshot_track_set_array(engine, id, values.data(),
                                        static_cast<uint32_t>(values.size()));
        }

        sl_snapshot_track_end(engine);
        ++index;
    }

    const auto generation = sl_snapshot_commit(engine);
    if (generation == 0) return applied(false, "commit produced no world");
    return applied(true, {});
}

} // namespace wizard::sl
