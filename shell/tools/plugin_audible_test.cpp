// A PLUGIN IS AUDIBLE ON A RETURN (P6-3) — the wet half of the send/return
// story, proven with a REAL AudioUnit.
//
// plane_audio_test proves the TRANSPORT (strip sends reach the send lanes) but
// links the stub plugin host, where wet is silence by construction. This gate
// links the real NativePluginHost.mm — the same object the app compiles — and
// drives the whole chain: device input → strip 0 → post-fader send 1 → the
// P6-3 pre-seed → the core's host return 1 → Apple's AUDelay → wet summed
// into MAIN.
//
// THE ASSERTION THAT CANNOT BE FAKED: the input stops, and main keeps
// sounding. Nothing else in this engine can produce energy after the input is
// silent, the tape stopped and no world published — a delay tail on main IS
// the plugin's wet output.
//
// Skips (exit 77, ctest SKIP_RETURN_CODE) when the AU cannot be found — the
// honest shape for a CI box without Apple's AUs; a dev Mac always has them.
#include "SlDispatch.h"
#include "NativePluginHost.hpp"
#include "sl_engine.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <cmath>
#include <cstdio>
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

constexpr uint32_t kQ = 256;
constexpr double kRate = 48000.0;
// Through returnWet1R (AudioLane): main 0/1 · sends 2–5 · cue 6/7 · deck 8/9 ·
// deckA-C 10–15 · returnWet1 16/17 — the wet stem lane doubles as this
// harness's mid-chain probe.
constexpr uint32_t kLanes = 18;
constexpr uint32_t kRetWet1L = 16;

double peak(const std::vector<float>& v) {
    double p = 0.0;
    for (float s : v) p = std::max(p, std::abs(static_cast<double>(s)));
    return p;
}
} // namespace

