// THE PLANE MAKES A SOUND — end to end, headless (merge P2 step 4).
//
// WHY THIS EXISTS, stated plainly. The plane shipped its first increment with
// 1225 green TS tests, 63 green ctest cases and every gate clean, and it did
// not make a single sound. Every one of those tests asserted that a function
// returned what it said it would; none asserted that pressing REC produced
// audio. "Tests pass" had been standing in for "it works".
//
// So this drives the EXACT command sequence the plane's UI issues — the same
// JSON, in the same order, through the same `wizard::sl::dispatch` the WebView
// calls — into a real engine, renders real blocks with a real input signal, and
// asserts on the SAMPLES THAT COME OUT. It is the closest a headless test can
// get to a person pressing the button, and it is the check that has to pass
// before anything is handed over.
//
// The sequence below is lifted from the UI, not invented:
//   PlanePanel.bootMap()  → slRoute clearAll · installDefaults · slRouteList
//   PlanePanel.addStrip() → slChannel setSource {kind:0}
//   Strip.onRecord()      → slChannel setSource {kind:1} · slRecord start
//   Strip.onRecord() stop → slRecord stop
//   Strip.trigger(0)      → slTape trigger {mode:0}
#include "RecordService.h"
#include "SlDispatch.h"
#include "SlTakeDrainSource.h"
#include "sl_engine.h"

#include <cmath>
#include <cstdio>
#include <filesystem>
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
constexpr uint32_t kLanes = 6;
constexpr uint32_t kInputs = 2;
/** HotFrame slot of deck 0's sequencer step (schema.ts HotFrameLayout).
    Restated by hand, like the other harnesses here: if the emitter and the
    schema ever disagree this must FAIL rather than move in lockstep with a
    regenerated header. */
constexpr int kPlayheadStepDeck0 = 2;

/** Peak magnitude across a buffer — "did anything come out of here". */
double peak(const std::vector<float>& v) {
    double p = 0.0;
    for (float s : v) p = std::max(p, std::abs(static_cast<double>(s)));
    return p;
}
} // namespace

