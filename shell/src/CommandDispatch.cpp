#include "CommandDispatch.h"

#include "WZProtocol.h"
#include "wz_engine.h"

namespace wizard::command {

namespace {

juce::var ok(juce::var result) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("ok", true);
    obj->setProperty("result", std::move(result));
    return juce::var(obj);
}

juce::var fail(const juce::String& error) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("ok", false);
    obj->setProperty("error", error);
    return juce::var(obj);
}

// Capability handshake — the UI mounts panels from this. Every flag is a
// forward-looking seam wired false until its phase: processCapture (P2 taps),
// virtualDevice (P5 "Wizard Out"), pluginHosting (P6), audioDeviceSelection
// (P0-11 device layer). fileSystem is true — the shell owns native dialogs.
juce::var capabilities() {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("schemaVersion", wz::protocol::kSchemaVersion);
    obj->setProperty("processCapture", false);
    obj->setProperty("virtualDevice", false);
    obj->setProperty("pluginHosting", false);
    obj->setProperty("fileSystem", true);
    obj->setProperty("audioDeviceSelection", false);
    return juce::var(obj);
}

} // namespace

juce::var dispatch(wz_engine* engine, const juce::String& method, const juce::var& params) {
    if (method == "ping") {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("pong", true);
        return ok(juce::var(obj));
    }

    if (method == "getCapabilities")
        return ok(capabilities());

    if (method == "publishWorld") {
        const auto patch = params.getProperty("patch", juce::var());
        const auto channels = patch.getProperty("channels", juce::var());
        if (!channels.isArray()) return fail("publishWorld: patch.channels missing");

        // Resolve world field keys BY NAME once per dispatch (cheap, and keeps
        // the no-hardcoded-ids law intact on this side of the boundary too).
        const auto kSrcKind = wz_world_key_for_name("srcKind");
        const auto kSrcChan0 = wz_world_key_for_name("srcChan0");
        const auto kSrcChan1 = wz_world_key_for_name("srcChan1");
        const auto kToMonitor = wz_world_key_for_name("toMonitor");
        const auto kGain = wz_world_key_for_name("gain");
        const auto kPan = wz_world_key_for_name("pan");
        const auto kMute = wz_world_key_for_name("mute");
        const auto kSolo = wz_world_key_for_name("solo");
        const auto kDeckIndex = wz_world_key_for_name("deckIndex");

        // Schema enum order (SourceKindSchema) → numeric srcKind.
        const auto kindIndex = [](const juce::String& kind) -> int {
            const char* names[] = {"none", "deviceInput", "deck", "appTap",
                                   "systemMixExcept", "virtualDeviceInput", "busTap"};
            for (int i = 0; i < 7; ++i)
                if (kind == names[i]) return i;
            return 0; // unknown kind renders silent (preserve-don't-drop: the
                      // document keeps it; the engine just has nothing to play)
        };

        wz_world_begin(engine);
        const auto decks = patch.getProperty("decks", juce::var());
        wz_world_set_deck_count(
            engine, decks.isArray() ? static_cast<uint32_t>(decks.getArray()->size()) : 0u);
        for (const auto& chVar : *channels.getArray()) {
            const auto key = chVar.getProperty("key", "").toString();
            wz_world_channel_begin(engine, key.toRawUTF8());
            const auto source = chVar.getProperty("source", juce::var());
            const auto kind = source.getProperty("kind", "none").toString();
            wz_world_channel_set(engine, kSrcKind, kindIndex(kind));
            if (kind == "deviceInput") {
                // id is "L[,R]" device input channel indices; "3" = mono pick.
                const auto id = source.getProperty("id", "").toString();
                const auto l = id.upToFirstOccurrenceOf(",", false, false);
                const auto r = id.fromFirstOccurrenceOf(",", false, false);
                wz_world_channel_set(engine, kSrcChan0, l.isEmpty() ? -1 : l.getIntValue());
                wz_world_channel_set(engine, kSrcChan1, r.isEmpty() ? -1 : r.getIntValue());
            } else if (kind == "deck") {
                const auto id = source.getProperty("id", "").toString();
                wz_world_channel_set(engine, kDeckIndex, id.isEmpty() ? -1 : id.getIntValue());
            }
            wz_world_channel_set(engine, kToMonitor,
                                 static_cast<bool>(chVar.getProperty("toMonitor", false)) ? 1.0 : 0.0);
            wz_world_channel_set(engine, kGain, static_cast<double>(chVar.getProperty("gain", 0.75)));
            wz_world_channel_set(engine, kPan, static_cast<double>(chVar.getProperty("pan", 0.0)));
            wz_world_channel_set(engine, kMute,
                                 static_cast<bool>(chVar.getProperty("mute", false)) ? 1.0 : 0.0);
            wz_world_channel_set(engine, kSolo,
                                 static_cast<bool>(chVar.getProperty("solo", false)) ? 1.0 : 0.0);
            wz_world_channel_end(engine);
        }
        const auto revision = wz_world_commit(engine);

        auto* result = new juce::DynamicObject();
        result->setProperty("revision", static_cast<juce::int64>(revision));
        return ok(juce::var(result));
    }

    if (method == "deckTrigger") {
        const auto deck = static_cast<uint32_t>(static_cast<int>(params.getProperty("deck", 0)));
        const auto mode = params.getProperty("mode", "stop").toString();
        uint32_t m = 2; // stop
        if (mode == "loop") m = 0;
        else if (mode == "oneShot") m = 1;
        else if (mode == "stop") m = 2;
        else if (mode == "retrigger") m = 3;
        else return fail("deckTrigger: unknown mode " + mode);
        wz_deck_trigger(engine, deck, m);
        return ok(juce::var(new juce::DynamicObject()));
    }

    if (method == "deckSetLoop") {
        const auto deck = static_cast<uint32_t>(static_cast<int>(params.getProperty("deck", 0)));
        const auto enabled = static_cast<bool>(params.getProperty("enabled", false));
        const auto start = static_cast<uint64_t>(
            static_cast<juce::int64>(params.getProperty("startSample", 0)));
        const auto end = static_cast<uint64_t>(
            static_cast<juce::int64>(params.getProperty("endSample", 0)));
        wz_deck_set_loop(engine, deck, enabled ? 1u : 0u, start, end);
        return ok(juce::var(new juce::DynamicObject()));
    }

    return fail("unknown method: " + method);
}

} // namespace wizard::command
