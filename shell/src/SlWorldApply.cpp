#include "SlWorldApply.h"

#include "sl_engine.h"

#include <vector>

namespace wizard::sl {

namespace {

juce::var applied(bool ok, const juce::String& error) {
    auto* o = new juce::DynamicObject();
    o->setProperty("applied", ok);
    o->setProperty("error", error.isEmpty() ? juce::var() : juce::var(error));
    return juce::var(o);
}

/** Set every {name: value} in an object on the open track, resolving each name
    through the ABI. `resolve` is the scalar or array id lookup; `apply` sets it.
    An unknown name resolves to SL_PARAM_UNKNOWN and is skipped — the engine's
    own setters would ignore it anyway, but skipping here keeps the intent
    (forward-compatible, never misread) visible at the boundary. */
template <typename Resolve, typename Apply>
void setAll(const juce::var& fields, Resolve resolve, Apply apply) {
    auto* obj = fields.getDynamicObject();
    if (obj == nullptr) return;
    for (const auto& kv : obj->getProperties()) {
        const int32_t id = resolve(kv.name.toString().toRawUTF8());
        if (id != SL_PARAM_UNKNOWN) apply(id, kv.value);
    }
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
                              " — only deck 0 is supported on this host)");

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

        setAll(track.getProperty("params", juce::var()),
               [](const char* n) { return sl_track_param_id(n); },
               [engine](int32_t id, const juce::var& v) {
                   sl_snapshot_track_set(engine, id, (double) v);
               });

        setAll(track.getProperty("arrays", juce::var()),
               [](const char* n) { return sl_track_array_id(n); },
               [engine](int32_t id, const juce::var& v) {
                   const auto* arr = v.getArray();
                   if (arr == nullptr) return;
                   std::vector<double> values(static_cast<size_t>(arr->size()));
                   for (int i = 0; i < arr->size(); ++i)
                       values[static_cast<size_t>(i)] = (double) arr->getReference(i);
                   sl_snapshot_track_set_array(engine, id, values.data(),
                                               static_cast<uint32_t>(values.size()));
               });

        sl_snapshot_track_end(engine);
        ++index;
    }

    const auto generation = sl_snapshot_commit(engine);
    if (generation == 0) return applied(false, "commit produced no world");
    return applied(true, {});
}

} // namespace wizard::sl
