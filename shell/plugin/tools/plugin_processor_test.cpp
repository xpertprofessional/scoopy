// SCOOPY DECK MAKES A SOUND IN A DAW — headless, no host, no window server.
//
// The plugin's counterpart to plane_audio_test, and it exists for the same
// reason: a green build proves the processor COMPILES, which is not the claim.
// The three claims here are the ones a DAW would otherwise be the first to
// test, one of which is a genuine unknown about the vendored core:
//
//   §1 SOUND        prepareToPlay + processBlock at three rates and three
//                   block sizes, including blocks LARGER than the engine's
//                   (the chunk loop) and blocks that do not divide it.
//   §2 TEMPO FOLLOW a fake AudioPlayHead at 140 BPM against a 120 BPM session
//                   converges syncRatio to 140/120 — through the same 40 Hz
//                   pump the timer drives, never from processBlock.
//   §3 TWO         two processors in ONE process render independently. The
//     INSTANCES     ABI is instance-based and sl_engine.cpp holds no mutable
//                   file-scope state, but the 27-file vendored core was never
//                   audited for statics and every DAW loads N of these.
//
// It compiles the plugin's own sources (never a copy) — a harness built
// against a parallel processor would measure the harness.
#include "ScoopyPluginProcessor.h"
#include "sl_engine.h"

#include <cmath>
#include <cstdio>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
using wizard::plugin::ScoopyPluginProcessor;

/** A DAW's transport, as far as the processor can tell. */
class FakePlayHead final : public juce::AudioPlayHead {
public:
    double bpm = 120.0;
    double ppq = 0.0;
    bool playing = false;

    juce::Optional<PositionInfo> getPosition() const override {
        PositionInfo info;
        info.setBpm(bpm);
        info.setPpqPosition(ppq);
        info.setIsPlaying(playing);
        return info;
    }
};

/** Publish a 220 Hz tone on all 8 steps of deck 0 — the smallest world that
    is audible, in the shape worldFromSession actually emits. */
bool publishTone(ScoopyPluginProcessor& p, double bpm, bool playing, double send1 = 0.0) {
    auto* left = new juce::Array<juce::var>();
    for (int i = 0; i < 4800; ++i)
        left->add(0.5 * std::sin(2.0 * 3.14159265358979 * 220.0 * i / 48000.0));
    auto* s = new juce::DynamicObject();
    s->setProperty("id", "tone");
    s->setProperty("left", juce::var(*left));
    s->setProperty("sampleRate", 48000.0);
    auto* reg = new juce::DynamicObject();
    reg->setProperty("action", "registerSample");
    reg->setProperty("id", "tone");
    reg->setProperty("left", juce::var(*left));
    reg->setProperty("sampleRate", 48000.0);
    const auto regReply = p.dispatchFromUi("slWorld", juce::var(reg));
    delete left;
    if (!(bool) regReply.getProperty("ok", false)) return false;

    const juce::String worldJson =
        R"({"action":"publish","world":{"deck":0,"bpm":)" + juce::String(bpm) +
        R"(,"isPlaying":)" + (playing ? "true" : "false") +
        R"(,"startStep":0,"tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0)" +
        (send1 > 0.0 ? R"(,"send1Level":)" + juce::String(send1) : juce::String()) +
        R"(}]}})";
    const auto reply = p.dispatchFromUi("slWorld", juce::JSON::parse(worldJson));
    return (bool) reply.getProperty("ok", false);
}

/** Render `blocks` of `blockSize` and return the peak on MAIN (bus 0). */
double renderPeak(ScoopyPluginProcessor& p, int blockSize, int blocks) {
    juce::AudioBuffer<float> buf(p.getTotalNumOutputChannels() > 0
                                     ? p.getTotalNumOutputChannels()
                                     : 2,
                                 blockSize);
    juce::MidiBuffer midi;
    double peak = 0.0;
    for (int b = 0; b < blocks; ++b) {
        buf.clear();
        midi.clear();
        p.processBlock(buf, midi);
        for (int ch = 0; ch < juce::jmin(2, buf.getNumChannels()); ++ch)
            peak = juce::jmax(peak, (double) buf.getMagnitude(ch, 0, blockSize));
    }
    return peak;
}

} // namespace

