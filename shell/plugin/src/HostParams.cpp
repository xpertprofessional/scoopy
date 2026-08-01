#include "HostParams.h"

#include "sl_engine.h"

#include <cmath>

namespace wizard::plugin {

namespace {

/** The per-track targets, in layout order.
 *
 *  Spelled out rather than enumerated from sl_track_mod_count() on purpose:
 *  building the list from the ABI would look tidier and would mean a target
 *  APPENDED to the engine silently changed a released plugin's parameter
 *  layout — the one thing this file exists not to do. The engine name is
 *  resolved by name at construction, so a rename over there is a loud failure
 *  here rather than a lane quietly pointing at the wrong control.
 *
 *  Ranges are the domain each offset can usefully cover, matching what the
 *  donor's mod bank could reach: ±24 semitones of pitch, the filter's full
 *  ±100 tone span. The composed value is clamped in the engine, so a lane
 *  driven to its end cannot push a track past what the DSP accepts. */
struct TrackTarget {
    const char* engineName;
    const char* label;
    float min, max;
    const char* unit;
};

constexpr TrackTarget kTrackTargets[] = {
    {"pitch",  "Pitch",   -24.0f,  24.0f, "st"},
    {"volume", "Volume",   -1.0f,   1.0f, ""},
    {"pan",    "Pan",      -1.0f,   1.0f, ""},
    {"tone",   "Tone",   -100.0f, 100.0f, ""},
    {"send1",  "Send 1",   -1.0f,   1.0f, ""},
    {"send2",  "Send 2",   -1.0f,   1.0f, ""},
    {"send3",  "Send 3",   -1.0f,   1.0f, ""},
    {"send4",  "Send 4",   -1.0f,   1.0f, ""},
};

constexpr int kTrackTargetCount = (int) (sizeof(kTrackTargets) / sizeof(kTrackTargets[0]));

struct DeckTarget {
    const char* engineName;
    const char* label;
    float min, max;
    const char* unit;
};

constexpr DeckTarget kDeckTargets[] = {
    {"transpose", "Deck Transpose", -24.0f, 24.0f, "st"},
    {"texture",   "Deck Texture",    -1.0f,  1.0f, ""},
};

constexpr int kDeckTargetCount = (int) (sizeof(kDeckTargets) / sizeof(kDeckTargets[0]));

/** The master offset is in dB and the engine's is a multiplier — a multiplier
    so the plane's fader and the host's lane compose without either knowing the
    other's units, dB because that is what an automation lane over a level
    should feel like under the pen. Converted at the push. */
constexpr float kMasterRangeDb = 24.0f;

/** All parameters carry a version hint of 1: the layout is frozen, so there is
    never a second version to migrate from. */
constexpr int kParamVersionHint = 1;

juce::AudioParameterFloat* makeFloat(juce::StringRef id, juce::StringRef label,
                                     float min, float max, juce::StringRef unit) {
    juce::AudioParameterFloatAttributes attrs;
    if (unit.isNotEmpty()) attrs = attrs.withLabel(juce::String(unit));
    return new juce::AudioParameterFloat(
        juce::ParameterID{juce::String(id), kParamVersionHint}, juce::String(label),
        juce::NormalisableRange<float>(min, max), 0.0f, attrs);
}

} // namespace

HostParams::HostParams(juce::AudioProcessor& proc) {
    entries.reserve((size_t) (kAutomatedTracks * kTrackTargetCount + kDeckTargetCount + 1));

    // One group per track, so a DAW's parameter browser shows sixteen tidy
    // folders instead of a flat list of 128.
    for (int t = 0; t < kAutomatedTracks; ++t) {
        const auto trackTag = juce::String::formatted("t%02d", t);
        // 1-based in anything a human reads; 0-based in the id, which addresses
        // the engine's track index directly.
        const auto trackLabel = juce::String::formatted("T%02d", t + 1);
        auto group = std::make_unique<juce::AudioProcessorParameterGroup>(
            "d0." + trackTag, "Track " + juce::String(t + 1), "|");

        for (const auto& target : kTrackTargets) {
            const int32_t modId = sl_track_mod_id_for_name(target.engineName);
            // A target this plugin declares but the engine does not answer would
            // be a lane that moves nothing — the exact silent-unreachable shape
            // nativemethods:check exists to catch on the web side. Fail loudly
            // in debug; in release the lane is simply not declared, which is at
            // least honest about what the host can reach.
            jassert(modId != SL_PARAM_UNKNOWN);
            if (modId == SL_PARAM_UNKNOWN) continue;

            auto* param = makeFloat("d0." + trackTag + "." + target.engineName,
                                    trackLabel + " " + target.label,
                                    target.min, target.max, target.unit);
            entries.push_back({param, Scope::track, t, modId});
            group->addChild(std::unique_ptr<juce::AudioParameterFloat>(param));
        }
        proc.addParameterGroup(std::move(group));
    }

    {
        auto group = std::make_unique<juce::AudioProcessorParameterGroup>("d0.deck", "Deck", "|");
        for (const auto& target : kDeckTargets) {
            const int32_t modId = sl_deck_mod_id_for_name(target.engineName);
            jassert(modId != SL_PARAM_UNKNOWN);
            if (modId == SL_PARAM_UNKNOWN) continue;
            auto* param = makeFloat(juce::String("d0.") + target.engineName, target.label,
                                    target.min, target.max, target.unit);
            entries.push_back({param, Scope::deck, 0, modId});
            group->addChild(std::unique_ptr<juce::AudioParameterFloat>(param));
        }

        auto* master = makeFloat("master.level", "Master Level",
                                 -kMasterRangeDb, kMasterRangeDb, "dB");
        entries.push_back({master, Scope::master, 0, 0});
        group->addChild(std::unique_ptr<juce::AudioParameterFloat>(master));
        proc.addParameterGroup(std::move(group));
    }
}

void HostParams::pushToEngine(sl_engine* e) noexcept {
    if (e == nullptr) return;
    for (auto& entry : entries) {
        const float v = static_cast<juce::AudioParameterFloat*>(entry.param)->get();
        // NaN-seeded, so the first block after construction or a state restore
        // pushes everything and every block after that pushes only what moved.
        if (v == entry.lastSent) continue;
        entry.lastSent = v;
        switch (entry.scope) {
            case Scope::track:
                sl_track_mod_set(e, (uint32_t) kAutomationDeck, (uint32_t) entry.track,
                                 entry.modId, (double) v);
                break;
            case Scope::deck:
                sl_deck_mod_set(e, (uint32_t) kAutomationDeck, entry.modId, (double) v);
                break;
            case Scope::master:
                // dB → the engine's gain multiplier. std::pow, but only on the
                // block where the lane actually moved.
                sl_master_set_mod(e, juce::Decibels::decibelsToGain((double) v));
                break;
        }
    }
}

juce::var HostParams::writeState() const {
    auto* out = new juce::DynamicObject();
    for (const auto& entry : entries) {
        auto* param = static_cast<juce::AudioParameterFloat*>(entry.param);
        const float v = param->get();
        if (v == 0.0f) continue; // neutral — the default a missing key restores as
        out->setProperty(param->paramID, (double) v);
    }
    return juce::var(out);
}

void HostParams::readState(const juce::var& stored) {
    auto* obj = stored.getDynamicObject();
    for (auto& entry : entries) {
        auto* param = static_cast<juce::AudioParameterFloat*>(entry.param);
        // Absent (or no stored object at all) means neutral, NOT "leave as is":
        // a processor being handed a project's state must end up holding that
        // project's values and nothing left over from the one before it.
        double v = 0.0;
        if (obj != nullptr && obj->hasProperty(param->paramID))
            v = (double) obj->getProperty(param->paramID);
        if (!std::isfinite(v)) v = 0.0;
        param->setValueNotifyingHost(
            param->convertTo0to1(juce::jlimit(param->range.start, param->range.end, (float) v)));
    }
}

bool HostParams::announceTouch(int track, const juce::String& target) {
    const int32_t modId = sl_track_mod_id_for_name(target.toRawUTF8());
    if (modId == SL_PARAM_UNKNOWN) return false;
    for (auto& entry : entries) {
        if (entry.scope != Scope::track || entry.track != track || entry.modId != modId)
            continue;
        if (entry.announced) return false; // already shown to the host
        entry.announced = true;
        // An EMPTY pair: begin, then end, with no performEdit between them. That
        // is the whole trick — enough for a host to learn which parameter was
        // touched, and not enough for it to write anything.
        entry.param->beginChangeGesture();
        entry.param->endChangeGesture();
        return true;
    }
    return false;
}

juce::RangedAudioParameter* HostParams::find(juce::StringRef paramId) const {
    for (const auto& entry : entries)
        if (static_cast<juce::AudioParameterFloat*>(entry.param)->paramID == paramId)
            return entry.param;
    return nullptr;
}

} // namespace wizard::plugin