int main() {
    // The message loop the plugin lifecycle marshals on. A GUI initialiser in a
    // console binary is normal JUCE hosting — no window is ever created.
    juce::ScopedJuceInitialiser_GUI juceInit;

    // Find Apple's AUDelay IN-PROCESS (it is Apple's own; the crash-isolation
    // child exists for third-party plugins). Built into a KnownPluginList XML
    // and restored into the scanner — the same resolution path selectFxPlugin
    // uses, without a filesystem sweep.
    juce::AudioPluginFormatManager fm;
    juce::addDefaultFormatsToManager(fm);
    juce::AudioPluginFormat* au = nullptr;
    for (int i = 0; i < fm.getNumFormats(); ++i)
        if (fm.getFormat(i)->getName() == "AudioUnit") au = fm.getFormat(i);
    if (au == nullptr) { std::printf("SKIP: no AudioUnit format in this build\n"); return 77; }

    juce::OwnedArray<juce::PluginDescription> found;
    au->findAllTypesForFile(found, "AudioUnit:Effects/aufx,dely,appl");
    if (found.isEmpty()) { std::printf("SKIP: Apple AUDelay not present\n"); return 77; }
    const juce::String identifier = found[0]->createIdentifierString();

    scoopyloops::NativePluginScanner scanner;
    {
        juce::KnownPluginList kl;
        kl.addType(*found[0]);
        scanner.restoreFromXml(kl.createXml()->toString().toStdString());
    }

    FakeSettings settings;
    HostServices services;
    services.pluginScanner = &scanner;

    sl_engine* e = sl_engine_create(kRate, kQ, 87);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    auto cmd = [&](const char* method, const juce::String& json) {
        return dispatch(method, juce::JSON::parse(json), settings, e, &services);
    };

    std::vector<std::vector<float>> lane(kLanes, std::vector<float>(kQ, 0.0f));
    std::vector<float*> lanes;
    for (auto& l : lane) lanes.push_back(l.data());
    std::vector<std::vector<float>> input(2, std::vector<float>(kQ, 0.0f));
    std::vector<const float*> inputs;
    for (auto& i : input) inputs.push_back(i.data());

    double phase = 0.0;
    auto render = [&](double amp) {
        for (uint32_t i = 0; i < kQ; ++i) {
            const auto s = static_cast<float>(amp * std::sin(phase));
            phase += 2.0 * 3.14159265358979 * 220.0 / kRate;
            input[0][i] = s;
            input[1][i] = s;
        }
        for (auto& l : lane) std::fill(l.begin(), l.end(), 0.0f);
        sl_render_io(e, inputs.data(), 2, lanes.data(), kLanes, kQ);
    };

    // The plane's own shape, in the plane's own order (§1–§3 of
    // plane_audio_test): boot routes, ADD THE STRIP, patch the input in,
    // send 1 up.
    CHECK(replyOk(cmd("slRoute", R"({"action":"clearAll"})")));
    CHECK(replyOk(cmd("slRoute", R"({"action":"installDefaults"})")));
    CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":0,"kind":0,"index":0})")));
    CHECK(replyOk(cmd("slRoute",
        R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":0,"gain":1.0})")));
    // The monitor defaults CLOSED (the §3 feedback lesson) — open it, or the
    // strip is silent by design and this harness proves nothing.
    CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":0,"on":true})")));
    CHECK(replyOk(cmd("slChannel", R"({"action":"setSend","channel":0,"send":0,"level":1.0})")));

    // Transport sanity BEFORE the plugin: the strip is audible on main and its
    // send reaches lane 2 — if either fails the problem is not the plugin.
    double dryMain = 0.0, drySend = 0.0;
    for (int b = 0; b < 40; ++b) {
        render(0.5);
        dryMain = std::max(dryMain, peak(lane[0]));
        drySend = std::max(drySend, peak(lane[2]));
    }
    CHECK(dryMain > 0.05);
    CHECK(drySend > 0.05);

    // Load through the real dispatch door, then pump the message loop until the
    // async load lands (the name is the "loaded" signal, exactly as the panel
    // reads it).
    CHECK(replyOk(dispatch("selectFxPlugin",
        juce::JSON::parse(R"({"returnIndex":1,"identifier":")" + identifier + "\"}"),
        settings, e, &services)));
    char name[256] = {0};
    for (int i = 0; i < 500 && sl_fx_plugin_name(e, 1, name, sizeof(name)) == 0; ++i)
        juce::MessageManager::getInstance()->runDispatchLoopUntil(10);
    CHECK(sl_fx_plugin_name(e, 1, name, sizeof(name)) > 0);
    std::printf("loaded '%s', latency %.2f ms\n", name, sl_fx_plugin_latency_ms(e, 1));

    // Feed the tone long enough for AUDelay's tap (default ~1 s) to fill…
    double feedSend = 0.0, feedWet = 0.0;
    for (int b = 0; b < 260; ++b) {
        render(0.5);
        feedSend = std::max(feedSend, peak(lane[2]));
        feedWet = std::max(feedWet, peak(lane[kRetWet1L]));
    }
    // …then stop the input and let the strip's dry path fall silent.
    double tail = 0.0, tailWet = 0.0;
    for (int b = 0; b < 200; ++b) {
        render(0.0);
        if (b >= 20) {
            tail = std::max(tail, peak(lane[0])); // past any ramp-out
            tailWet = std::max(tailWet, peak(lane[kRetWet1L]));
        }
    }
    std::printf("probe: feedSend %.4f feedWet %.4f tailMain %.4f tailWet %.4f\n",
                feedSend, feedWet, tail, tailWet);
    // THE POINT: energy on main after the input died = the plugin's wet.
    CHECK(tail > 1e-3);

    // GRID-SIDE: the same proof for the other element kind. A tone world plays
    // on deck 0; a strip bound to that deck (`setSource kind:2`) raises its
    // send fader, which projects onto the core's deck-master send — consumed
    // by the return plugin IN-block (no feed needed; the core owns both ends).
    // Stop the WORLD, and the tail on main is the plugin ringing out the
    // deck's sends — the deck itself is silent.
    {
        juce::Array<juce::var> pcm;
        for (int i = 0; i < 4800; ++i)
            pcm.add(0.5 * std::sin(2.0 * 3.14159265358979 * 220.0 * i / kRate));
        auto* sample = new juce::DynamicObject();
        sample->setProperty("action", "registerSample");
        sample->setProperty("id", "tone");
        sample->setProperty("left", juce::var(pcm));
        sample->setProperty("sampleRate", kRate);
        CHECK(replyOk(dispatch("slWorld", juce::var(sample), settings, e, &services)));

        // Silence the tape strip's feed so the tail below is the DECK's alone.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSend","channel":0,"send":0,"level":0.0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":0,"on":false})")));

        CHECK(replyOk(dispatch("slWorld", juce::JSON::parse(
            R"({"action":"publish","world":{"deck":0,"bpm":120,"isPlaying":true,"startStep":0,
                "tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0}]}})"),
            settings, e, &services)));
        const auto bind = cmd("slChannel", R"({"action":"setSource","channel":1,"kind":2,"index":0})");
        CHECK(replyOk(bind));
        CHECK((bool) bind.getProperty("result", juce::var()).getProperty("ok", false));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSend","channel":1,"send":0,"level":1.0})")));

        for (int b = 0; b < 260; ++b) render(0.0); // the deck feeds the delay
        CHECK(replyOk(dispatch("slWorld", juce::JSON::parse(
            R"({"action":"publish","world":{"deck":0,"bpm":120,"isPlaying":false,"startStep":0,
                "tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0}]}})"),
            settings, e, &services)));
        double gridTail = 0.0;
        for (int b = 0; b < 200; ++b) {
            render(0.0);
            if (b >= 20) gridTail = std::max(gridTail, peak(lane[0]));
        }
        std::printf("probe: gridTail %.4f\n", gridTail);
        CHECK(gridTail > 1e-3);

        CHECK(replyOk(cmd("slChannel", R"({"action":"setSend","channel":1,"send":0,"level":0.0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":1,"kind":0,"index":0})")));
    }

    // Unload → the wet path is gone: feed and stop again, the tail must decay
    // to nothing once the already-rung delay line has been torn down. The tape
    // strip is re-armed first (the grid block silenced it) so the transport is
    // provably hot while the wet stays gone.
    CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":0,"on":true})")));
    CHECK(replyOk(cmd("slChannel", R"({"action":"setSend","channel":0,"send":0,"level":1.0})")));
    CHECK(replyOk(dispatch("selectFxPlugin",
        juce::JSON::parse(R"({"returnIndex":1,"identifier":null})"), settings, e, &services)));
    for (int i = 0; i < 200 && sl_fx_plugin_name(e, 1, name, sizeof(name)) != 0; ++i)
        juce::MessageManager::getInstance()->runDispatchLoopUntil(10);
    CHECK(sl_fx_plugin_name(e, 1, name, sizeof(name)) == 0);
    for (int b = 0; b < 260; ++b) render(0.5);
    double unloadedTail = 0.0;
    for (int b = 0; b < 200; ++b) {
        render(0.0);
        if (b >= 20) unloadedTail = std::max(unloadedTail, peak(lane[0]));
    }
    CHECK(unloadedTail < 1e-4);

    // Teardown per the destroyNow contract: message thread, before the engine.
    sl_fx_teardown(e);
    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("plugin_audible_test OK — a hosted AU sounded on return 1 and fell silent on unload\n");
    return 0;
}