int main() {
    FakeSettings settings;
    sl_engine* e = sl_engine_create(kRate, kQ, 87);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    // The output lanes and a synthetic device input. The input is a steady tone
    // rather than DC so a silent result cannot be mistaken for a DC-blocked one.
    std::vector<std::vector<float>> lane(kLanes, std::vector<float>(kQ, 0.0f));
    std::vector<float*> lanes;
    for (auto& l : lane) lanes.push_back(l.data());

    std::vector<std::vector<float>> input(kInputs, std::vector<float>(kQ, 0.0f));
    std::vector<const float*> inputs;
    for (auto& i : input) inputs.push_back(i.data());

    double phase = 0.0;
    auto fillInput = [&](double amp) {
        for (uint32_t i = 0; i < kQ; ++i) {
            const auto s = static_cast<float>(amp * std::sin(phase));
            phase += 2.0 * 3.14159265358979 * 220.0 / kRate;
            input[0][i] = s;
            input[1][i] = s;
        }
    };
    auto render = [&](double amp) {
        fillInput(amp);
        for (auto& l : lane) std::fill(l.begin(), l.end(), 0.0f);
        sl_render_io(e, inputs.data(), kInputs, lanes.data(), kLanes, kQ);
    };
    // A REAL record service, exactly as MergedMain's Backend builds one. Not a
    // stub: `slRecord` is half engine and half file, and the half that was
    // missing from the merged shell for the whole of increment 1 was the file
    // half. A harness that passed a null services pointer would keep proving
    // the engine works while the app still recorded nothing.
    const auto takesDir = std::filesystem::temp_directory_path() / "wz_plane_audio_test";
    std::filesystem::remove_all(takesDir);
    wizard::record::SlTakeDrainSource drainSource(e);
    wizard::record::Service recorder;
    CHECK(recorder.start(drainSource, takesDir.string()));
    HostServices services;
    services.recorder = &recorder;
    services.takesDir = takesDir.string();

    auto cmd = [&](const char* method, const juce::String& json) {
        return dispatch(method, juce::JSON::parse(json), settings, e, &services);
    };

    // ── 1. BOOT (PlanePanel → bootMap) ───────────────────────────────────────
    CHECK(replyOk(cmd("slRoute", R"({"action":"clearAll"})")));
    CHECK(replyOk(cmd("slRoute", R"({"action":"installDefaults"})")));
    const auto listed = cmd("slRouteList", "{}");
    CHECK(replyOk(listed));
    // The boot wiring is REAL routes and the plane captures them; if this is 0
    // the plane loads a map with no cables and the whole mixer is silent.
    CHECK(sl_route_count_active(e) > 0);

    // ── 2. ADD A STRIP (PlanePanel → addStrip) ───────────────────────────────
    CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":0,"kind":0,"index":0})")));

    // ── 3. THE INPUT MUST BE PATCHED IN ──────────────────────────────────────
    //
    // ⚠️ THE FINDING THIS TEST WAS WRITTEN TO CATCH. The strip's record source
    // is its own CHANNEL BUS (STRIP-MODEL: "recording is always capture this
    // strip's channel bus — one tap, one code path, every source"). A channel
    // carries its ELEMENT plus everything ROUTED INTO IT — so a strip with no
    // element and no input route carries silence, and pressing REC on it
    // records silence, perfectly and forever, with nothing anywhere saying why.
    //
    // "A device input is just a route into a strip" is what makes an input
    // element need no special case. It is ALSO what makes an input strip
    // impossible until something creates that route. The UI did not, so the
    // plane's own increment-1 goal — record from an input and hear it back —
    // was unreachable by construction.
    //
    // src kind 2 = deviceInput (index = L channel, sub = R), dst kind 0 =
    // channelIn.
    const auto patched = cmd(
        "slRoute",
        R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":0,"gain":1.0})");
    CHECK(replyOk(patched));
    CHECK((bool) patched.getProperty("result", juce::var()).getProperty("ok", false));

    // ⚠️ AND IT ARRIVES SILENT, WHICH IS THE FIX FOR THE FEEDBACK BUG.
    //
    // This assertion used to read `peak > 0.05` — a strip arrived with its input
    // patched AND audible, and nothing could turn it off: `M` mutes the channel
    // OUTPUT, so the only control that stopped the feedback also killed the tape.
    // With a mic on the input that is a loop you cannot break without deleting
    // the strip.
    //
    // The monitor now defaults CLOSED (sl_channel.h, Channel::monitor). The
    // cable is still there and REC still captures through it; what changed is
    // that hearing it is a decision.
    for (int b = 0; b < 16; ++b) render(0.5); // more than the ramp needs
    CHECK(peak(lane[0]) < 1e-3);
    CHECK(peak(lane[1]) < 1e-3);

    // Open the monitor and the SAME cable is audible, with nothing else touched.
    CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":0,"on":true})")));
    CHECK(sl_channel_monitor(e, 0) == 1u);
    for (int b = 0; b < 8; ++b) render(0.5); // let the monitor's ramp settle
    CHECK(peak(lane[0]) > 0.05);
    CHECK(peak(lane[1]) > 0.05);

    // And the channel's own meter sees it, which is what the strip's meter draws.
    render(0.5);
    CHECK(sl_channel_peak_l(e, 0) > 0.05);

    // ── 3b. RE-POINTING THE INPUT CHANGES WHAT THE STRIP HEARS ───────────────
    //
    // Increment 2's whole claim. The source picker removes the deviceInput
    // cable into this channel and patches the chosen one — a remove/add rather
    // than an edit, because endpoints are what identify a route.
    //
    // Proven by feeding the two input channels DIFFERENT signals: input 0 hot
    // and input 1 silent. Re-pointing the strip at input 1 alone must make it
    // go quiet. Testing with identical signals on both would pass whether the
    // repatch worked or not.
    {
        auto renderSplit = [&](double amp0, double amp1) {
            for (uint32_t i = 0; i < kQ; ++i) {
                const auto s = std::sin(phase);
                phase += 2.0 * 3.14159265358979 * 220.0 / kRate;
                input[0][i] = static_cast<float>(amp0 * s);
                input[1][i] = static_cast<float>(amp1 * s);
            }
            for (auto& l : lane) std::fill(l.begin(), l.end(), 0.0f);
            sl_render_io(e, inputs.data(), kInputs, lanes.data(), kLanes, kQ);
        };

        // Point the strip at input 1 ONLY (mono, sub = none).
        for (uint32_t id = 0; id < sl_route_capacity(); ++id)
            if (sl_route_active(e, id) != 0 && sl_route_source_kind(e, id) == 2 &&
                sl_route_dest_kind(e, id) == 0 && sl_route_dest_index(e, id) == 0)
                sl_route_remove(e, id);
        const auto toIn1 = cmd(
            "slRoute",
            R"({"action":"add","srcKind":2,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":1.0})");
        CHECK(replyOk(toIn1));
        CHECK((bool) toIn1.getProperty("result", juce::var()).getProperty("ok", false));

        // Hot on input 0, silent on input 1 → the strip must be QUIET.
        for (int b = 0; b < 24; ++b) renderSplit(0.5, 0.0);
        double wrongInput = 0.0;
        for (int b = 0; b < 8; ++b) { renderSplit(0.5, 0.0); wrongInput = std::max(wrongInput, peak(lane[0])); }
        CHECK(wrongInput < 1e-3);

        // Now put the signal on input 1 → the SAME strip is loud, with nothing
        // else changed. That is the picker doing what it claims.
        for (int b = 0; b < 8; ++b) renderSplit(0.0, 0.5);
        double rightInput = 0.0;
        for (int b = 0; b < 8; ++b) { renderSplit(0.0, 0.5); rightInput = std::max(rightInput, peak(lane[0])); }
        CHECK(rightInput > 0.05);

        // Restore the stereo pair for the recording steps below.
        for (uint32_t id = 0; id < sl_route_capacity(); ++id)
            if (sl_route_active(e, id) != 0 && sl_route_source_kind(e, id) == 2)
                sl_route_remove(e, id);
        CHECK(replyOk(cmd(
            "slRoute",
            R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":0,"gain":1.0})")));
        for (int b = 0; b < 24; ++b) render(0.5);
    }

    // ── 4. REC (Strip → onRecord) ────────────────────────────────────────────
    // The UI binds the channel to the new tape first, then starts. Binding
    // FIRST matters: the record source is the channel bus, and a channel bound
    // to nothing has no bus to capture.
    CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":0,"kind":1,"index":0})")));
    // sourceKind 0 = deviceInput, chan0 = the INPUT channel.
    //
    // ⚠️ THIS USED TO BE channelBus (kind 2), and the change is the split tap.
    // A strip with a live input now records the input DIRECTLY, so the take no
    // longer depends on whether the user happens to be monitoring: capture and
    // monitoring stopped being the same signal path. A strip with no live input
    // still records its channel bus, which is where the "one tap" argument
    // still holds and where routed material is captured from.
    //
    // ONE command does the whole order-critical sequence — set source,
    // pre-allocate, arm, open the file — which is why it is one command.
    const auto started = cmd(
        "slRecord",
        R"({"action":"start","tape":0,"sourceKind":0,"chan0":0,"chan1":-1,"sourceDesc":"test input"})");
    CHECK(replyOk(started));
    CHECK((bool) started.getProperty("result", juce::var()).getProperty("ok", false));

    // ── 5. CAPTURE ───────────────────────────────────────────────────────────
    const int kRecBlocks = 40;
    for (int b = 0; b < kRecBlocks; ++b) render(0.5);
    CHECK(sl_tape_state(e, 0) == 3); // recording

    const auto stopped0 = cmd("slRecord", R"({"action":"stop","tape":0})");
    CHECK(replyOk(stopped0));
    const auto stopRes = stopped0.getProperty("result", juce::var());
    render(0.0);
    // Law C-2: the take knows WHERE in the session it began. A zero here is the
    // stamp chain severed — the exact regression the whole chain exists to stop.
    const auto stamp = static_cast<uint64_t>(
        static_cast<double>(stopRes.getProperty("startEngineSample", 0.0)));
    CHECK(stamp > 0);
    // A REAL FILE, on disk, with a path the document can reference. Without
    // this the audio exists only in RAM and the strip's takeRef is a lie.
    const auto path = stopRes.getProperty("path", "").toString();
    CHECK(path.isNotEmpty());
    CHECK(std::filesystem::exists(path.toStdString()));
    CHECK(std::filesystem::file_size(path.toStdString()) > 1024);
    // The sidecar carries the stamp the take library reads back.
    CHECK(std::filesystem::exists(path.toStdString() + ".json"));

    // ── 6. IT LOOPS, AND IT IS AUDIBLE ───────────────────────────────────────
    const auto frames = sl_tape_frames(e, 0);
    CHECK(frames > 0);
    // Roughly what we fed it — a capture that is an order of magnitude short is
    // a drain that fell behind, not a take.
    CHECK(frames > static_cast<uint64_t>(kQ) * (kRecBlocks - 4));

    CHECK(replyOk(cmd("slTape", R"({"action":"setLoop","tape":0,"enabled":true,"start":0,"end":0})")));
    sl_tape_set_loop(e, 0, 1, 0, frames);
    CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":0})")));

    // Silence the input so anything on main can only be the TAPE playing back.
    // Without this the test would pass on the live input alone and prove
    // nothing about the recording.
    const auto beforeUnpatch = sl_route_count_active(e);
    for (uint32_t id = 0; id < sl_route_capacity(); ++id)
        if (sl_route_active(e, id) != 0 && sl_route_source_kind(e, id) == 2)
            sl_route_remove(e, id);
    CHECK(sl_route_count_active(e) < beforeUnpatch);
    for (int b = 0; b < 16; ++b) render(0.0); // ramp the unpatch out

    CHECK(sl_tape_state(e, 0) == 1); // looping
    double loudest = 0.0;
    for (int b = 0; b < 20; ++b) {
        render(0.0);
        loudest = std::max(loudest, peak(lane[0]));
    }
    // THE ASSERTION THE WHOLE FILE IS FOR: the strip is playing back what it
    // captured, out of the main bus, with no live input feeding it.
    CHECK(loudest > 0.05);

    // ── 7. THE CONTROLS DO SOMETHING AUDIBLE ─────────────────────────────────
    // Level. A fader that moves the document but not the mix is the defect this
    // catches, and it is invisible in any unit test.
    CHECK(replyOk(cmd("slChannel", R"({"action":"setLevel","channel":0,"level":0.1})")));
    for (int b = 0; b < 40; ++b) render(0.0); // ramp
    double quiet = 0.0;
    for (int b = 0; b < 20; ++b) { render(0.0); quiet = std::max(quiet, peak(lane[0])); }
    CHECK(quiet < loudest * 0.5);

    // Mute silences it.
    CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":0,"muted":true})")));
    for (int b = 0; b < 40; ++b) render(0.0);
    double muted = 0.0;
    for (int b = 0; b < 20; ++b) { render(0.0); muted = std::max(muted, peak(lane[0])); }
    CHECK(muted < 1e-3);

    CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":0,"muted":false})")));
    CHECK(replyOk(cmd("slChannel", R"({"action":"setLevel","channel":0,"level":1.0})")));
    for (int b = 0; b < 40; ++b) render(0.0);

    // Varispeed. Reverse must actually move the playhead the other way.
    const auto headBefore = sl_tape_playhead(e, 0);
    CHECK(replyOk(cmd("slTape", R"({"action":"setRate","tape":0,"rate":-1.0})")));
    for (int b = 0; b < 8; ++b) render(0.0);
    const auto headAfter = sl_tape_playhead(e, 0);
    CHECK(headAfter != headBefore);
    CHECK(sl_tape_rate(e, 0) == -1.0);

    // Stop.
    CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":2})")));
    for (int b = 0; b < 40; ++b) render(0.0);
    double stopped = 0.0;
    for (int b = 0; b < 10; ++b) { render(0.0); stopped = std::max(stopped, peak(lane[0])); }
    CHECK(stopped < 1e-3);

    // ── 8. THE WAVE FIELD HAS SOMETHING TO DRAW ──────────────────────────────
    const auto wave = cmd(
        "slTape", R"({"action":"waveform","tape":0,"channel":0,"startFrame":0,"endFrame":0,"columns":64})");
    CHECK(replyOk(wave));
    const auto* mx = wave.getProperty("result", juce::var()).getProperty("max", juce::var()).getArray();
    CHECK(mx != nullptr && mx->size() > 0);
    double waveMax = 0.0;
    for (const auto& v : *mx) waveMax = std::max(waveMax, std::abs(static_cast<double>(v)));
    // A wave of zeros over material that plays audibly means the UI draws a
    // flat line over a working tape.
    CHECK(waveMax > 0.01);

    // ── 9. A GRID DECK, THROUGH THE SAME ENGINE ──────────────────────────────
    //
    // The other half of the merge, and the one that was structurally missing:
    // `SlWorldApply` had been built and tested since P1 with ZERO callers,
    // because the web layer's world sink still pointed at the WASM worklet — an
    // Emscripten copy of this very core, running inside an app that has the
    // original. A grid strip could not mean anything until a world could reach
    // sl_engine, which is why it was never a UI task.
    //
    // This drives the sink's exact wire calls: register a sample, publish a
    // flat World, and assert the deck is audible out of the SAME main bus the
    // tape strip uses. One engine, one clock, one master.
    {
        // A tone the sequencer will trigger. Registered by ID — a world names
        // audio through this id alone, and a world naming a sample the engine
        // never received renders silence that looks like a broken engine.
        juce::Array<juce::var> pcm;
        for (int i = 0; i < 4800; ++i)
            pcm.add(0.5 * std::sin(2.0 * 3.14159265358979 * 220.0 * i / kRate));
        auto* sample = new juce::DynamicObject();
        sample->setProperty("action", "registerSample");
        sample->setProperty("id", "tone");
        sample->setProperty("left", juce::var(pcm));
        sample->setProperty("sampleRate", kRate);
        const auto reg = dispatch("slWorld", juce::var(sample), settings, e, &services);
        CHECK(replyOk(reg));
        CHECK((bool) reg.getProperty("result", juce::var()).getProperty("ok", false));

        // The flat World `worldFromSession` produces, sent as-is. `steps` is an
        // ARRAY here for the same reason the native sink converts it: a
        // Uint8Array would cross the bridge as an object and the applier would
        // read "no steps" and refuse.
        const auto world = juce::JSON::parse(
            R"({"action":"publish","world":{"deck":0,"bpm":120,"isPlaying":true,"startStep":0,
                "tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0}]}})");
        const auto pub = dispatch("slWorld", world, settings, e, &services);
        CHECK(replyOk(pub));
        const auto pubRes = pub.getProperty("result", juce::var());
        // A refusal is REPORTED, never swallowed — a silent no-op is
        // indistinguishable from a dead wire.
        CHECK((bool) pubRes.getProperty("applied", false));
        CHECK(pubRes.getProperty("error", juce::var()).isVoid() ||
              pubRes.getProperty("error", "").toString().isEmpty());

        // THE ASSERTION: the sequencer is audible on main, with the tape
        // stopped and the live input unpatched. Nothing else can be making this
        // sound.
        double gridLoud = 0.0;
        for (int b = 0; b < 120; ++b) {
            render(0.0);
            gridLoud = std::max(gridLoud, peak(lane[0]));
        }
        CHECK(gridLoud > 0.01);

        // ── MASTER SYNC, AND THE HAZARD IT USED TO SIT ON ───────────────────
        //
        // `deckSetTempoSync` was the one grid op with a real ABI point, and it
        // had been lumped in with the scene ops as "no ABI" — so a synced deck
        // would have loaded carrying whatever ratio the previous map left.
        //
        // ⚠️ THIS BLOCK USED TO ASSERT THE OPPOSITE, and the inversion is P3-2.
        // `sl_snapshot_begin` reset `tempoSyncRatio = 1.0`, so every world
        // publish — which is what editing one step in the grid does — silently
        // UN-SYNCED the deck, and the plane carried a re-assert pass to survive
        // it. The ratio is now DECK SCOPE (SL-ABI-V3 §3): the engine holds it in
        // a persistent param block and re-stamps it onto each rebuilt world, so
        // a session publish no longer touches the tempo axis. The re-assert pass
        // is gone with the hazard that required it.
        //
        // (`sl_deck_tempo_sync` reports the MUSICAL ratio the caller set —
        // target/deck. What lands on the deck's bus is its reciprocal, because
        // `DeckWorld.tempoSyncRatio` is output/input duration; `applyDeckParams`
        // is the one place that knows. Asserting on step counts here would be
        // asserting the wrong tier — sl_snapshot_test does that, against the
        // engine, where the rate is observable.)
        CHECK(replyOk(cmd("slDeck", R"({"action":"setTempoSync","deck":0,"ratio":2.0})")));
        CHECK(sl_deck_tempo_sync(e, 0) == 2.0);
        for (int b = 0; b < 20; ++b) render(0.0);

        // Republish exactly as the grid does when anything is edited…
        CHECK(replyOk(dispatch("slWorld", world, settings, e, &services)));
        // …and the sync IS STILL THERE. Reverting the deck-scope stamp in
        // sl_snapshot_begin fails this line.
        CHECK(sl_deck_tempo_sync(e, 0) == 2.0);

        // A second publish does not drift it either, and the deck stays audible
        // across all of it.
        CHECK(replyOk(dispatch("slWorld", world, settings, e, &services)));
        CHECK(sl_deck_tempo_sync(e, 0) == 2.0);
        double afterSync = 0.0;
        for (int b = 0; b < 120; ++b) { render(0.0); afterSync = std::max(afterSync, peak(lane[0])); }
        CHECK(afterSync > 0.01);

        // ── AND THE TAPES' SYNC SURVIVES A PUBLISH TOO (P3-2b-6) ────────────
        //
        // The tape's tempo axis is a strip-level intent applied via slTape
        // setRate/setTempoMode — a SESSION publish must not touch it, or the
        // deck hazard above returns wearing the other element's clothes: edit
        // one grid step, and every synced LOOP silently falls back to unity.
        // (Tape 0 already holds material and is looping from the tape section
        // of this test.)
        CHECK(replyOk(cmd("slTape", R"({"action":"setRate","tape":0,"rate":2.0})")));
        CHECK(replyOk(cmd("slTape", R"({"action":"setTempoMode","tape":0,"mode":1})")));
        CHECK(sl_tape_rate(e, 0) == 2.0);
        CHECK(sl_tape_tempo_mode(e, 0) == 1u);
        CHECK(replyOk(dispatch("slWorld", world, settings, e, &services)));
        CHECK(sl_tape_rate(e, 0) == 2.0);
        CHECK(sl_tape_tempo_mode(e, 0) == 1u);
        // …and the RATE actually reaches the reader: measured at the playhead,
        // which is the tier where "the tape follows the master" is observable.
        // (Warm-up may keep the stretcher dry here; the varispeed path measures
        // identically because the TIMELINE is the same in both modes.)
        CHECK(replyOk(cmd("slTape", R"({"action":"setTempoMode","tape":0,"mode":0})")));
        // The earlier tape section left tape 0 stopped; a frozen playhead
        // measures 0 no matter what the rate says. Loop it again first.
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":0})")));
        for (int b = 0; b < 200; ++b) render(0.0); // let the rate glide settle
        const double tp0 = sl_tape_playhead(e, 0);
        for (int b = 0; b < 8; ++b) render(0.0);
        double tAdvanced = sl_tape_playhead(e, 0) - tp0;
        while (tAdvanced < 0.0)
            tAdvanced += static_cast<double>(sl_tape_frames(e, 0)); // wrapped
        const double tPerFrame = tAdvanced / (8.0 * static_cast<double>(kQ));
        CHECK(tPerFrame > 1.9 && tPerFrame < 2.1);
        CHECK(replyOk(cmd("slTape", R"({"action":"setRate","tape":0,"rate":1.0})")));

        // Dropping the deck DOES clear it: deck scope outlives a publish, not
        // the deck. Otherwise the next strip to take this slot would inherit the
        // previous one's sync — the "loaded carrying whatever ratio the previous
        // map left" bug, back in a new place.
        //
        // ⚠️ REACHED THROUGH THE DISPATCHER, not `sl_deck_clear` directly, and
        // that is the point. Deck slots are REUSED: drop a strip's element and
        // load another session into it and you are on this path. The engine half
        // always worked; `slDeck clear` had ZERO CALLERS in the app, so the app
        // never took it — the plane dropped an element by publishing a stopped
        // world and clearing the channel, both of which leave the tempo axis
        // standing. Testing the C function alone would have kept passing while
        // the product kept inheriting the old sync.
        CHECK(replyOk(cmd("slDeck", R"({"action":"setTranspose","deck":0,"value":-5})")));
        CHECK(replyOk(cmd("slDeck", R"({"action":"clear","deck":0})")));
        CHECK(sl_deck_tempo_sync(e, 0) == 1.0);
        {
            const int32_t transposeId = sl_param_id_for_name("transpose");
            CHECK(transposeId != SL_PARAM_UNKNOWN);
            CHECK(sl_param_get(e, 0, transposeId) == 0.0);
        }

        // A STOPPED PUBLISH IS NOT A CLEAR, which is why the plane has to send
        // the verb. Re-sync, publish a stopped world the way `closeDeck` does,
        // and the sync is still there — correct (deck scope survives a publish
        // by design) and exactly why "I published a stopped world" cannot stand
        // in for "I dropped this deck".
        CHECK(replyOk(cmd("slDeck", R"({"action":"setTempoSync","deck":0,"ratio":2.0})")));
        CHECK(replyOk(dispatch("slWorld", world, settings, e, &services)));
        CHECK(sl_deck_tempo_sync(e, 0) == 2.0);
        CHECK(replyOk(cmd("slDeck", R"({"action":"clear","deck":0})")));
        CHECK(sl_deck_tempo_sync(e, 0) == 1.0);
        CHECK(replyOk(dispatch("slWorld", world, settings, e, &services))); // restore the deck
    }

    // ── 10. TWO GRID DECKS AT ONCE, EACH ITS OWN TEMPO ───────────────────────
    //
    // "Decks load into strips, each with its own BPM" is the merge's mission
    // sentence, and it needed proving rather than assuming — `SlWorldApply`
    // carried a comment claiming "deck 0 only today", which was never true of
    // the ABI. `deckWorlds` is a persistent array of kMaxDecks, and each
    // begin…commit rebuilds ONE slot and republishes all, so publishing deck 1
    // must NOT wipe deck 0.
    //
    // This pins that, and it de-risks the web work that follows: the single-deck
    // limitation is in `companionEngine` (one session, no deck axis on
    // `worldFromSession`), not in the engine.
    {
        auto publishDeck = [&](int deck, int bpm) {
            const auto json = juce::String(R"({"action":"publish","world":{"deck":)") +
                              juce::String(deck) + R"(,"bpm":)" + juce::String(bpm) +
                              R"(,"isPlaying":true,"startStep":0,
                    "tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0}]}})";
            return dispatch("slWorld", juce::JSON::parse(json), settings, e, &services);
        };

        // Deck 0 at 120, deck 1 at 90 — two sessions, two tempos, one engine.
        const auto d0 = publishDeck(0, 120);
        CHECK(replyOk(d0));
        CHECK((bool) d0.getProperty("result", juce::var()).getProperty("applied", false));
        const auto d1 = publishDeck(1, 90);
        CHECK(replyOk(d1));
        CHECK((bool) d1.getProperty("result", juce::var()).getProperty("applied", false));

        // Each deck keeps its OWN sync ratio across the other's publish. If
        // publishing deck 1 rebuilt the whole world, deck 0's would be gone —
        // and per-deck BPM isolation would be a claim rather than a fact.
        CHECK(replyOk(cmd("slDeck", R"({"action":"setTempoSync","deck":0,"ratio":1.5})")));
        CHECK(replyOk(cmd("slDeck", R"({"action":"setTempoSync","deck":1,"ratio":0.5})")));
        CHECK(sl_deck_tempo_sync(e, 0) == 1.5);
        CHECK(sl_deck_tempo_sync(e, 1) == 0.5);

        // Both decks together are audible.
        double bothLoud = 0.0;
        for (int b = 0; b < 120; ++b) { render(0.0); bothLoud = std::max(bothLoud, peak(lane[0])); }
        CHECK(bothLoud > 0.01);

        // Out of range is REFUSED, not aliased onto deck 0 — a world silently
        // landing on the wrong deck is worse than one that does not land.
        const auto tooFar = publishDeck(static_cast<int>(sl_deck_count()), 120);
        CHECK(replyOk(tooFar)); // the command ran…
        CHECK(!(bool) tooFar.getProperty("result", juce::var()).getProperty("applied", true));

        // ── 10b. PER-TRACK DJ TELEMETRY IN THE HOTFRAME (P3-D4-3) ────────────
        //
        // The djTrack* blocks were declared in the layout and NEVER WRITTEN:
        // the zero-fill left 0.0 in every slot, and the UI's `?? -1` guard
        // never fires on a real 0.0 — so every deck-tile track would paint a
        // permanent step-0 playhead wash. The desktop filled these from Swift
        // (WebDjBinding.djHotFields); the merged engine owns them now.
        //
        // Indices restated BY HAND from schema.ts (the harness rule above): if
        // the emitter and the schema ever disagree, this must FAIL rather than
        // move in lockstep with a regenerated header.
        {
            constexpr int kDjStepD0T0 = 44, kDjStepD2T0 = 76;
            constexpr int kDjPosD0T0 = 108;
            constexpr int kDjLevelD0T0 = 172, kDjLevelD2T0 = 204;

            std::vector<double> hf(sl_hotframe_length(), 0.0);
            auto grab = [&] {
                CHECK(sl_hotframe(e, hf.data(), static_cast<uint32_t>(hf.size())) > 0);
                return 0;
            };

            // Decks 0 and 1 are PLAYING from §10 (8-step single-track worlds).
            for (int b = 0; b < 8; ++b) render(0.0);
            grab();
            const double step0 = hf[kDjStepD0T0];
            CHECK(step0 >= 0.0 && step0 < 8.0);          // a real step, not a wash
            CHECK(hf[kDjStepD0T0 + 1] == -1.0);          // track 1 does not exist → hidden
            CHECK(hf[kDjStepD2T0] == -1.0);              // deck 2 inactive → hidden
            CHECK(hf[kDjLevelD0T0] > 0.0);               // the tone is sounding
            CHECK(hf[kDjLevelD2T0] == 0.0);              // silence where nothing plays
            // The sample cursor is either a live fraction or an honest −1
            // (voice gaps between steps are real), never a fake 0-wash.
            const double pos0 = hf[kDjPosD0T0];
            CHECK(pos0 == -1.0 || (pos0 >= 0.0 && pos0 <= 1.0));

            // The step ADVANCES — a frozen value would be the old bug wearing
            // a valid number. 8 steps at 120 bpm = 62.5 ms/step ≈ 12 blocks;
            // render past a boundary and the shown step must move.
            double moved = step0;
            for (int b = 0; b < 40 && moved == step0; ++b) {
                render(0.0);
                grab();
                moved = hf[kDjStepD0T0];
            }
            CHECK(moved != step0);

            // Stopping the deck hides the playhead: −1, not a parked step.
            const auto stopJson = juce::String(
                R"({"action":"publish","world":{"deck":0,"bpm":120,"isPlaying":false,
                    "startStep":0,"tracks":[{"sampleId":"tone",
                    "steps":[1,1,1,1,1,1,1,1],"volume":1.0}]}})");
            CHECK(replyOk(dispatch("slWorld", juce::JSON::parse(stopJson), settings, e,
                                   &services)));
            render(0.0);
            grab();
            CHECK(hf[kDjStepD0T0] == -1.0);
            CHECK(hf[kDjPosD0T0] == -1.0);

            // Restore §10's end state for §11's fresh-ground assumptions.
            CHECK(replyOk(publishDeck(0, 120)));
        }
    }

    // ── 11. STRIP → STRIP PATCHING (increment 4) ─────────────────────────────
    //
    // The thing that made cables worth drawing at all: routing is genuinely a
    // GRAPH now, not the star `pd-plane-playground` argued against lines for.
    // Three claims, each of which is a bug if it fails, and none of which any
    // unit test can reach.
    {
        // Fresh ground. The GRID DECKS from §9/§10 must be stopped first: the
        // core mixes a grid deck into main ITSELF (the channel projects onto
        // it rather than routing it), so a playing deck reaches the output no
        // matter what the patchbay says. That is correct engine behaviour and
        // it would make every assertion below meaningless.
        // `sl_deck_clear`, not a stopped publish. A stopped publish leaves the
        // deck's TEMPO axis standing — deck-scope params survive a publish by
        // design (§9) — and §9 leaves deck 0 synced at 2×, which keeps its bus
        // stretcher engaged and still flushing when the ground check runs.
        // Clearing is what "this deck is gone" actually means, and it takes the
        // params with it. (Before P3-2 a stopped publish reset the ratio as a
        // side effect, which is the accident this step removes.)
        for (uint32_t d = 0; d < sl_deck_count(); ++d) sl_deck_clear(e, d);
        for (uint32_t id = 0; id < sl_route_capacity(); ++id)
            if (sl_route_active(e, id) != 0) sl_route_remove(e, id);
        for (int b = 0; b < 32; ++b) render(0.0); // let every ramp reach zero

        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":0,"kind":0,"index":0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":1,"kind":0,"index":0})")));
        CHECK(replyOk(cmd("slRoute",
            R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":0,"gain":1.0})")));
        // ONLY strip 1 reaches main. So anything audible proves the signal
        // travelled 0 → 1 and out — a chain, not a coincidence.
        CHECK(replyOk(cmd("slRoute",
            R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":2,"dstIndex":0,"gain":1.0})")));

        for (int b = 0; b < 24; ++b) render(0.5);
        double beforeChain = 0.0;
        for (int b = 0; b < 8; ++b) { render(0.5); beforeChain = std::max(beforeChain, peak(lane[0])); }
        CHECK(beforeChain < 1e-3); // strip 0 has nowhere to go yet

        // (a) STRIP → STRIP CARRIES AUDIO.
        CHECK(replyOk(cmd("slRoute",
            R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":0,"dstIndex":1,"gain":1.0})")));
        for (int b = 0; b < 24; ++b) render(0.5);
        double chained = 0.0;
        for (int b = 0; b < 8; ++b) { render(0.5); chained = std::max(chained, peak(lane[0])); }
        CHECK(chained > 0.05);

        // (b) A CYCLE IS REFUSED unless consented to — and `wouldCycle` says so
        // BEFORE the attempt, which is what lets the UI offer a feedback edge
        // instead of showing a button that does nothing.
        const auto wc = cmd("slRoute", R"({"action":"wouldCycle","srcIndex":1,"dstIndex":0})");
        CHECK(replyOk(wc));
        CHECK((bool) wc.getProperty("result", juce::var()).getProperty("wouldCycle", false));

        const auto refused = cmd("slRoute",
            R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":0.5})");
        CHECK(replyOk(refused));
        CHECK(!(bool) refused.getProperty("result", juce::var()).getProperty("ok", true));

        // (c) …and HONOURED when it is. The consented loop must stay FINITE:
        // the channel ceiling bounds it where it closes, which is the whole
        // reason that guard is at the channel output and not on main.
        const auto consented = cmd("slRoute",
            R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":0.5,"feedback":true})");
        CHECK(replyOk(consented));
        CHECK((bool) consented.getProperty("result", juce::var()).getProperty("ok", false));

        double loopPeak = 0.0;
        for (int b = 0; b < 400; ++b) { render(0.5); loopPeak = std::max(loopPeak, peak(lane[0])); }
        CHECK(std::isfinite(loopPeak));
        CHECK(loopPeak < 100.0); // bounded, not diverging

        // A SEND tap is routable to a strip too (decision 5: the channel owns
        // the level, the document owns the destination).
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSend","channel":0,"send":2,"level":1.0})")));
        const auto sendCable = cmd("slRoute",
            R"({"action":"add","srcKind":1,"srcIndex":0,"srcSub":2,"dstKind":0,"dstIndex":1,"gain":1.0})");
        CHECK(replyOk(sendCable));
        CHECK((bool) sendCable.getProperty("result", juce::var()).getProperty("ok", false));

        // Unpatching is a CROSSFADE, not a click: the gain ramps out and the
        // slot is dropped only at zero. Measured as "no sample step above the
        // ramp bound" while removing a live cable.
        int chainId = -1;
        for (uint32_t id = 0; id < sl_route_capacity(); ++id)
            if (sl_route_active(e, id) != 0 && sl_route_source_kind(e, id) == 0 &&
                sl_route_source_index(e, id) == 0 && sl_route_dest_kind(e, id) == 0)
                chainId = static_cast<int>(id);
        CHECK(chainId >= 0);
        render(0.5);
        float prev = lane[0][kQ - 1];
        double maxStep = 0.0;
        CHECK(replyOk(cmd("slRoute",
            (juce::String(R"({"action":"remove","id":)") + juce::String(chainId) + "}"))));
        for (int b = 0; b < 60; ++b) {
            render(0.5);
            for (uint32_t i = 0; i < kQ; ++i) {
                maxStep = std::max(maxStep, std::abs(static_cast<double>(lane[0][i] - prev)));
                prev = lane[0][i];
            }
        }
        // The input is a 220 Hz tone at 0.5, so consecutive samples already
        // differ by up to ~0.015 on their own; a STEP from an unramped unpatch
        // would be the full amplitude.
        CHECK(maxStep < 0.2);
    }

    // ── 12. THE LEDGER'S DATA (increment 4) ──────────────────────────────────
    //
    // `slRouteList` is what the routing matrix reads, and it has to answer two
    // questions nothing else can: WHICH SLOT is each cable in, and in what
    // ORDER do the strips render.
    //
    // ⚠️ THE SLOT ID IS NOT THE ROW NUMBER. The list is one entry per slot over
    // the whole 128-entry capacity, most of them inactive. A UI that filtered
    // to active cables and then used the array index as the id would unpatch a
    // DIFFERENT cable than the one clicked — and the further down the list, the
    // more wrong it would get. Pinned here because the failure is silent: the
    // click works, a cable disappears, just not that one.
    {
        const auto listed2 = cmd("slRouteList", "{}");
        CHECK(replyOk(listed2));
        const auto res = listed2.getProperty("result", juce::var());
        const auto* rows = res.getProperty("routes", juce::var()).getArray();
        CHECK(rows != nullptr);
        CHECK(rows->size() == (int) sl_route_capacity()); // one entry PER SLOT

        // Every active row's position must be its engine slot id — that is the
        // property the matrix's remove depends on.
        for (int id = 0; id < rows->size(); ++id) {
            const auto& r = (*rows)[id];
            const bool active = (bool) r.getProperty("active", false);
            CHECK(active == (sl_route_active(e, (uint32_t) id) != 0));
            if (!active) continue;
            CHECK((int) r.getProperty("srcKind", -1) ==
                  (int) sl_route_source_kind(e, (uint32_t) id));
            CHECK((int) r.getProperty("dstIndex", -1) ==
                  (int) sl_route_dest_index(e, (uint32_t) id));
        }

        // Removing by the reported id removes THAT cable and no other.
        int victim = -1;
        for (int id = 0; id < rows->size(); ++id)
            if ((bool) (*rows)[id].getProperty("active", false)) { victim = id; break; }
        CHECK(victim >= 0);
        const auto beforeCount = sl_route_count_active(e);
        CHECK(replyOk(cmd("slRoute",
            (juce::String(R"({"action":"remove","id":)") + juce::String(victim) + "}"))));
        for (int b = 0; b < 40; ++b) render(0.0); // it ramps out before the slot frees
        CHECK(sl_route_active(e, (uint32_t) victim) == 0);
        CHECK(sl_route_count_active(e) == beforeCount - 1);

        // The render ORDER is a permutation of every channel — the ledger states
        // it because a chain is zero-latency only by virtue of this, and it is
        // the answer when someone asks why a cable "sounds a block late".
        const auto* order = res.getProperty("renderOrder", juce::var()).getArray();
        CHECK(order != nullptr);
        CHECK(order->size() == (int) sl_channel_count());
        std::vector<bool> seen(sl_channel_count(), false);
        for (const auto& v : *order) {
            const auto c = (int) v;
            CHECK(c >= 0 && c < (int) sl_channel_count());
            CHECK(!seen[(size_t) c]); // never names one channel twice
            seen[(size_t) c] = true;
        }
    }

    // ── 13. THE MASTER FADER (increment 5) ───────────────────────────────────
    //
    // Front-of-house level, and the trap it sits on.
    //
    // ⚠️ The core's `submitMixerState` publishes through `buildWorld()`, which
    // is the SINGLE-DECK path — it sets `djMode = false`. Routing the master
    // gain through it would have wiped every grid deck the instant anyone
    // touched the fader: the master would work, and the decks would go silent,
    // and nothing would connect the two. `sl_master_set_level` uses
    // `publishDJWorld` instead, and this is what proves the difference.
    {
        // Something audible that is NOT a grid deck, so the fader can be
        // measured on its own: the input straight through a strip to main.
        for (uint32_t id = 0; id < sl_route_capacity(); ++id)
            if (sl_route_active(e, id) != 0) sl_route_remove(e, id);
        for (int b = 0; b < 32; ++b) render(0.0);
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":0,"kind":0,"index":0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setLevel","channel":0,"level":1.0})")));
        CHECK(replyOk(cmd("slRoute",
            R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":0,"gain":1.0})")));
        CHECK(replyOk(cmd("slRoute",
            R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":2,"dstIndex":0,"gain":1.0})")));
        for (int b = 0; b < 40; ++b) render(0.5);

        CHECK(replyOk(cmd("slMaster", R"({"action":"setLevel","level":1.0})")));
        CHECK(sl_master_level(e) == 1.0);
        for (int b = 0; b < 24; ++b) render(0.5);
        double atUnity = 0.0;
        for (int b = 0; b < 8; ++b) { render(0.5); atUnity = std::max(atUnity, peak(lane[0])); }
        CHECK(atUnity > 0.05);

        // Pulling it down must be AUDIBLE — a master that moves the document
        // and not the mix is the whole defect this asserts against.
        CHECK(replyOk(cmd("slMaster", R"({"action":"setLevel","level":0.2})")));
        for (int b = 0; b < 40; ++b) render(0.5);
        double atLow = 0.0;
        for (int b = 0; b < 8; ++b) { render(0.5); atLow = std::max(atLow, peak(lane[0])); }
        CHECK(atLow < atUnity * 0.5);

        CHECK(replyOk(cmd("slMaster", R"({"action":"setLevel","level":1.0})")));
        for (int b = 0; b < 40; ++b) render(0.5);

        // THE TRAP. A grid deck playing, then the master moved: the deck must
        // STILL be playing afterwards. Through submitMixerState it would not be.
        {
            const auto world = juce::JSON::parse(
                R"({"action":"publish","world":{"deck":0,"bpm":120,"isPlaying":true,"startStep":0,
                    "tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0}]}})");
            CHECK(replyOk(dispatch("slWorld", world, settings, e, &services)));
            CHECK(replyOk(cmd("slDeck", R"({"action":"setTempoSync","deck":0,"ratio":1.25})")));

            // Silence the live input so only the DECK can be making sound.
            for (uint32_t id = 0; id < sl_route_capacity(); ++id)
                if (sl_route_active(e, id) != 0 && sl_route_source_kind(e, id) == 2)
                    sl_route_remove(e, id);
            for (int b = 0; b < 32; ++b) render(0.0);

            double deckBefore = 0.0;
            for (int b = 0; b < 120; ++b) { render(0.0); deckBefore = std::max(deckBefore, peak(lane[0])); }
            CHECK(deckBefore > 0.01);

            CHECK(replyOk(cmd("slMaster", R"({"action":"setLevel","level":0.8})")));
            for (int b = 0; b < 40; ++b) render(0.0);
            double deckAfter = 0.0;
            for (int b = 0; b < 120; ++b) { render(0.0); deckAfter = std::max(deckAfter, peak(lane[0])); }
            // Still playing — quieter, but ALIVE.
            CHECK(deckAfter > 0.005);
            // …and its tempo sync survived too: publishDJWorld carries the deck
            // worlds through, where buildWorld() would have discarded them.
            CHECK(sl_deck_tempo_sync(e, 0) == 1.25);
        }

        // Hostile values never reach the mix.
        const auto before = sl_master_level(e);
        sl_master_set_level(e, -1.0);
        sl_master_set_level(e, std::nan(""));
        CHECK(sl_master_level(e) == before);
    }

    // ── 14. THE MAP ON DISK (increment 6) ────────────────────────────────────
    //
    // ⚠️ NOTHING COULD SAVE A MAP BEFORE THIS. The wire carried no file read or
    // write at all — `chooseDirectory` was the only filesystem method, and
    // `capabilities.fileSystem: true` means "this host owns native dialogs",
    // not "the web layer can write files". A whole plane could be built and
    // lost.
    {
        const auto mapJson = juce::String(
            R"({"schemaVersion":2,"savedAt":"now","app":"scoopy","map":{)"
            R"("plane":{"scale":1,"panX":0,"panY":0},"strips":[],"routes":[],)"
            R"("transport":{"masterBpm":174,"masterLevel":0.8}}})");

        auto* save = new juce::DynamicObject();
        save->setProperty("action", "save");
        save->setProperty("name", "test set");
        save->setProperty("json", mapJson);
        CHECK(replyOk(dispatch("slMap", juce::var(save), settings, e, &services)));

        // It is REALLY on disk, beside the takes — a map and its audio
        // travelling together is what makes collect-on-export a copy, not a hunt.
        const auto mapsDir = std::filesystem::path(services.takesDir).parent_path() / "Maps";
        CHECK(std::filesystem::exists(mapsDir / "test set.scoopyMap"));
        // …and the atomic write left no temporary behind.
        CHECK(!std::filesystem::exists(mapsDir / "test set.scoopyMap.tmp"));

        const auto listed3 = cmd("slMap", R"({"action":"list"})");
        CHECK(replyOk(listed3));
        const auto* maps = listed3.getProperty("result", juce::var())
                               .getProperty("maps", juce::var()).getArray();
        CHECK(maps != nullptr && maps->size() >= 1);

        const auto opened = cmd("slMap", R"({"action":"open","name":"test set"})");
        CHECK(replyOk(opened));
        // Byte-identical: the shell moves BYTES and parses nothing, so what
        // comes back is exactly what the document layer wrote.
        CHECK(opened.getProperty("result", juce::var()).getProperty("json", "").toString() ==
              mapJson);

        // Opening one that is not there is a refusal, not an empty document —
        // an empty map would look like a successful load of an empty set.
        CHECK(!replyOk(cmd("slMap", R"({"action":"open","name":"never saved"})")));

        // ⚠️ A NAME IS A FILE NAME, NEVER A PATH. `../` in a document name must
        // not be able to write outside the maps directory.
        auto* escape = new juce::DynamicObject();
        escape->setProperty("action", "save");
        escape->setProperty("name", "../../escaped");
        escape->setProperty("json", mapJson);
        dispatch("slMap", juce::var(escape), settings, e, &services);
        CHECK(!std::filesystem::exists(
            std::filesystem::path(services.takesDir).parent_path().parent_path() /
            "escaped.scoopyMap"));

        // Delete goes to the TRASH, never unlink — a mis-click on a document
        // that represents a night's work stays recoverable.
        CHECK(replyOk(cmd("slMap", R"({"action":"delete","name":"test set"})")));
        CHECK(!std::filesystem::exists(mapsDir / "test set.scoopyMap"));

        // ── COLLECT-ON-EXPORT ────────────────────────────────────────────────
        //
        // A saved map REFERENCES its takes by path — right on the machine that
        // recorded them, useless anywhere else. Export is the deliberate step
        // that makes one self-contained.
        //
        // ⚠️ NO AUDIO CROSSES THE BRIDGE. TS hands over the already-rewritten
        // document and the file LIST; the shell copies the bytes. A take is
        // capped at 256 MB, so base64 would be ~350 MB of string per take.
        {
            // A real take on disk to collect — the one §5 recorded.
            const auto realTake = path.toStdString();
            CHECK(std::filesystem::exists(realTake));

            auto* takeEntry = new juce::DynamicObject();
            takeEntry->setProperty("path", juce::String(realTake));
            takeEntry->setProperty("entry", "Takes/collected.wav");
            juce::Array<juce::var> takeList;
            takeList.add(juce::var(takeEntry));
            // A take that is GONE must be reported, not silently dropped.
            auto* goneEntry = new juce::DynamicObject();
            goneEntry->setProperty("path", "/nowhere/missing.wav");
            goneEntry->setProperty("entry", "Takes/missing.wav");
            takeList.add(juce::var(goneEntry));

            auto* exp = new juce::DynamicObject();
            exp->setProperty("action", "export");
            exp->setProperty("name", "travelling set");
            exp->setProperty("json", mapJson);
            exp->setProperty("takes", juce::var(takeList));
            const auto exported = dispatch("slMap", juce::var(exp), settings, e, &services);
            CHECK(replyOk(exported));
            const auto expRes = exported.getProperty("result", juce::var());

            const auto pkgPath = expRes.getProperty("path", "").toString();
            CHECK(pkgPath.isNotEmpty());
            CHECK(std::filesystem::exists(pkgPath.toStdString()));
            // Bigger than the document alone — the audio really came along.
            CHECK(std::filesystem::file_size(pkgPath.toStdString()) >
                  static_cast<std::uintmax_t>(mapJson.length()) + 1024);

            // The missing one is NAMED. A package quietly short a file fails on
            // the other machine at the worst possible moment.
            const auto* miss = expRes.getProperty("missing", juce::var()).getArray();
            CHECK(miss != nullptr && miss->size() == 1);
            CHECK((*miss)[0].toString().contains("missing.wav"));

            // It is a REAL zip that a real reader can open, with both entries
            // where the plan said they would be.
            const juce::File pkg(pkgPath);
            juce::ZipFile archive(pkg);
            CHECK(archive.getNumEntries() == 2);
            CHECK(archive.getIndexOfFileName("map.scoopyMap") >= 0);
            CHECK(archive.getIndexOfFileName("Takes/collected.wav") >= 0);
            // …and the document inside is byte-identical to what TS handed over.
            std::unique_ptr<juce::InputStream> entry(
                archive.createStreamForEntry(archive.getIndexOfFileName("map.scoopyMap")));
            CHECK(entry != nullptr);
            CHECK(entry->readEntireStreamAsString() == mapJson);

            // No staging temporary left behind.
            CHECK(!std::filesystem::exists(
                (mapsDir / "travelling set.export.tmp").string()));
            pkg.deleteFile();
        }

        std::filesystem::remove_all(mapsDir);
    }

    // ── 15. THE SPLIT TAP (P2-5 increment 1) ─────────────────────────────────
    //
    // THE ASSERTION THIS SECTION EXISTS FOR: a take recorded with the monitor
    // CLOSED contains the same audio as one recorded with it open.
    //
    // That single equality is what "record without hearing" means, and before
    // the split it was impossible by construction — the record tap WAS the
    // channel bus, so silencing the input to stop a feedback loop made REC
    // capture silence. Everything else here is scaffolding for that comparison.
    //
    // A fresh strip on channel 3 / tape 3, so none of the state above matters.
    {
        // Fresh ground, for the same reason §11 needs it: §13 left a GRID DECK
        // playing, and the core mixes a deck into main ITSELF — muting the
        // strip channels would not touch it, because the channel projects onto
        // the core rather than routing it. Anything audible below has to be
        // attributable to this one strip.
        // `sl_deck_clear`, not a stopped publish. A stopped publish leaves the
        // deck's TEMPO axis standing — deck-scope params survive a publish by
        // design (§9) — and §9 leaves deck 0 synced at 2×, which keeps its bus
        // stretcher engaged and still flushing when the ground check runs.
        // Clearing is what "this deck is gone" actually means, and it takes the
        // params with it. (Before P3-2 a stopped publish reset the ratio as a
        // side effect, which is the accident this step removes.)
        for (uint32_t d = 0; d < sl_deck_count(); ++d) sl_deck_clear(e, d);
        for (uint32_t id = 0; id < sl_route_capacity(); ++id)
            if (sl_route_active(e, id) != 0) sl_route_remove(e, id);
        // Tape 0 is still looping from §6/§7 and would sum in through channel 0.
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":2})")));
        for (int b = 0; b < 32; ++b) render(0.0); // let every ramp reach zero
        CHECK(peak(lane[0]) < 1e-3);              // the ground really is clear

        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":3,"kind":1,"index":3})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setLevel","channel":3,"level":1.0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":3,"muted":false})")));
        CHECK(replyOk(cmd(
            "slRoute",
            R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":3,"gain":1.0})")));
        CHECK(replyOk(cmd(
            "slRoute", R"({"action":"add","srcKind":0,"srcIndex":3,"dstKind":2,"dstIndex":0,"gain":1.0})")));
        // Small cap so the two takes below are short and quick to compare.
        sl_tape_set_record_cap_frames(e, 3, static_cast<uint64_t>(kQ) * 32);

        // A monitor is CLOSED on a fresh channel — the same arrival state §3
        // pins, checked here on a channel that was never touched by the UI.
        CHECK(sl_channel_monitor(e, 3) == 0u);
        for (int b = 0; b < 16; ++b) render(0.5);
        CHECK(peak(lane[0]) < 1e-3);

        /** Record `blocks` blocks into tape 3 and return the take's peak — 0 if
            any step of the sequence was refused, which the caller's `> 0.05`
            already catches. (CHECK returns an int and would not compile inside a
            double-returning lambda; making it compile by widening the return
            type would let a refused command pass as a peak of 1.0, so the
            refusals are folded into `ok` and checked outside instead.)

            Read back from the ENGINE's own buffer rather than from the file:
            this compares what was CAPTURED, and a file round trip would drag WAV
            quantisation into an equality that is about the signal path. */
        bool recOk = true;
        const auto recordTake = [&](int blocks) -> double {
            recOk = recOk && replyOk(cmd("slRecord",
                                         R"({"action":"start","tape":3,"sourceKind":0,)"
                                         R"("chan0":0,"chan1":-1,"sourceDesc":"split tap"})"));
            for (int b = 0; b < blocks; ++b) render(0.5);
            recOk = recOk && replyOk(cmd("slRecord", R"({"action":"stop","tape":3})"));
            render(0.0); // the stop lands at the next block boundary
            const auto n = sl_tape_frames(e, 3);
            if (n == 0) return 0.0;
            std::vector<float> mn(64, 0.0f), mx(64, 0.0f);
            const auto cols = sl_tape_waveform(e, 3, 0, 0, n, 64, mn.data(), mx.data());
            double p = 0.0;
            for (uint32_t i = 0; i < cols; ++i)
                p = std::max(p, std::max(std::abs((double) mn[i]), std::abs((double) mx[i])));
            return p;
        };

        // (a) MONITOR CLOSED — silent out, and REC still captures.
        const double takeClosed = recordTake(20);
        CHECK(recOk);
        CHECK(takeClosed > 0.05);

        // ⚠️ AND THE ARMING OPENED IT. D-WZ-MON-01: armed to record means you
        // hear what you are capturing, and the engine does that itself rather
        // than relying on a UI to remember. Read from the ENGINE, because after
        // this the switch is no longer where the document last put it.
        CHECK(sl_channel_monitor(e, 3) == 1u);

        // (b) MONITOR OPEN — audible, and the take is the SAME.
        for (int b = 0; b < 8; ++b) render(0.5);
        double heard = 0.0;
        for (int b = 0; b < 8; ++b) { render(0.5); heard = std::max(heard, peak(lane[0])); }
        CHECK(heard > 0.05);

        const double takeOpen = recordTake(20);
        // THE EQUALITY. Same source, same level, same length — so the two takes
        // must agree to well within the tolerance of where the sine happened to
        // be when each capture started.
        CHECK(std::abs(takeOpen - takeClosed) < 0.02);

        // (c) THE LAW C-3 HANDOFF CLOSES IT, IN THE SAME BLOCK (D-WZ-MON-02).
        //
        // Input + loop together the instant a loop closes is doubling, not
        // information. `render(0.0)` below feeds SILENCE, so the only thing that
        // could still be heard is the loop itself — and the monitor must
        // already be shut when the first post-handoff block is mixed, not a
        // frame or two later off a reply.
        sl_tape_set_loop(e, 3, 1u, 0, 0);
        CHECK(replyOk(cmd("slRecord",
                          R"({"action":"start","tape":3,"sourceKind":0,"chan0":0,"chan1":-1,)"
                          R"("sourceDesc":"handoff"})")));
        for (int b = 0; b < 20; ++b) render(0.5);
        CHECK(sl_channel_monitor(e, 3) == 1u); // open while capturing
        CHECK(replyOk(cmd("slRecord", R"({"action":"stop","tape":3})")));
        render(0.5); // THE handoff block — the input is still hot on the wire
        CHECK(sl_tape_state(e, 3) == 1u);       // looping: the handoff happened
        CHECK(sl_channel_monitor(e, 3) == 0u);  // …and the switch is already shut

        // (d) OVERDUB KEEPS IT OPEN — the other half of D-WZ-MON-02, and the
        // reason the close is scoped to the handoff rather than to "recording
        // stopped": hearing the input against the loop IS overdubbing.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":3,"on":true})")));
        sl_tape_overdub_start(e, 3, 0);
        for (int b = 0; b < 8; ++b) render(0.5);
        sl_tape_overdub_stop(e, 3);
        for (int b = 0; b < 4; ++b) render(0.5);
        CHECK(sl_channel_monitor(e, 3) == 1u);

        // (e) MUTE AND MONITOR ARE DIFFERENT CONTROLS. The bug that started
        // this: `M` was the only way to stop the feedback, and it killed the
        // tape too. Muting the strip must silence the OUTPUT while the monitor
        // switch keeps its own state — the tape below is still looping.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":3,"muted":true})")));
        for (int b = 0; b < 40; ++b) render(0.5);
        double mutedOut = 0.0;
        for (int b = 0; b < 10; ++b) { render(0.5); mutedOut = std::max(mutedOut, peak(lane[0])); }
        CHECK(mutedOut < 1e-3);
        CHECK(sl_channel_monitor(e, 3) == 1u);  // untouched by the mute
        CHECK(sl_tape_state(e, 3) == 1u);       // and the tape never stopped

        // …and closing the monitor while UNMUTED silences the input without
        // stopping the tape, which is the whole point of having both.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":3,"muted":false})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":3,"on":false})")));
        for (int b = 0; b < 40; ++b) render(0.5);
        double loopOnly = 0.0;
        for (int b = 0; b < 10; ++b) { render(0.5); loopOnly = std::max(loopOnly, peak(lane[0])); }
        CHECK(loopOnly > 0.05); // the tape, still audible, with the input shut

        // (f) A CABLE FROM ANOTHER STRIP IS NOT MONITORING. MON must gate this
        // strip's own input and nothing else, or it is just `mute` again under
        // a second name. Channel 4 takes the input (monitor open) and feeds
        // channel 3, whose own monitor is CLOSED — and channel 3 must still
        // pass it.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":3,"muted":true})")));
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":3,"mode":2})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":4,"kind":0,"index":0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMonitor","channel":4,"on":true})")));
        CHECK(replyOk(cmd(
            "slRoute",
            R"({"action":"add","srcKind":2,"srcIndex":0,"srcSub":1,"dstKind":0,"dstIndex":4,"gain":1.0})")));
        // Channel 4 has no path to main of its own, so anything heard travelled
        // the chain 4 → 3 → main.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":3,"muted":false})")));
        CHECK(replyOk(cmd(
            "slRoute", R"({"action":"add","srcKind":0,"srcIndex":4,"dstKind":0,"dstIndex":3,"gain":1.0})")));
        CHECK(sl_channel_monitor(e, 3) == 0u); // still closed, deliberately
        for (int b = 0; b < 40; ++b) render(0.5);
        double chained = 0.0;
        for (int b = 0; b < 10; ++b) { render(0.5); chained = std::max(chained, peak(lane[0])); }
        CHECK(chained > 0.05);
    }

    // ── BEAT REPEAT THROUGH THE WORLD (P3-M-1a) ─────────────────────────────
    //
    // The deck-scope snapshot fields ride a publish like a scene does. The pin
    // is AUDIBLE, deliberately: the HotFrame's step is the MASTER step, which
    // "keeps advancing underneath" a beat repeat by design — so a step-number
    // assertion measures the wrong tier. Instead: a pattern with sound ONLY in
    // steps 0–1. Repeating [0,2) keeps it loud nearly always; running free, it
    // is loud only ~a quarter of the time.
    {
        auto brWorldFor = [&](bool active) {
            return juce::JSON::parse(juce::String(
                R"({"action":"publish","world":{"deck":0,"bpm":480,"isPlaying":true,"startStep":0,)"
                ) + (active ? R"("beatRepeatActive":true,"beatRepeatStartStep":0,"beatRepeatLength":2,)"
                            : "") +
                R"("tracks":[{"sampleId":"tone","steps":[1,1,0,0,0,0,0,0],"volume":1.0}]}})");
        };
        auto loudFraction = [&](int blocks) {
            int loud = 0;
            for (int b = 0; b < blocks; ++b) {
                render(0.0);
                if (peak(lane[0]) > 0.02) ++loud;
            }
            return static_cast<double>(loud) / blocks;
        };
        CHECK(replyOk(dispatch("slWorld", brWorldFor(true), settings, e, &services)));
        for (int b = 0; b < 50; ++b) render(0.0); // settle into the window
        const double withBr = loudFraction(300);
        CHECK(replyOk(dispatch("slWorld", brWorldFor(false), settings, e, &services)));
        for (int b = 0; b < 50; ++b) render(0.0);
        const double withoutBr = loudFraction(300);
        // The repeat holds the loud window; free running spends most of the
        // pattern in the silent six steps. The margin is deliberately wide.
        CHECK(withBr > withoutBr + 0.3);
        CHECK(replyOk(dispatch("slWorld",
            juce::JSON::parse(R"({"action":"publish","world":{"deck":0,"bpm":120,)"
                              R"("isPlaying":false,"startStep":0,"tracks":[]}})"),
            settings, e, &services)));
    }

    // ── OVERDUB THROUGH THE DISPATCHER (P3-U3) ──────────────────────────────
    //
    // Before this path was wired, a punch through the dispatcher layered
    // SILENCE (no record source was set) and persisted NOTHING (no take was
    // bracketed). Both halves are asserted: the material gets AUDIBLY louder,
    // and the pass lands as its own take file.
    {
        const auto takesBefore = recorder.takes().size();
        // The sections above re-bound channel 0 (grid, chains); this block
        // needs to HEAR tape 0, so bind it back and unmute first.
        CHECK(replyOk(cmd("slChannel", R"({"action":"setSource","channel":0,"kind":1,"index":0})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setMute","channel":0,"muted":false})")));
        CHECK(replyOk(cmd("slChannel", R"({"action":"setLevel","channel":0,"level":1.0})")));
        // …and a path to main: the route surgery above may have re-pointed
        // channel 0's default. srcKind 0 = channelOut, dstKind 2 = main.
        cmd("slRoute",
            R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":2,"dstIndex":0,"gain":1.0})");
        // Every pass below measures the SAME span — retriggered to the region
        // entry — or the comparison would race the playhead: a punch sums into
        // the frames it PASSED, and a window that has moved on measures the
        // untouched remainder.
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":0})")));
        double before = 0.0;
        for (int b = 0; b < 60; ++b) { render(0.0); before = std::max(before, peak(lane[0])); }
        // Punch over that same span, REPLACE mode, with SILENT input — the
        // P3-13a distinction, and the phase-proof one: summing a sine into a
        // sine can partially CANCEL (both this material and this input are the
        // harness tone), and the master path could cap a louder sum. Replacing
        // with silence must make the material QUIETER, and nothing can fake it.
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":3})")));
        const auto od = cmd("slTape",
            R"({"action":"overdubStart","tape":0,"mode":1,"sourceKind":0,"chan0":0,"chan1":-1,)"
            R"("sourceDesc":"overdub in 1","bpmAtStart":120})");
        CHECK(replyOk(od));
        for (int b = 0; b < 60; ++b) render(0.0); // the pass: silence replaces
        const auto odStop = cmd("slTape", R"({"action":"overdubStop","tape":0})");
        CHECK(replyOk(odStop));
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":3})")));
        // The pass persisted as its OWN take — the RAM mix is destructive and
        // the file is what preserves it (D-WZ-OVERDUB-01).
        CHECK(recorder.takes().size() == takesBefore + 1);
        CHECK(odStop.getProperty("result", juce::var())
                  .getProperty("path", juce::var()).toString().isNotEmpty());
        // …and the punched span is audibly QUIETER — silence replaced it.
        double after = 0.0;
        for (int b = 0; b < 60; ++b) { render(0.0); after = std::max(after, peak(lane[0])); }
        CHECK(before > 0.05);          // there was something to erase
        CHECK(after < before * 0.5);   // and it is gone where the punch passed
        CHECK(replyOk(cmd("slTape", R"({"action":"trigger","tape":0,"mode":2})")));
    }

    // The take is enumerable, which is what makes it reloadable tomorrow.
    const auto takes = cmd("slTakes", R"({"action":"list"})");
    CHECK(replyOk(takes));
    const auto* arr =
        takes.getProperty("result", juce::var()).getProperty("takes", juce::var()).getArray();
    CHECK(arr != nullptr && arr->size() >= 1);
    CHECK((*arr)[0].getProperty("sidecar", juce::var()).toString().isNotEmpty());

    recorder.stop();
    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::filesystem::remove_all(takesDir);
    std::printf("plane_audio_test OK — the plane's command sequence produces audio\n");
    return 0;
}
