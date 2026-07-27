// scoopy's slCommand boot handshake, tested headlessly (no WebView, no display).
//
// Proves the merged shell answers the commands scoopy's UI issues at boot with
// the shared reply envelope, backs settings with real persistence, and refuses
// the not-yet-implemented rest honestly rather than faking success.
#include "SlDispatch.h"
#include "SlWorldApply.h"
#include "sl_engine.h"

#include <cstdio>
#include <cmath>
#include <map>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
using namespace wizard::sl;

/** In-memory store — proves the dispatcher persists without a file. */
class FakeSettings final : public SettingsStore {
public:
    juce::var get(const juce::String& key) const override {
        auto it = map.find(key);
        return it == map.end() ? juce::var() : it->second;
    }
    void set(const juce::String& key, const juce::var& value) override { map[key] = value; }
    bool has(const juce::String& key) const override { return map.count(key) != 0; }
    std::map<juce::String, juce::var> map;
};

bool replyOk(const juce::var& r) { return r.getProperty("ok", false); }
juce::var result(const juce::var& r) { return r.getProperty("result", juce::var()); }
} // namespace

int main() {
    FakeSettings settings;

    // getCapabilities — the handshake. schemaVersion must be scoopy's (87), or
    // its UI shows a mismatch banner. The host's real capabilities, not
    // aspirational ones.
    {
        const auto r = dispatch("getCapabilities", juce::var(), settings, nullptr);
        CHECK(replyOk(r));
        const auto caps = result(r);
        CHECK((int) caps.getProperty("schemaVersion", 0) == 87); // scoopy SCHEMA_VERSION
        CHECK((bool) caps.getProperty("fileSystem", false) == true);
        CHECK((bool) caps.getProperty("audioDeviceSelection", false) == true);
        CHECK((bool) caps.getProperty("pluginHosting", true) == false);
        CHECK((bool) caps.getProperty("midiHardware", true) == false);
        CHECK((bool) caps.getProperty("returnFx", true) == false);
        // The exported helper agrees with the dispatched answer.
        CHECK((int) capabilities().getProperty("schemaVersion", 0) == 87);
    }

    // An unset key reads as null (value present, null) — NOT absent, NOT a
    // fabricated default. The UI needs "unset" to be distinguishable.
    {
        const auto r = dispatch("getSetting",
            juce::JSON::parse(R"({"key":"theme.tokens"})"), settings, nullptr);
        CHECK(replyOk(r));
        CHECK(result(r).hasProperty("value"));
        CHECK(result(r).getProperty("value", "x").isVoid()); // null on the wire
    }

    // setSetting persists; getSetting reads it back verbatim, structure intact.
    {
        const auto set = dispatch("setSetting",
            juce::JSON::parse(R"({"key":"deck.volume","value":0.8})"), settings, nullptr);
        CHECK(replyOk(set));
        const auto got = dispatch("getSetting",
            juce::JSON::parse(R"({"key":"deck.volume"})"), settings, nullptr);
        CHECK(replyOk(got));
        CHECK((double) result(got).getProperty("value", 0.0) == 0.8);

        // An object value survives round-trip (theme tokens are objects).
        dispatch("setSetting",
            juce::JSON::parse(R"({"key":"theme.tokens","value":{"accent":"#abc","n":3}})"), settings, nullptr);
        const auto obj = result(dispatch("getSetting",
            juce::JSON::parse(R"({"key":"theme.tokens"})"), settings, nullptr)).getProperty("value", juce::var());
        CHECK(obj.getProperty("accent", "").toString() == "#abc");
        CHECK((int) obj.getProperty("n", 0) == 3);
    }

    // An explicit null value is a CLEAR, distinct from an absent key in the
    // payload — getProperty's default must not paper over the difference.
    {
        dispatch("setSetting", juce::JSON::parse(R"({"key":"k","value":5})"), settings, nullptr);
        CHECK(settings.has("k"));
        dispatch("setSetting", juce::JSON::parse(R"({"key":"k","value":null})"), settings, nullptr);
        CHECK(settings.has("k")); // still set, now to null
        CHECK(settings.get("k").isVoid());
    }

    // getSettings returns only keys that exist — a missing key is omitted, not
    // echoed as null, so the UI keeps "unset" meaning unset.
    {
        settings.set("a", 1);
        settings.set("b", juce::var("two"));
        const auto r = dispatch("getSettings",
            juce::JSON::parse(R"({"keys":["a","b","missing"]})"), settings, nullptr);
        CHECK(replyOk(r));
        const auto values = result(r).getProperty("values", juce::var());
        CHECK((int) values.getProperty("a", 0) == 1);
        CHECK(values.getProperty("b", "").toString() == "two");
        CHECK(!values.hasProperty("missing"));
    }

    // getUiState is a safe empty default (state arrives via the push lane).
    {
        const auto r = dispatch("getUiState",
            juce::JSON::parse(R"({"topic":"background"})"), settings, nullptr);
        CHECK(replyOk(r));
        CHECK(result(r).getDynamicObject() != nullptr); // an object, empty
    }

    // Malformed params are refused, not crashed.
    CHECK(!replyOk(dispatch("getSetting", juce::var(), settings, nullptr)));       // no key
    CHECK(!replyOk(dispatch("setSetting", juce::JSON::parse(R"({"value":1})"), settings, nullptr))); // no key
    CHECK(!replyOk(dispatch("getSettings", juce::JSON::parse(R"({"keys":"x"})"), settings, nullptr))); // keys not array

    // The not-yet-implemented surface refuses honestly — ok:false with a reason
    // naming the method — rather than faking success (which scoopy's UI would
    // believe). A representative sample the boot path touches.
    for (const char* m : {"worldPublish", "gridEdit", "publishMenuTree",
                          "enumerateAudioDevices", "listPlugins", "fileBrowser"}) {
        const auto r = dispatch(m, juce::var(), settings, nullptr);
        CHECK(!replyOk(r));
        CHECK(r.getProperty("error", "").toString().contains(m));
    }

    // worldPublish ROUTING (the applier itself is covered by sl_world_apply_test).
    // With a real engine, a flat `world` object routes through and applies; the
    // Option-B contract is enforced — a stock PatternFile `json` string, which
    // this host does not parse, is refused with a reason.
    {
        sl_engine* e = sl_engine_create(48000.0, 512, 86);
        CHECK(e != nullptr);
        std::vector<float> tone(4800);
        for (size_t i = 0; i < tone.size(); ++i)
            tone[i] = 0.4f * std::sin(2.0 * 3.14159265358979 * 220.0 * (double) i / 48000.0);
        auto* left = new juce::Array<juce::var>();
        for (float v : tone) left->add((double) v);
        auto* s = new juce::DynamicObject();
        s->setProperty("id", "tone");
        s->setProperty("left", juce::var(*left));
        CHECK(registerSample(e, juce::var(s)));
        delete left;

        auto world = juce::JSON::parse(R"({"world":{"deck":0,"bpm":120,"isPlaying":true,
            "startStep":0,"tracks":[{"sampleId":"tone","steps":[1,1,1,1],"volume":1.0}]}})");
        const auto r = dispatch("worldPublish", world, settings, e);
        CHECK(replyOk(r));
        CHECK((bool) result(r).getProperty("applied", false));

        // Contract: a PatternFile string (stock scoopy shape) is refused here.
        const auto stock = dispatch("worldPublish",
            juce::JSON::parse(R"({"json":"<PatternFile>"})"), settings, e);
        CHECK(!replyOk(stock));

        sl_engine_destroy(e);
    }

    // ── The plane's strip surface (merge P2 step 4) ──────────────────────────
    {
        sl_engine* e = sl_engine_create(48000.0, 512, 87);
        CHECK(e != nullptr);

        // WITHOUT AN ENGINE, every engine-backed plane command refuses by name
        // rather than crashing on a null. The UI's boot path catches refusals;
        // a segfault is not something it can catch.
        for (const char* m : {"slChannel", "slTape", "slRoute", "slRouteList", "slRecord"}) {
            const auto r = dispatch(m, juce::var(), settings, nullptr);
            CHECK(!replyOk(r));
            CHECK(r.getProperty("error", "").toString().contains(m));
        }

        // An unknown action is refused rather than silently doing nothing. One
        // zod object serves every action, so this combination check exists ONLY
        // here — a typo'd action that returned ok would be a control that looks
        // wired and is not.
        CHECK(!replyOk(dispatch("slChannel",
                                juce::JSON::parse(R"({"action":"nope","channel":0})"),
                                settings, e)));
        CHECK(!replyOk(dispatch("slTape", juce::JSON::parse(R"({"action":"nope","tape":0})"),
                                settings, e)));
        CHECK(!replyOk(dispatch("slRoute", juce::JSON::parse(R"({"action":"nope"})"),
                                settings, e)));

        // A channel binding REPORTS the engine's refusal instead of assuming
        // success: kind 9 does not exist, and a strip silently bound to nothing
        // would render silence with no explanation anywhere in the UI.
        const auto bad = dispatch("slChannel",
                                  juce::JSON::parse(R"({"action":"setSource","channel":0,"kind":9,"index":0})"),
                                  settings, e);
        CHECK(replyOk(bad));
        CHECK(!(bool) result(bad).getProperty("ok", true));

        const auto good = dispatch("slChannel",
                                   juce::JSON::parse(R"({"action":"setSource","channel":0,"kind":1,"index":0})"),
                                   settings, e);
        CHECK((bool) result(good).getProperty("ok", false));
        CHECK(sl_channel_source_kind(e, 0) == 1);

        // Level and mute reach the engine.
        dispatch("slChannel", juce::JSON::parse(R"({"action":"setLevel","channel":0,"level":0.25})"),
                 settings, e);
        CHECK(sl_channel_level(e, 0) == 0.25);
        dispatch("slChannel", juce::JSON::parse(R"({"action":"setMute","channel":0,"muted":true})"),
                 settings, e);
        CHECK(sl_channel_muted(e, 0) == 1);
        dispatch("slChannel", juce::JSON::parse(R"({"action":"setSend","channel":0,"send":2,"level":0.5})"),
                 settings, e);
        CHECK(sl_channel_send(e, 0, 2) == 0.5);

        // slRouteList reports one entry PER SLOT (active or not), which is the
        // shape captureRoutes() consumes, plus the render order.
        {
            const auto r = dispatch("slRouteList", juce::var(), settings, e);
            CHECK(replyOk(r));
            const auto* routes = result(r).getProperty("routes", juce::var()).getArray();
            CHECK(routes != nullptr);
            CHECK(routes->size() == (int) sl_route_capacity());
            const auto* order = result(r).getProperty("renderOrder", juce::var()).getArray();
            CHECK(order != nullptr && order->size() == (int) sl_channel_count());
            // A fresh engine boots with the DEFAULT wiring installed, and it is
            // flagged — the plane draws no cable for a default, so every cable
            // on screen is one the user made.
            int actives = 0, defaults = 0;
            for (const auto& v : *routes) {
                if ((bool) v.getProperty("active", false)) ++actives;
                if ((bool) v.getProperty("isDefault", false)) ++defaults;
            }
            CHECK(actives > 0 && defaults == actives);
        }

        // clearAll then add: the document-load path. A REFUSED add is reported
        // as ok:false in the RESULT, not as a failed command — the commonest
        // refusal is "that would close a cycle", which the UI answers by
        // offering a feedback edge rather than by catching an exception.
        dispatch("slRoute", juce::JSON::parse(R"({"action":"clearAll"})"), settings, e);
        CHECK(sl_route_count_active(e) == 0);
        const auto added = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":2,"dstIndex":0,"gain":1.0})"),
            settings, e);
        CHECK(replyOk(added));
        CHECK((bool) result(added).getProperty("ok", false));
        CHECK(sl_route_count_active(e) == 1);

        // A cycle is refused UNLESS consented to. 0→1 then 1→0 closes a loop.
        dispatch("slRoute", juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":0,"dstIndex":1,"gain":1.0})"),
                 settings, e);
        const auto cyc = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":1.0})"),
            settings, e);
        CHECK(!(bool) result(cyc).getProperty("ok", true)); // refused, no feedback flag
        const auto consented = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":1.0,"feedback":true})"),
            settings, e);
        CHECK((bool) result(consented).getProperty("ok", false)); // honoured when asked for

        // wouldCycle answers the same question WITHOUT patching, so the UI can
        // explain the refusal before making it.
        const auto wc = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"wouldCycle","srcIndex":1,"dstIndex":0})"), settings, e);
        CHECK(replyOk(wc));

        // A tape's waveform over an EMPTY tape returns empty arrays rather than
        // a column of zeros — zeros would draw as real silence at full width.
        const auto wave = dispatch("slTape",
            juce::JSON::parse(R"({"action":"waveform","tape":0,"channel":0,"columns":64})"), settings, e);
        CHECK(replyOk(wave));
        CHECK(result(wave).getProperty("min", juce::var()).getArray() != nullptr);
        // columns must be > 0 — a zero-column request is a UI bug, not a
        // silently-empty waveform.
        CHECK(!replyOk(dispatch("slTape",
            juce::JSON::parse(R"({"action":"waveform","tape":0,"channel":0,"columns":0})"), settings, e)));

        const auto info = dispatch("slTape", juce::JSON::parse(R"({"action":"info","tape":0})"),
                                   settings, e);
        CHECK(replyOk(info));
        CHECK((int) result(info).getProperty("state", -1) == 0); // idle

        // RECORDING WITHOUT A RECORD SERVICE refuses honestly. This is the state
        // the merged shell is in if its drain thread fails to start, and the
        // state every headless caller is in — a fake success would open no file
        // and lose the take silently.
        CHECK(!replyOk(dispatch("slRecord", juce::JSON::parse(R"({"action":"start","tape":0})"),
                                settings, e, nullptr)));
        CHECK(!replyOk(dispatch("slTakes", juce::JSON::parse(R"({"action":"list"})"),
                                settings, e, nullptr)));

        // The source picker's data needs the DEVICE layer, which a headless
        // harness does not have. Refused by name rather than answered with an
        // empty device list — "no devices" and "no device layer" are different
        // facts, and a picker showing an empty list would look like a machine
        // with no inputs.
        CHECK(!replyOk(dispatch("slDevices", juce::JSON::parse(R"({"action":"list"})"),
                                settings, e, nullptr)));

        // With a HostServices carrying a takes directory but no recorder, take
        // ENUMERATION still works — reading the disk needs no drain thread, and
        // a user must be able to see yesterday's takes even if today's audio
        // device never opened.
        {
            wizard::sl::HostServices svc;
            svc.takesDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                               .getChildFile("sl_dispatch_test_takes").getFullPathName().toStdString();
            const auto r = dispatch("slTakes", juce::JSON::parse(R"({"action":"list"})"),
                                    settings, e, &svc);
            CHECK(replyOk(r));
            CHECK(result(r).getProperty("takes", juce::var()).getArray() != nullptr);
            // Recording still refuses — there is no service to write with.
            CHECK(!replyOk(dispatch("slRecord", juce::JSON::parse(R"({"action":"start","tape":0})"),
                                    settings, e, &svc)));
        }

        sl_engine_destroy(e);
    }

    std::printf("sl_dispatch_test OK\n");
    return 0;
}