int main() {
    // JUCE types (juce::var, File, the message manager the Timer needs) want an
    // initialised GUI-less JUCE. The processor's Timer never fires here — the
    // test drives pumpHostSync() directly, which is also the honest thing: a
    // gate that waited on a real 40 Hz timer would be a slow flaky gate.
    juce::ScopedJuceInitialiser_GUI juceInit;

    // ── §0 RENDERING BEFORE prepareToPlay MUST NOT CRASH ────────────────────
    //
    // JUCE guarantees prepareToPlay first, but validators and unusual hosts do
    // not always oblige, and the failure would be the engine writing 26 lanes
    // into a zero-length scratch vector — an out-of-bounds write on the audio
    // thread. Silence is the correct answer; a crash is not.
    {
        ScoopyPluginProcessor p;
        juce::AudioBuffer<float> buf(p.getTotalNumOutputChannels(), 256);
        juce::MidiBuffer midi;
        buf.clear();
        p.processBlock(buf, midi); // no prepareToPlay
        CHECK(buf.getMagnitude(0, 0, 256) == 0.0f);
    }

    // ── §1 SOUND, across the rate × block matrix ─────────────────────────────
    {
        ScoopyPluginProcessor p;
        // Main is enabled by default; the aux buses stay disabled, which is the
        // layout a DAW gives an unconfigured instance. The engine still renders
        // all 26 lanes — the unmapped ones land in scratch.
        CHECK(p.getBusCount(false) == wizard::plugin::kNumOutputBuses);

        for (const double rate : {44100.0, 48000.0, 96000.0}) {
            for (const int block : {64, 512, 4096, 300}) { // 300 divides nothing
                p.prepareToPlay(rate, block);
                CHECK(publishTone(p, 120.0, true));
                const double peak = renderPeak(p, block, 24);
                if (!(peak > 1e-4))
                    std::fprintf(stderr, "  (rate %.0f block %d peak %g)\n", rate, block, peak);
                CHECK(peak > 1e-4);
            }
        }
    }

    // ── §2 TEMPO FOLLOW ─────────────────────────────────────────────────────
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, true)); // session bpm 120 → the denominator

        FakePlayHead head;
        head.bpm = 140.0;
        head.playing = true;
        p.setPlayHead(&head);

        // One block so the RT half captures the playhead, then pump — this
        // ordering IS the design: capture is RT, the write is message-thread.
        renderPeak(p, 512, 1);

        const int32_t idSync = sl_param_id_for_name("syncRatio");
        CHECK(idSync != SL_PARAM_UNKNOWN);
        const double want = 140.0 / 120.0;
        bool converged = false;
        for (int tick = 0; tick < 3 && !converged; ++tick) {
            p.pumpHostSync();
            converged = std::abs(sl_param_get(p.engineForTest(), 0, idSync) - want) < 1e-3;
        }
        CHECK(converged); // ≤3 pump ticks, i.e. under 75 ms of host time

        // A tempo CHANGE while playing — the drifting-host case the stretcher's
        // fractional source-frame carry exists for.
        head.bpm = 128.0;
        renderPeak(p, 512, 1);
        p.pumpHostSync();
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - 128.0 / 120.0) < 1e-3);

        // A host with NO playhead must not write anything (many hosts render
        // offline with none, and inventing a ratio would re-pitch the deck).
        p.setPlayHead(nullptr);
        const double held = sl_param_get(p.engineForTest(), 0, idSync);
        renderPeak(p, 512, 1);
        p.pumpHostSync();
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - held) < 1e-9);
    }

    // ── §2a-3 THE INTERNAL MASTER TEMPO (D-SL-DECKPLUGIN-02 · D2) ───────────
    //
    // CLK governs TRANSPORT; the master tempo SOURCE is its own switch. With an
    // internal master the deck stretches against a number the user typed and
    // the DAW's tempo is irrelevant — including with the editor CLOSED, which is
    // the case that needs the recipe rather than web state alone. Before this,
    // TP/TS/T were indistinguishable in practice: the ratio sat at ~1 because
    // the only master available was the host's, and the session was written at
    // the host's tempo.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, true)); // session bpm 120 — the denominator

        FakePlayHead head;
        head.bpm = 120.0; // the DAW agrees with the session: ratio would be 1.0
        head.playing = true;
        p.setPlayHead(&head);
        renderPeak(p, 512, 1);

        const int32_t idSync = sl_param_id_for_name("syncRatio");
        CHECK(idSync != SL_PARAM_UNKNOWN);
        for (int i = 0; i < 3; ++i) p.pumpHostSync();
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - 1.0) < 1e-3);

        // Type 140 as the master. The host has NOT moved.
        {
            auto r = p.hostSync().currentRecipe();
            r.masterBpm = 140.0;
            p.hostSync().setRecipe(r);
        }
        renderPeak(p, 512, 1);
        for (int i = 0; i < 3; ++i) p.pumpHostSync();
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - 140.0 / 120.0) < 1e-3);

        // …and the host moving now changes NOTHING, which is the whole claim.
        head.bpm = 90.0;
        renderPeak(p, 512, 1);
        for (int i = 0; i < 3; ++i) p.pumpHostSync();
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - 140.0 / 120.0) < 1e-3);

        // Back to 0 = follow the host again, and it picks the host straight up.
        {
            auto r = p.hostSync().currentRecipe();
            r.masterBpm = 0.0;
            p.hostSync().setRecipe(r);
        }
        renderPeak(p, 512, 1);
        for (int i = 0; i < 3; ++i) p.pumpHostSync();
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - 90.0 / 120.0) < 1e-3);
    }

    // ── §2a-2 ONE TEMPO AUTHORITY: the pump DEFERS to the web ───────────────
    //
    // With an editor open, djSyncLaw computes the ratio and writes it through
    // slDeck. If this pump also wrote syncRatio the two would stamp different
    // numbers onto one deck at 40 Hz and it would audibly wobble between
    // tempi — from code where each side is correct in isolation, which is the
    // hardest kind to find. `writeRatio=false` is the deferral.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, true));

        FakePlayHead head;
        head.bpm = 160.0;
        head.playing = true;
        p.setPlayHead(&head);
        renderPeak(p, 512, 1);

        const int32_t idSync = sl_param_id_for_name("syncRatio");
        const double before = sl_param_get(p.engineForTest(), 0, idSync);

        // Observing only — the host moved, the deck must NOT be re-stamped.
        for (int i = 0; i < 5; ++i) p.hostSync().pump(p.engineForTest(), /*writeRatio=*/false);
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - before) < 1e-9);

        // …and the transport edge is still TRACKED while deferring, or closing
        // the editor would lose track of what the DAW is doing.
        CHECK(p.hostSync().snapshot().playing);

        // Taking over (no editor) writes it.
        for (int i = 0; i < 3; ++i) p.hostSync().pump(p.engineForTest(), /*writeRatio=*/true);
        CHECK(std::abs(sl_param_get(p.engineForTest(), 0, idSync) - 160.0 / 120.0) < 1e-3);
    }

    // ── §2b MULTI-OUT: the aux buses carry their own lanes ──────────────────
    //
    // The headline routing feature, and one nothing else would catch: LaneMap
    // permutes 26 engine lanes onto the enabled buses, and a wrong index there
    // sends the wrong signal to a named output with no error anywhere. Main
    // alone passing proves nothing about lanes 2…25.
    {
        ScoopyPluginProcessor p;
        // Enable every declared bus, the layout a DAW gives once the user asks
        // for multi-out. If the engine cannot serve this shape we want to know
        // in ctest, not in Live's routing panel.
        // ALL STEREO — the layout Logic actually asks for when you pick the
        // multi-output variant. Declaring the mono-lane sends as mono made
        // this fail in Logic with an empty window and no error (2026-08-01),
        // so the gate now pins the shape that host requires.
        auto layout = p.getBusesLayout();
        for (int i = 0; i < wizard::plugin::kNumOutputBuses; ++i)
            layout.outputBuses.getReference(i) = juce::AudioChannelSet::stereo();
        const bool laidOut = p.setBusesLayout(layout);
        CHECK(laidOut);

        p.prepareToPlay(48000.0, 512);
        // SEND 1 UP. The whole reason the five buses are Main + Send 1-4 (D1) is
        // that the sends are how this deck reaches the DAW's effect tracks — so
        // a test that only ever renders with every send at zero would report
        // "silent" for the four buses that carry the feature, and could not tell
        // that apart from a broken lane mapping.
        CHECK(publishTone(p, 120.0, true, /*send1=*/1.0));

        juce::AudioBuffer<float> buf(p.getTotalNumOutputChannels(), 512);
        juce::MidiBuffer midi;
        std::vector<double> busPeak((size_t) wizard::plugin::kNumOutputBuses, 0.0);
        for (int b = 0; b < 40; ++b) {
            buf.clear();
            midi.clear();
            p.processBlock(buf, midi);
            for (int i = 0; i < wizard::plugin::kNumOutputBuses; ++i) {
                auto view = p.getBusBuffer(buf, false, i);
                for (int ch = 0; ch < view.getNumChannels(); ++ch)
                    busPeak[(size_t) i] =
                        juce::jmax(busPeak[(size_t) i], (double) view.getMagnitude(ch, 0, 512));
            }
        }
        for (int i = 0; i < wizard::plugin::kNumOutputBuses; ++i)
            std::printf("  bus %-9s peak %.5f\n", wizard::plugin::kOutputBuses[i].name,
                        busPeak[(size_t) i]);

        // MAIN must sing: a silent main here would mean asking for the full
        // multi-out layout broke the mix, which is the regression that matters.
        CHECK(busPeak[0] > 1e-4);

        // FIVE BUSES, AND THEY ARE THE FIVE THAT CARRY AUDIO (D1). Deck, Cue
        // and Return 1-4 are gone: Cue duplicated Main, Deck is silent unless
        // `djMode && dedicatedOutput` — which SPLITS the deck out of Main
        // rather than tapping it — and the Return lanes are the wet output of
        // internal return processors this host does not have (the internal
        // delay was retired in P6-3; hosted plugins are forbidden by
        // D-SL-DECKPLUGIN-01). Four buses of guaranteed silence with names that
        // promised otherwise.
        //
        // Pinned by NAME, not just by count, because a reordering that kept the
        // count would route the wrong lane to a named output silently — the
        // exact failure LaneMap's header warns about.
        CHECK(wizard::plugin::kNumOutputBuses == 5);
        CHECK(juce::String(wizard::plugin::kOutputBuses[0].name) == "Main");
        for (int i = 1; i <= 4; ++i) {
            CHECK(juce::String(wizard::plugin::kOutputBuses[i].name) == "Send " + juce::String(i));
            // The engine's send lanes are MONO and mirrored L→R by
            // LaneMap::finish; the host still sees stereo (Logic will not lay
            // out an instrument with a mono aux).
            CHECK(wizard::plugin::kOutputBuses[i].monoLane);
        }

        // AND SEND 1 CARRIES AUDIO. This is the claim D1 rests on: the deck
        // reaches a DAW effect track through this bus, and the DAW track is the
        // return. Buses 2-4 stay silent because only send 1 was raised — which
        // also proves the lane mapping is not smearing one send across all four.
        CHECK(busPeak[1] > 1e-4);
        CHECK(busPeak[2] < 1e-6);
        CHECK(busPeak[3] < 1e-6);
        CHECK(busPeak[4] < 1e-6);

        // The engine's send lane is MONO and LaneMap::finish mirrors it L→R, so
        // a host that only listens to the right channel is not handed silence.
        {
            auto view = p.getBusBuffer(buf, false, 1);
            CHECK(view.getNumChannels() == 2);
        }
    }

    // ── §2b-2 WARM ON RETURN FROM prepareToPlay ─────────────────────────────
    //
    // A DAW may roll the transport the instant prepareToPlay returns. The core
    // warms its bus stretchers on background threads by default (the app needs
    // that — a blocking configure cost it a ~660 ms launch hang), and while a
    // bus is cold it stays on its DRY path. So a plugin that inherited the
    // default would answer a tempo-follow request by playing at its OWN tempo
    // for a moment and then snapping — a fault that LOOKS like broken sync and
    // heals before you can inspect it.
    {
        ScoopyPluginProcessor p;
        const auto t0 = juce::Time::getMillisecondCounterHiRes();
        p.prepareToPlay(48000.0, 512);
        const auto elapsed = juce::Time::getMillisecondCounterHiRes() - t0;
        // Reported, not asserted: this is the price of the trade (a DAW pays it
        // once per instance at load) and it is worth SEEING when it moves.
        std::printf("  prepareToPlay with sync warm-up: %.0f ms\n", elapsed);
        // No sleep, no retry loop: the claim is precisely that it is ready by
        // the time prepareToPlay has returned. A poll here would pass on the
        // async path too and prove nothing.
        CHECK(sl_deck_stretch_ready(p.engineForTest(), 0) == 1);
    }

    // The APP's default must be untouched — this is shared core, and making a
    // plugin correct at the cost of a slower app launch would be a bad trade
    // made silently. A bare engine still warms in the background.
    {
        sl_engine* bare = sl_engine_create(48000.0, 512, 98);
        CHECK(bare != nullptr);
        CHECK(sl_engine_start(bare) == 1);
        CHECK(sl_deck_stretch_ready(bare, 0) == 0); // still warming, as before
        sl_engine_destroy(bare);
    }

    // ── §2c PDC: reported per MODE, and the number is real ──────────────────
    //
    // The failure this guards is a plausible-looking zero: if the ABI getter
    // returned 0 (unconfigured stretcher, wrong deck index, a silently failed
    // core call) the plugin would report no latency, the DAW would compensate
    // nothing, and the deck would simply play ~116 ms late against every other
    // track — audible, and attributable to almost anything.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);

        auto setMode = [&](int mode) {
            auto* o = new juce::DynamicObject();
            o->setProperty("tempoMode", mode);
            p.dispatchFromUi("hostSyncConfig", juce::var(o));
            p.pumpHostSync();
        };

        setMode(1); // timeStretch
        const int stretchLatency = p.getLatencySamples();
        std::printf("  timeStretch PDC: %d frames (%.1f ms @48k)\n", stretchLatency,
                    1000.0 * stretchLatency / 48000.0);
        // A real group delay, not a zero and not a nonsense value. The bus
        // stretcher's bank runs 25…960 ms windows, so anything in this range
        // is credible and anything outside it means we read the wrong thing.
        CHECK(stretchLatency > 0);
        CHECK(stretchLatency < (int) (48000 * 2)); // < 2 s, i.e. not garbage

        setMode(0); // timePitch — varispeed has NO group delay
        CHECK(p.getLatencySamples() == 0);
        setMode(2); // tempoOnly — the samples are untouched
        CHECK(p.getLatencySamples() == 0);

        // Back to stretch reports the SAME figure: PDC must be a function of
        // the mode alone, or a DAW would see it drift on every switch.
        setMode(1);
        CHECK(p.getLatencySamples() == stretchLatency);

        // And it must NOT move when only the host tempo does — the whole point
        // of scoping it to the mode (a ratio change here would be PDC churn).
        FakePlayHead head;
        head.bpm = 137.0;
        head.playing = true;
        p.setPlayHead(&head);
        renderPeak(p, 512, 1);
        p.pumpHostSync();
        CHECK(p.getLatencySamples() == stretchLatency);
    }

    // ── §2d THE PROJECT REOPENS AND MAKES SOUND, WITH NO EDITOR ─────────────
    //
    // The document normally lives in the web tier, which is NOT RUNNING until
    // somebody opens the plugin window. A DAW reloading a project expects
    // audio on the first bar regardless. So the processor journals what the
    // engine would need and replays it from the chunk — and the only honest
    // test of that is a FRESH processor that never had an editor, never had a
    // dispatch call, and is handed nothing but the saved bytes.
    {
        juce::MemoryBlock saved;
        double savedPeak = 0.0;
        {
            ScoopyPluginProcessor a;
            a.prepareToPlay(48000.0, 512);
            CHECK(publishTone(a, 132.0, true));
            savedPeak = renderPeak(a, 512, 24);
            CHECK(savedPeak > 1e-4);
            // Save with an INTERNAL master too — the whole point of putting it
            // in the recipe is that it survives a project the editor never
            // reopens (D-SL-DECKPLUGIN-02 · D2).
            {
                auto r = a.hostSync().currentRecipe();
                r.masterBpm = 99.0;
                a.hostSync().setRecipe(r);
            }
            // …and an ARRANGED WINDOW (§5). The editor was resizable and its
            // size was never written down, so every reopen threw away the
            // window the user had set up — in a DAW, where a plugin window is
            // furniture you arrange once.
            a.editorW = 1440;
            a.editorH = 900;
            a.performW = 900;
            a.performH = 460;
            a.getStateInformation(saved);
        }
        CHECK(saved.getSize() > 0);
        std::printf("  state chunk: %d bytes (gzipped, samples embedded)\n",
                    (int) saved.getSize());

        ScoopyPluginProcessor b;
        b.prepareToPlay(48000.0, 512);
        // Silent before: nothing has been published to this instance.
        CHECK(renderPeak(b, 512, 8) < 1e-6);

        b.setStateInformation(saved.getData(), (int) saved.getSize());
        const double reloadedPeak = renderPeak(b, 512, 24);
        CHECK(reloadedPeak > 1e-4); // ← the claim

        // The session tempo rides along too, or host sync would divide by a
        // bpm the reloaded instance never learned.
        const int32_t idSync = sl_param_id_for_name("syncRatio");
        FakePlayHead head;
        head.bpm = 132.0 * 1.5; // exactly 1.5× the saved session bpm
        head.playing = true;
        b.setPlayHead(&head);
        renderPeak(b, 512, 1);
        for (int i = 0; i < 3; ++i) b.pumpHostSync();
        // …and the INTERNAL MASTER rode along with it, so the reloaded deck
        // stretches against the typed 99 rather than this host's 198. Without
        // this the project would silently revert to host-follow on reload.
        CHECK(std::abs(b.hostSync().currentRecipe().masterBpm - 99.0) < 1e-9);
        CHECK(std::abs(sl_param_get(b.engineForTest(), 0, idSync) - 99.0 / 132.0) < 1e-3);

        // The window came back too — both modes, independently, so switching
        // PERF does not cost you the other mode's arrangement.
        CHECK(b.editorW == 1440 && b.editorH == 900);
        CHECK(b.performW == 900 && b.performH == 460);

        // …and the PERF edge drives the window through the processor, which is
        // what lets a size outlive the editor that set it. No editor is open
        // here, so `resizeEditor` is null — the call must be a quiet no-op
        // rather than a crash, since that is the normal state of a plugin the
        // DAW is merely playing.
        CHECK(!b.resizeEditor);
        const auto sized = b.dispatchFromUi("editorSize", juce::JSON::parse(R"({"perform":true})"));
        CHECK((bool) sized.getProperty("ok", false));
        const auto szResult = sized.getProperty("result", juce::var());
        CHECK((bool) szResult.getProperty("perform", false));
        CHECK((int) szResult.getProperty("width", 0) == 900);
        CHECK((int) szResult.getProperty("height", 0) == 460);

        // With an editor attached, the edge actually resizes — and only on a
        // CHANGE, so a repeated report does not fight a window the user is
        // dragging.
        int calls = 0, gotW = 0, gotH = 0;
        b.resizeEditor = [&](int w, int h) { ++calls; gotW = w; gotH = h; };
        b.dispatchFromUi("editorSize", juce::JSON::parse(R"({"perform":true})"));
        CHECK(calls == 0); // already performing — no edge
        b.dispatchFromUi("editorSize", juce::JSON::parse(R"({"perform":false})"));
        CHECK(calls == 1);
        CHECK(gotW == 1440 && gotH == 900);
        b.resizeEditor = nullptr;

        // Garbage in must not be half-loaded: a chunk from another plugin, or
        // a truncated one, leaves the instance as it was rather than in a
        // partly-rebuilt state that plays something nobody saved.
        ScoopyPluginProcessor c;
        c.prepareToPlay(48000.0, 512);
        const char junk[] = "not a scoopy chunk at all";
        c.setStateInformation(junk, (int) sizeof(junk));
        CHECK(renderPeak(c, 512, 8) < 1e-6);
        juce::MemoryBlock truncated(saved.getData(), saved.getSize() / 2);
        c.setStateInformation(truncated.getData(), (int) truncated.getSize());
        CHECK(renderPeak(c, 512, 8) < 1e-6);
    }

    // ── §2e PHASE: the deck lands ON the host's grid, not beside it ─────────
    //
    // Tempo sync alone is only half of "in sync". A deck that always starts at
    // step 0 whenever the DAW hits play runs at the right speed but sits at a
    // FIXED OFFSET from the host's bars — its beats fall between the DAW's
    // beats and stay there, which sounds like sloppy timing rather than like a
    // missing feature.
    //
    // The host's PPQ names the step to come in on. This checks the arithmetic
    // directly (which step for which bar position), because measuring the
    // rendered transient would also be measuring the pump's ~25 ms granularity
    // and the stretch group delay, and a test that mixes three effects tells
    // you nothing when it fails.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, true)); // an 8-step pattern

        FakePlayHead head;
        head.bpm = 120.0;
        head.playing = false;
        p.setPlayHead(&head);

        // 8 steps at 4 steps/quarter = 2 quarter notes of pattern.
        struct Case { double ppq; int expectStep; };
        const Case cases[] = {
            {0.0,   0}, // bar start
            {0.25,  1}, // one 16th in
            {0.5,   2},
            {1.0,   4}, // one quarter note in
            {2.0,   0}, // exactly one pattern length — wraps
            {2.25,  1},
            {3.5,   6},
            {-0.25, 7}, // DAW pre-roll / count-in: negative PPQ must wrap UP,
                        // not mirror around zero the way a truncating cast would
        };
        for (const auto& c : cases) {
            head.ppq = c.ppq;
            head.playing = false;
            renderPeak(p, 512, 1);
            p.pumpHostSync();          // settle the "stopped" edge
            head.playing = true;
            renderPeak(p, 512, 1);
            p.pumpHostSync();          // the play edge → aligned launch
            const int got = p.lastStartStepForTest();
            if (got != c.expectStep)
                std::fprintf(stderr, "  ppq %.2f: expected step %d, got %d\n",
                             c.ppq, c.expectStep, got);
            CHECK(got == c.expectStep);
        }
        std::printf("  host-grid phase alignment: %d/%d bar positions correct\n",
                    (int) (sizeof(cases) / sizeof(cases[0])),
                    (int) (sizeof(cases) / sizeof(cases[0])));
    }

    // ── §2f hostSyncConfig READS BACK, and the setting survives a save ──────
    //
    // The editor mounts with its own defaults. If it could only WRITE, opening
    // the plugin window on a project saved with the internal clock would stamp
    // `followTransport: true` back over it — the setting would appear to
    // forget itself, but only when you looked at it.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);

        auto read = [&] {
            const auto r = p.dispatchFromUi("hostSyncConfig", juce::var(new juce::DynamicObject()));
            return r.getProperty("result", juce::var());
        };

        // An empty payload is a pure read and must not disturb anything.
        CHECK((bool) read().getProperty("followTransport", false) == true);

        auto* set = new juce::DynamicObject();
        set->setProperty("followTransport", false);
        set->setProperty("tempoMode", 0);
        p.dispatchFromUi("hostSyncConfig", juce::var(set));
        CHECK((bool) read().getProperty("followTransport", true) == false);
        CHECK((int) read().getProperty("tempoMode", -1) == 0);

        // A partial write leaves the other fields ALONE — the editor sends
        // whichever fields it owns and must not blank the rest.
        auto* partial = new juce::DynamicObject();
        partial->setProperty("sessionBpm", 96.0);
        p.dispatchFromUi("hostSyncConfig", juce::var(partial));
        CHECK((bool) read().getProperty("followTransport", true) == false); // survived
        CHECK((double) read().getProperty("sessionBpm", 0.0) == 96.0);

        // …and it rides the project. INT must still be INT tomorrow.
        juce::MemoryBlock saved;
        p.getStateInformation(saved);
        ScoopyPluginProcessor q;
        q.prepareToPlay(48000.0, 512);
        q.setStateInformation(saved.getData(), (int) saved.getSize());
        const auto restored =
            q.dispatchFromUi("hostSyncConfig", juce::var(new juce::DynamicObject()))
                .getProperty("result", juce::var());
        CHECK((bool) restored.getProperty("followTransport", true) == false);
        CHECK((int) restored.getProperty("tempoMode", -1) == 0);
    }

    // ── §2g DAW MIDI IN: the ring survives a flood, and never hangs a note ──
    //
    // The audio thread writes; the pump drains. With no editor the events have
    // nowhere to go (the engine has no MIDI surface), and the ring must be
    // DROPPED rather than left to fill — otherwise opening the window later
    // fires a backlog of stale notes at once.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        juce::AudioBuffer<float> buf(p.getTotalNumOutputChannels(), 512);

        // Flood it well past capacity in a single block.
        juce::MidiBuffer midi;
        for (int i = 0; i < 1000; ++i)
            midi.addEvent(juce::MidiMessage::noteOn(1, 60 + (i % 8), (juce::uint8) 100), 0);
        buf.clear();
        p.processBlock(buf, midi);

        // MIDI OUT is v2 — the buffer must come back EMPTY rather than echoing
        // input, or every note played would double into the DAW's next device.
        CHECK(midi.getNumEvents() == 0);

        // No editor: draining must not deadlock, allocate unboundedly, or keep
        // the backlog. Two pumps and the ring is demonstrably reusable.
        p.pumpHostSync();
        p.pumpHostSync();

        // The ring still accepts new events after the flood — i.e. the indices
        // did not wedge (the failure a naive `read == write` full-test gives).
        juce::MidiBuffer more;
        more.addEvent(juce::MidiMessage::noteOn(1, 61, (juce::uint8) 100), 0);
        buf.clear();
        p.processBlock(buf, more);
        p.pumpHostSync();

        // Non-channel-voice traffic must never enter the ring: MIDI clock at
        // 24 ppqn would evict real notes within a bar.
        juce::MidiBuffer clock;
        for (int i = 0; i < 500; ++i) clock.addEvent(juce::MidiMessage::midiClock(), 0);
        buf.clear();
        p.processBlock(buf, clock);
        p.pumpHostSync();
    }

    // ── §3 TWO INSTANCES IN ONE PROCESS ─────────────────────────────────────
    {
        ScoopyPluginProcessor a;
        ScoopyPluginProcessor b;
        a.prepareToPlay(48000.0, 512);
        b.prepareToPlay(48000.0, 512);
        CHECK(a.engineForTest() != b.engineForTest());

        // Only A gets a world. If any state were shared, B would either sing
        // too (shared world) or A would fall silent (shared engine).
        CHECK(publishTone(a, 120.0, true));
        const double peakA = renderPeak(a, 512, 24);
        const double peakB = renderPeak(b, 512, 24);
        CHECK(peakA > 1e-4);
        CHECK(peakB < 1e-6); // B was never given anything to play

        // And the tempo axes are independent.
        FakePlayHead headA;
        headA.bpm = 150.0;
        headA.playing = true;
        a.setPlayHead(&headA);
        renderPeak(a, 512, 1);
        for (int i = 0; i < 3; ++i) a.pumpHostSync();
        const int32_t idSync = sl_param_id_for_name("syncRatio");
        CHECK(std::abs(sl_param_get(a.engineForTest(), 0, idSync) - 150.0 / 120.0) < 1e-3);
        CHECK(std::abs(sl_param_get(b.engineForTest(), 0, idSync) - 1.0) < 1e-9);
    }

    std::printf("plugin_processor_test OK\n");
    return 0;
}
