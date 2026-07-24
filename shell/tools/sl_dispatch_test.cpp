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

    // getCapabilities — the handshake. schemaVersion must be scoopy's (86), or
    // its UI shows a mismatch banner. The host's real capabilities, not
    // aspirational ones.
    {
        const auto r = dispatch("getCapabilities", juce::var(), settings, nullptr);
        CHECK(replyOk(r));
        const auto caps = result(r);
        CHECK((int) caps.getProperty("schemaVersion", 0) == 86);
        CHECK((bool) caps.getProperty("fileSystem", false) == true);
        CHECK((bool) caps.getProperty("audioDeviceSelection", false) == true);
        CHECK((bool) caps.getProperty("pluginHosting", true) == false);
        CHECK((bool) caps.getProperty("midiHardware", true) == false);
        CHECK((bool) caps.getProperty("returnFx", true) == false);
        // The exported helper agrees with the dispatched answer.
        CHECK((int) capabilities().getProperty("schemaVersion", 0) == 86);
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
            "startStep":0,"tracks":[{"sampleId":"tone","steps":[1,1,1,1],
            "params":{"SL_T_VOLUME":1.0}}]}})");
        const auto r = dispatch("worldPublish", world, settings, e);
        CHECK(replyOk(r));
        CHECK((bool) result(r).getProperty("applied", false));

        // Contract: a PatternFile string (stock scoopy shape) is refused here.
        const auto stock = dispatch("worldPublish",
            juce::JSON::parse(R"({"json":"<PatternFile>"})"), settings, e);
        CHECK(!replyOk(stock));

        sl_engine_destroy(e);
    }

    std::printf("sl_dispatch_test OK\n");
    return 0;
}
