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

// The generated lane indices, for the playhead gate (§1b).
#include "sl_hotframe.inc"

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

    // ── §1b THE PLAYHEAD LANES (real-host report: "never worked") ───────────
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, true));
        renderPeak(p, 512, 8);

        std::vector<double> hf(sl_hotframe_length(), -999.0);
        const auto n = sl_hotframe(p.engineForTest(), hf.data(), (uint32_t) hf.size());
        CHECK(n > 0);
        std::printf("  playhead: deck0=%.0f djT0=%.0f djT1=%.0f pos=%.0f level=%.3f\n",
                    hf[SL_HF_playheadStepDeck0], hf[SL_HF_djTrackStepD0T0],
                    hf[SL_HF_djTrackStepD0T1], hf[SL_HF_djTrackPosD0T0],
                    hf[SL_HF_djTrackLevelD0T0]);
        CHECK(hf[SL_HF_playheadStepDeck0] >= 0.0);
        CHECK(hf[SL_HF_djTrackStepD0T0] >= 0.0);
    }

    // ── §1c HOST-GRID LAUNCH: the boundary is MUSICAL, the landing is EXACT ──
    //
    // D-SL-DECKPLUGIN-03 step 2. `armHostQuantizedLaunch(beats)` turns "the next
    // bar on the DAW's timeline" into an absolute engine frame, which is what
    // lets two instances land together without sharing anything: each resolves
    // the same host ppq through its own clock.
    //
    // Checked as ARITHMETIC rather than by listening, because the arithmetic is
    // the claim. At 120 BPM a beat is 0.5 s = 24000 frames @48k; sitting at
    // ppq 2.5 with a 4-beat quantum, the next bar line is ppq 4.0, i.e. 1.5
    // beats = 36000 frames away.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, true));

        FakePlayHead head;
        head.bpm = 120.0;
        head.ppq = 2.5;
        head.playing = true;
        p.setPlayHead(&head);
        renderPeak(p, 512, 1); // capture() anchors ppq to the engine clock

        const uint64_t anchor = p.hostSync().snapshot().engineTime;
        const uint64_t armed = p.armHostQuantizedLaunch(4.0);
        std::printf("  host launch: ppq %.2f q4 -> frame %llu (anchor %llu, +%lld)\n",
                    head.ppq, (unsigned long long) armed, (unsigned long long) anchor,
                    (long long) (armed - anchor));
        CHECK(armed > 0);
        CHECK(armed - anchor == 36000);

        // The quantum is honoured, not assumed: a 1-beat grid from ppq 2.5 is
        // ppq 3.0, half a beat = 12000 frames.
        CHECK(p.armHostQuantizedLaunch(1.0) - anchor == 12000);
        // …and 16 beats (four bars) lands on ppq 16, not on the next bar.
        CHECK(p.armHostQuantizedLaunch(16.0) - anchor == 324000);

        // STRICTLY AHEAD: sitting exactly on a boundary must arm the NEXT one,
        // never resolve behind the playhead where it would fire immediately.
        head.ppq = 4.0;
        renderPeak(p, 512, 1);
        const uint64_t onGrid = p.hostSync().snapshot().engineTime;
        CHECK(p.armHostQuantizedLaunch(4.0) - onGrid == 96000); // ppq 8, a full bar on

        // …and the same thing through the DISPATCH seam the web will call, so
        // the wire is pinned and not just the C++ behind it. `frame` rides as a
        // double: juce::var's int is 32-bit and a frame counter overflows that
        // in about twelve hours at 48k.
        {
            head.ppq = 2.5;
            renderPeak(p, 512, 1);
            const auto anchor2 = p.hostSync().snapshot().engineTime;
            const auto reply =
                p.dispatchFromUi("deckLaunch", juce::JSON::parse(R"({"quantumBeats":4})"));
            CHECK((bool) reply.getProperty("ok", false));
            const double frame =
                (double) reply.getProperty("result", juce::var()).getProperty("frame", 0.0);
            CHECK(frame - (double) anchor2 == 36000.0);
            // A nonsense quantum answers 0 rather than failing the call: "there
            // is no grid to wait on" is an outcome, not an error.
            const auto none =
                p.dispatchFromUi("deckLaunch", juce::JSON::parse(R"({"quantumBeats":0})"));
            CHECK((bool) none.getProperty("ok", false));
            CHECK((double) none.getProperty("result", juce::var()).getProperty("frame", -1.0)
                  == 0.0);

            // THE QUANTUM SETTING rides the same method and defaults to the
            // donor's own default, so a fresh instance behaves like the app.
            const auto read = p.dispatchFromUi("deckLaunch", juce::JSON::parse("{}"));
            CHECK(read.getProperty("result", juce::var()).getProperty("quantum", "").toString()
                  == "cycle");
            const auto set =
                p.dispatchFromUi("deckLaunch", juce::JSON::parse(R"({"quantum":"16"})"));
            CHECK(set.getProperty("result", juce::var()).getProperty("quantum", "").toString()
                  == "16");
        }

        // REFUSALS — each returns 0 so the caller launches now rather than
        // leaving the deck held forever on a grid that does not exist.
        CHECK(p.armHostQuantizedLaunch(0.0) == 0);
        CHECK(p.armHostQuantizedLaunch(-4.0) == 0);
        head.playing = false; // a stopped host has no grid to land on
        renderPeak(p, 512, 1);
        CHECK(p.armHostQuantizedLaunch(4.0) == 0);
        p.setPlayHead(nullptr); // and neither has a host with no playhead
        renderPeak(p, 512, 1);
        CHECK(p.armHostQuantizedLaunch(4.0) == 0);
    }

    // ── §1d PEERS: deck B waits on deck A's CYCLE (step 4) ──────────────────
    //
    // The one question the host clock cannot answer. Steps 1-3 let both decks
    // land on the same BAR with nothing shared; landing on A's CYCLE needs A's
    // length and phase, which is what the process-wide row carries.
    //
    // ⚠️ Two processors in ONE process, which is the only place this works —
    // Bitwig sandboxes each plugin and a VST3 cannot see an AU. The fallback is
    // asserted below precisely because those cases are permanent.
    {
        ScoopyPluginProcessor a;
        ScoopyPluginProcessor b;
        a.prepareToPlay(48000.0, 512);
        b.prepareToPlay(48000.0, 512);
        CHECK(publishTone(a, 120.0, true));
        CHECK(publishTone(b, 120.0, true));
        CHECK(a.peerSlotForTest() >= 0);
        CHECK(b.peerSlotForTest() >= 0);
        CHECK(a.peerSlotForTest() != b.peerSlotForTest()); // no shared row

        FakePlayHead head;
        head.bpm = 120.0;
        head.playing = true;
        head.ppq = 0.0;
        a.setPlayHead(&head);
        b.setPlayHead(&head); // one DAW timeline, as a host gives every instance
        renderPeak(a, 512, 1);
        renderPeak(b, 512, 1);

        // A launches on a bar and publishes an 8-beat cycle (a 32-step pattern).
        const uint64_t aFrame = a.armHostQuantizedLaunch(4.0);
        CHECK(aFrame > 0);
        a.publishPeerCycle(8.0, true);

        // B, on `cycle`, must now wait for A's boundary rather than its own.
        // A came in at ppq 4 with an 8-beat cycle, so its boundaries are
        // 4, 12, 20… From ppq 0 the first ahead is 4 — 2 s = 96000 frames.
        head.ppq = 0.0;
        renderPeak(b, 512, 1);
        const uint64_t anchorB = b.hostSync().snapshot().engineTime;
        juce::String ref;
        const uint64_t bFrame = b.armPeerQuantizedLaunch(ref);
        std::printf("  peer launch: B waits on \"%s\" -> +%lld frames\n",
                    ref.toRawUTF8(), (long long) (bFrame - anchorB));
        CHECK(bFrame > 0);
        CHECK(bFrame - anchorB == 96000);
        CHECK(ref.isNotEmpty()); // it says WHAT it is waiting on

        // A DECK STARTED WITHOUT AN ARM still advertises a real phase.
        //
        // It reaches "playing" plenty of ways that never arm — quantum `off`,
        // the DAW's transport follow, the keyboard. Before this the anchor was
        // only ever written by a successful arm, so such a deck published ppq 0
        // (or the previous run's boundary) and a peer landed on a grid it had
        // never played to. Silently, looking like sync being subtly off.
        {
            ScoopyPluginProcessor c;
            c.prepareToPlay(48000.0, 512);
            CHECK(publishTone(c, 120.0, true));
            CHECK(c.peerSlotForTest() >= 0);
            head.ppq = 3.0; // came in mid-bar, by hand
            c.setPlayHead(&head);
            renderPeak(c, 512, 1);
            c.publishPeerCycle(8.0, true); // no arm ever ran on this instance

            // A fresh deck resolving against it must see ppq 3, not ppq 0:
            // boundaries 3, 11, 19… From ppq 0 the first ahead is 3 — 1.5 s.
            ScoopyPluginProcessor d;
            d.prepareToPlay(48000.0, 512);
            CHECK(publishTone(d, 120.0, true));
            // Silence the earlier pair so `auto` resolves to `c`, not to them.
            a.publishPeerCycle(8.0, false);
            b.publishPeerCycle(8.0, false);
            head.ppq = 0.0;
            d.setPlayHead(&head);
            renderPeak(d, 512, 1);
            const uint64_t anchorD = d.hostSync().snapshot().engineTime;
            juce::String r;
            const uint64_t dFrame = d.armPeerQuantizedLaunch(r);
            CHECK(dFrame > 0);
            CHECK(dFrame - anchorD == 72000); // 3 beats @120 = 1.5 s @48k

            // …and STOPPING clears it, so the next run gets its own phase
            // rather than inheriting this one's.
            c.publishPeerCycle(8.0, false);
            head.ppq = 5.0;
            renderPeak(c, 512, 1);
            c.publishPeerCycle(8.0, true);
            head.ppq = 0.0;
            renderPeak(d, 512, 1);
            const uint64_t anchorD2 = d.hostSync().snapshot().engineTime;
            const uint64_t d2 = d.armPeerQuantizedLaunch(r);
            CHECK(d2 > 0);
            CHECK(d2 - anchorD2 == 120000); // now ppq 5 — 5 beats, not 3
            c.publishPeerCycle(8.0, false);
        }

        // Restore the pair for the assertions below.
        a.publishPeerCycle(8.0, true);

        // A STOPPED peer is not a reference — waiting on a boundary that will
        // never come round is the hang this whole design refuses.
        a.publishPeerCycle(8.0, /*playing*/ false);
        juce::String none;
        CHECK(b.armPeerQuantizedLaunch(none) == 0);
        CHECK(none.isEmpty());

        // …and neither is a peer with no resolvable cycle (an empty session).
        a.publishPeerCycle(0.0, true);
        CHECK(b.armPeerQuantizedLaunch(none) == 0);

        // THE FALLBACK, through the dispatch seam the web calls: with no usable
        // peer, `cycle` resolves against our own host grid and SAYS so. This is
        // the Bitwig / cross-format case, which is permanent rather than
        // transient — it must degrade honestly, not wait forever.
        const auto reply = b.dispatchFromUi(
            "deckLaunch", juce::JSON::parse(R"({"quantum":"cycle","quantumBeats":4})"));
        CHECK((bool) reply.getProperty("ok", false));
        const auto res = reply.getProperty("result", juce::var());
        CHECK((double) res.getProperty("frame", 0.0) > 0.0);
        CHECK(res.getProperty("ref", "").toString() == "host grid");
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
            // …and WHICH SESSION this instance holds. Without it the chunk
            // replayed the right audio while the editor had no idea what it
            // was, manufactured an `Untitled`, and showed an empty grid over a
            // correctly-playing deck — the same call that filled the user's
            // shared library with one `Untitled N` per insert.
            a.dispatchFromUi("pluginSession", juce::JSON::parse(R"({"name":"beach"})"));
            // …and the launch quantum, which is PER INSTANCE by ruling: two
            // decks in one set may run different ones.
            a.dispatchFromUi("deckLaunch", juce::JSON::parse(R"({"quantum":"8"})"));
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

        // The window came back too.
        CHECK(b.editorW == 1440 && b.editorH == 900);

        // …and so did the session's IDENTITY, which is what lets the editor
        // reopen the document this instance was playing. Per-instance on
        // purpose: a shared "most recent" pointer would race across decks —
        // whichever saved last would win, and every new insert would inherit
        // whatever another deck happened to touch.
        {
            const auto s = b.dispatchFromUi("pluginSession", juce::JSON::parse("{}"));
            CHECK((bool) s.getProperty("ok", false));
            CHECK(s.getProperty("result", juce::var()).getProperty("name", "").toString() ==
                  "beach");
        }
        {
            const auto q = b.dispatchFromUi("deckLaunch", juce::JSON::parse("{}"));
            CHECK(q.getProperty("result", juce::var()).getProperty("quantum", "").toString()
                  == "8");
        }

        // A NEVER-USED instance answers an explicit null, not an empty string:
        // "this deck has never held a session" and "it holds one called ''" want
        // opposite behaviour on boot, so the page must be able to tell them apart.
        {
            ScoopyPluginProcessor fresh;
            const auto s = fresh.dispatchFromUi("pluginSession", juce::JSON::parse("{}"));
            CHECK(s.getProperty("result", juce::var()).getProperty("name", "x").isVoid());
        }

        // …and the page's own grip drives the window through the processor,
        // which is what lets a size outlive the editor that set it. No editor is
        // open here, so `resizeEditor` is null — the call must be a quiet no-op
        // rather than a crash, since that is the normal state of a plugin the
        // DAW is merely playing.
        //
        // ⚠️ There is deliberately NO `perform` arm. One briefly existed and
        // swapped between two remembered sizes on the PERF edge, so arming a
        // locator drag resized the user's window (rejected 2026-08-01).
        CHECK(!b.resizeEditor);
        int calls = 0, gotW = 0, gotH = 0;
        b.resizeEditor = [&](int w, int h) { ++calls; gotW = w; gotH = h; };
        const auto sized =
            b.dispatchFromUi("editorSize", juce::JSON::parse(R"({"width":1280,"height":800})"));
        CHECK((bool) sized.getProperty("ok", false));
        CHECK(calls == 1 && gotW == 1280 && gotH == 800);
        CHECK(b.editorW == 1280 && b.editorH == 800);
        // Clamped to the editor's own limits, so the page cannot ask for a
        // window the constrainer refuses and end up with nothing happening.
        b.dispatchFromUi("editorSize", juce::JSON::parse(R"({"width":99,"height":99})"));
        CHECK(gotW == 720 && gotH == 480);
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

    // ── §2h A CONTROL EDIT MUST NOT STOP THE DAW'S PLAYBACK ─────────────────
    //
    // Reported from the real host, 2026-08-02: "start playback through the host,
    // then operate any control in the VST window, and playback stops. Only
    // plugin-internal playback is stable against UI changes."
    //
    // The mechanism, and it is a seam rather than a slip. The DAW's play edge
    // starts the deck from the PROCESSOR (`applyCachedWorld`); the web tier
    // never hears about it, so its own `playing` flag stays false. Every world
    // publish carries that flag — and a grid edit, a scene switch, a fader is a
    // world publish. So the first control the user touched republished
    // `isPlaying: false` over a deck the host had started, and the audio
    // stopped. Internal playback was immune only because the web's flag was
    // then true, which is exactly the "each side looks correct alone" shape.
    //
    // The rule this pins: A WORLD PUBLISH CARRIES CONTENT; TRANSPORT INTENT
    // TRAVELS ONLY WHEN STATED. The engine already made this call one field
    // over — `launchArmed` survives a snapshot rebuild (sl_engine.cpp:1524)
    // because "rebuilding the session's content is not a statement about
    // transport". `isPlaying` is the same kind of field.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);
        CHECK(publishTone(p, 120.0, false)); // the page's world: stopped

        FakePlayHead head;
        head.bpm = 120.0;
        head.ppq = 0.0;
        head.playing = false;
        p.setPlayHead(&head);
        renderPeak(p, 512, 1);
        p.pumpHostSync(); // settle the stopped edge

        // The DAW hits play — the deck comes in on the host's grid.
        head.playing = true;
        renderPeak(p, 512, 1);
        p.pumpHostSync();
        CHECK(renderPeak(p, 512, 24) > 1e-4);

        // …and now the user touches a control. The page republishes its world
        // with the transport flag it still believes (`false`), because nothing
        // told it the DAW started the deck. THE AUDIO MUST NOT STOP.
        CHECK(publishTone(p, 120.0, false));
        CHECK(renderPeak(p, 512, 24) > 1e-4);

        // A second edit, and one that CHANGES the world (a send level), so this
        // is not passing on some "identical publish" shortcut.
        //
        // …AND IT DOES NOT RESTART THE PATTERN. Surviving the publish is only
        // half of "the music kept going": the flag is stamped playing, but the
        // world also carries `startStep: 0`, so a deck that re-entered from the
        // top on every knob turn would still pass every peak check above while
        // being unusable. The step counter is monotonic, so it may only move
        // FORWARD across an edit.
        auto stepNow = [&] {
            std::vector<double> hf(sl_hotframe_length(), -999.0);
            sl_hotframe(p.engineForTest(), hf.data(), (uint32_t) hf.size());
            return hf[SL_HF_playheadStepDeck0];
        };
        const double before = stepNow();
        CHECK(before > 0.0); // it has been running for a while by now
        CHECK(publishTone(p, 120.0, false, 0.5));
        CHECK(renderPeak(p, 512, 24) > 1e-4);
        CHECK(stepNow() >= before);

        // ◼ STILL STOPS IT. The page states the intent — `transportIntent` on
        // the publish envelope — and a stated intent is honoured, host rolling
        // or not. Without this the fix would trade a deck that stops when you
        // touch a knob for a deck you cannot stop at all, which is the worse
        // half of the same bug.
        {
            auto* stop = new juce::DynamicObject();
            stop->setProperty("action", "publish");
            stop->setProperty("transportIntent", true);
            auto world = juce::JSON::parse(
                R"({"deck":0,"bpm":120.0,"isPlaying":false,"startStep":0,)"
                R"("tracks":[{"sampleId":"tone","steps":[1,1,1,1,1,1,1,1],"volume":1.0}]})");
            stop->setProperty("world", world);
            const auto reply = p.dispatchFromUi("slWorld", juce::var(stop));
            CHECK((bool) reply.getProperty("ok", false));
        }
        CHECK(renderPeak(p, 512, 24) < 1e-6);

        // …and the stop STAYS stopped through the next edit. Clearing the latch
        // is what makes that true: without it the very next control touch would
        // be stamped back into playing, and ◼ would look like it bounced.
        CHECK(publishTone(p, 120.0, false));
        CHECK(renderPeak(p, 512, 24) < 1e-6);

        // The DAW's own transport is still the way back in: stop, play, and the
        // deck runs again on the host's grid.
        head.playing = false;
        renderPeak(p, 512, 1);
        p.pumpHostSync();
        head.playing = true;
        renderPeak(p, 512, 1);
        p.pumpHostSync();
        CHECK(renderPeak(p, 512, 24) > 1e-4);

        // CLK INT hands the transport back to the page. The deck keeps playing
        // (nothing stopped it), but the next incidental publish is the page's
        // word again — a deck the DAW no longer drives must not be pinned
        // playing by a latch the DAW set.
        auto* clkInt = new juce::DynamicObject();
        clkInt->setProperty("followTransport", false);
        p.dispatchFromUi("hostSyncConfig", juce::var(clkInt));
        CHECK(publishTone(p, 120.0, false));
        CHECK(renderPeak(p, 512, 24) < 1e-6);

        // The page can READ the host's transport, which is how a window opened
        // mid-playback learns what the DAW is doing at all: `hostTransport` is
        // change-detected and fires on the editor's timer, so an editor created
        // after the play edge would otherwise never hear one.
        const auto rec = p.dispatchFromUi("hostSyncConfig", juce::var(new juce::DynamicObject()))
                             .getProperty("result", juce::var());
        CHECK((bool) rec.getProperty("hostPlaying", false) == true);
    }

    // ── §2h-2 THE WINDOW OPENS WHILE THE DAW IS ALREADY ROLLING ─────────────
    //
    // The other half of the same seam, and the one nobody would think to try:
    // the transport was already running when this instance came up (a project
    // reopened mid-playback, a plugin inserted during a take), so the play edge
    // found NO cached world and started nothing. The page then boots, opens its
    // session and publishes it — stopped, because the store has never heard of
    // the DAW.
    //
    // That publish must come in PLAYING, and on the host's grid. Left alone it
    // would sit silent behind a transport that says ▸, which reads as a dead
    // plugin rather than as a deck waiting for something.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);

        FakePlayHead head;
        head.bpm = 120.0;
        head.ppq = 1.0; // one quarter note in — step 4 of an 8-step pattern
        head.playing = true;
        p.setPlayHead(&head);
        renderPeak(p, 512, 1);
        p.pumpHostSync(); // the play edge, with nothing yet to launch

        CHECK(publishTone(p, 120.0, false)); // the page's first world
        CHECK(renderPeak(p, 512, 24) > 1e-4);
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

    // ── §4 HOST AUTOMATION: the DAW as the modulation source ────────────────
    //
    // D-SL-DECKPLUGIN-04. The donor's M1–M4 mod bank never came across; instead
    // the TARGETS are host parameters and the DAW's LFOs and automation lanes
    // are the sources. What has to hold: the layout is exactly what a released
    // plugin promised (a DAW addresses automation by index and id, so a
    // reordering silently re-points a user's curves), a moved lane actually
    // moves the sound, and the values survive a project round-trip.
    {
        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);

        // The layout, frozen: 16 tracks × 8 targets + 2 deck + 1 master.
        CHECK(p.hostParams().size() == 131);
        CHECK(p.getParameters().size() == 131);

        // Spot-check the id space at both ends and in the middle. These strings
        // are a released contract, not an implementation detail.
        CHECK(p.hostParams().find("d0.t00.pitch") != nullptr);
        CHECK(p.hostParams().find("d0.t15.send4") != nullptr);
        CHECK(p.hostParams().find("d0.t07.tone") != nullptr);
        CHECK(p.hostParams().find("d0.transpose") != nullptr);
        CHECK(p.hostParams().find("d0.texture") != nullptr);
        CHECK(p.hostParams().find("master.level") != nullptr);
        CHECK(p.hostParams().find("d0.t16.pitch") == nullptr); // 16 tracks, 0-based
        CHECK(p.hostParams().find("nope") == nullptr);

        // Every lane is neutral at load and automatable — a parameter the host
        // cannot automate would be a control that looks present and cannot be
        // driven, which is this whole feature failing quietly.
        for (auto* param : p.getParameters()) {
            CHECK(param->getValue() == param->getDefaultValue());
            CHECK(param->isAutomatable());
        }
        auto* pitch = p.hostParams().find("d0.t00.pitch");
        auto* volume = p.hostParams().find("d0.t00.volume");
        CHECK(pitch != nullptr && volume != nullptr);
        CHECK(std::abs(pitch->convertFrom0to1(pitch->getValue())) < 1e-6);   // 0 st
        CHECK(std::abs(volume->convertFrom0to1(volume->getValue())) < 1e-6);

        // A moved lane reaches the ENGINE, in the units the ABI speaks, and it
        // gets there on a rendered block rather than on the 40 Hz pump — the
        // pump is never ticked in this scope.
        CHECK(publishTone(p, 120.0, true));
        const double loud = renderPeak(p, 512, 24);
        CHECK(loud > 1e-4);

        pitch->setValueNotifyingHost(pitch->convertTo0to1(12.0f));
        renderPeak(p, 512, 1);
        const int32_t pitchMod = sl_track_mod_id_for_name("pitch");
        CHECK(pitchMod != SL_PARAM_UNKNOWN);
        CHECK(std::abs(sl_track_mod_get(p.engineForTest(), 0, 0, pitchMod) - 12.0) < 1e-4);

        // …and the sound follows: volume offset −1 against a base of 1.0 takes
        // the track to silence.
        pitch->setValueNotifyingHost(pitch->convertTo0to1(0.0f));
        volume->setValueNotifyingHost(volume->convertTo0to1(-1.0f));
        // Two blocks discarded first: the offset joins the core's 4 ms declick
        // ramp, so the block it arrives on still carries the tail of the old
        // value. Measuring across the transient would be measuring the ramp.
        renderPeak(p, 512, 2);
        const double quiet = renderPeak(p, 512, 24);
        CHECK(quiet < loud * 0.05);

        // Master is dB on the lane, a multiplier in the engine.
        auto* master = p.hostParams().find("master.level");
        master->setValueNotifyingHost(master->convertTo0to1(-6.0f));
        renderPeak(p, 512, 1);
        CHECK(std::abs(sl_master_mod(p.engineForTest()) -
                       juce::Decibels::decibelsToGain(-6.0)) < 1e-6);
    }

    // §4b THE PROJECT ROUND-TRIP — offsets are part of the document.
    {
        ScoopyPluginProcessor a;
        a.prepareToPlay(48000.0, 512);
        CHECK(publishTone(a, 120.0, true));
        a.hostParams().find("d0.t00.pitch")->setValueNotifyingHost(
            a.hostParams().find("d0.t00.pitch")->convertTo0to1(-7.0f));
        a.hostParams().find("d0.t03.send2")->setValueNotifyingHost(
            a.hostParams().find("d0.t03.send2")->convertTo0to1(0.5f));
        a.hostParams().find("master.level")->setValueNotifyingHost(
            a.hostParams().find("master.level")->convertTo0to1(3.0f));

        juce::MemoryBlock chunk;
        a.getStateInformation(chunk);
        CHECK(chunk.getSize() > 0);

        ScoopyPluginProcessor b;
        b.prepareToPlay(48000.0, 512);
        b.setStateInformation(chunk.getData(), (int) chunk.getSize());

        auto* bp = b.hostParams().find("d0.t00.pitch");
        auto* bs = b.hostParams().find("d0.t03.send2");
        auto* bm = b.hostParams().find("master.level");
        CHECK(std::abs(bp->convertFrom0to1(bp->getValue()) + 7.0f) < 1e-3);
        CHECK(std::abs(bs->convertFrom0to1(bs->getValue()) - 0.5f) < 1e-3);
        CHECK(std::abs(bm->convertFrom0to1(bm->getValue()) - 3.0f) < 1e-3);
        // Untouched lanes come back neutral, not carrying a's other values.
        auto* bv = b.hostParams().find("d0.t00.volume");
        CHECK(std::abs(bv->convertFrom0to1(bv->getValue())) < 1e-6);

        // And the restore REACHES THE ENGINE with no separate apply path: the
        // first rendered block pushes everything, which is what the NaN-seeded
        // change gate buys.
        renderPeak(b, 512, 2);
        const int32_t pitchMod = sl_track_mod_id_for_name("pitch");
        CHECK(std::abs(sl_track_mod_get(b.engineForTest(), 0, 0, pitchMod) + 7.0) < 1e-4);
        CHECK(std::abs(sl_master_mod(b.engineForTest()) -
                       juce::Decibels::decibelsToGain(3.0)) < 1e-6);

        // A PRE-AUTOMATION PROJECT still opens, fully neutral. Built by taking
        // this chunk back to v2 and dropping the key — which is exactly the
        // shape every project saved before this feature has on disk.
        juce::MemoryBlock raw;
        {
            juce::MemoryInputStream in(chunk, false);
            juce::GZIPDecompressorInputStream gz(in);
            juce::MemoryOutputStream out(raw, false);
            out.writeFromInputStream(gz, -1);
        }
        juce::MemoryInputStream in(raw, false);
        char magic[4] = {};
        in.read(magic, 4);
        CHECK(in.readInt() == 3); // the chunk we just wrote IS v3
        const int headerBytes = in.readInt();
        juce::MemoryBlock hb;
        hb.setSize((size_t) headerBytes, true);
        in.read(hb.getData(), headerBytes);
        auto header = juce::JSON::parse(
            juce::String::fromUTF8((const char*) hb.getData(), headerBytes));
        CHECK(header.getDynamicObject() != nullptr);
        CHECK(header.getDynamicObject()->hasProperty("hostParams"));
        header.getDynamicObject()->removeProperty("hostParams");
        const auto newHeader = juce::JSON::toString(header, true);
        const int newBytes = (int) newHeader.getNumBytesAsUTF8();
        std::vector<char> tail((size_t) in.getNumBytesRemaining());
        if (!tail.empty()) in.read(tail.data(), (int) tail.size());

        juce::MemoryBlock legacy;
        {
            juce::MemoryBlock plain;
            {
                juce::MemoryOutputStream o(plain, false);
                o.write("SCDK", 4);
                o.writeInt(2); // the version that knew nothing about automation
                o.writeInt(newBytes);
                o.write(newHeader.toRawUTF8(), (size_t) newBytes);
                if (!tail.empty()) o.write(tail.data(), tail.size());
            }
            juce::MemoryOutputStream c(legacy, false);
            juce::GZIPCompressorOutputStream gz(c);
            gz.write(plain.getData(), plain.getSize());
        }

        ScoopyPluginProcessor old;
        old.prepareToPlay(48000.0, 512);
        old.setStateInformation(legacy.getData(), (int) legacy.getSize());
        auto* op = old.hostParams().find("d0.t00.pitch");
        CHECK(std::abs(op->convertFrom0to1(op->getValue())) < 1e-6); // neutral
        CHECK(renderPeak(old, 512, 24) > 1e-4);                      // and it plays
    }

    // §4d paramTouch: the door Ableton's Configure discovers parameters through.
    //
    // Live captures a parameter when it sees one TOUCHED, and this window is a
    // WebView whose controls never touch a juce parameter — so Configure saw
    // nothing and adding a control by clicking was impossible. The page now says
    // which offset it touched and the processor answers with an empty gesture.
    {
        struct GestureCounter final : juce::AudioProcessorParameter::Listener {
            int starts = 0, ends = 0;
            float valueChanges = 0;
            void parameterValueChanged(int, float) override { valueChanges += 1.0f; }
            void parameterGestureChanged(int, bool starting) override {
                if (starting) ++starts; else ++ends;
            }
        };

        ScoopyPluginProcessor p;
        p.prepareToPlay(48000.0, 512);

        auto* pitch = p.hostParams().find("d0.t02.pitch");
        auto* send3 = p.hostParams().find("d0.t02.send3");
        CHECK(pitch != nullptr && send3 != nullptr);
        GestureCounter onPitch, onSend3;
        pitch->addListener(&onPitch);
        send3->addListener(&onSend3);

        const auto touch = [&](int track, const char* target) {
            auto* o = new juce::DynamicObject();
            o->setProperty("track", track);
            o->setProperty("target", target);
            const auto reply = p.dispatchFromUi("paramTouch", juce::var(o));
            return (bool) reply.getProperty("result", juce::var())
                              .getProperty("announced", false);
        };

        // First touch announces: a matched begin/end pair, and NO value change —
        // the host learns the control exists without anything being written.
        CHECK(touch(2, "pitch"));
        CHECK(onPitch.starts == 1);
        CHECK(onPitch.ends == 1);
        CHECK(onPitch.valueChanges == 0.0f);
        CHECK(std::abs(pitch->convertFrom0to1(pitch->getValue())) < 1e-6); // still neutral

        // …and only the first. Configure needs one gesture; a gesture is also
        // what latches a parameter for automation recording, so a drag firing
        // this per frame would punch envelopes nobody asked for.
        CHECK(!touch(2, "pitch"));
        CHECK(!touch(2, "pitch"));
        CHECK(onPitch.starts == 1);

        // Each control announces itself independently.
        CHECK(onSend3.starts == 0); // pitch's touch was not smeared across the row
        CHECK(touch(2, "send3"));
        CHECK(onSend3.starts == 1);

        // Refusals are refusals: no gesture, and a truthful `announced:false`.
        CHECK(!touch(2, "nope"));       // not a target
        CHECK(!touch(2, "transpose"));  // a DECK target, not a track one
        CHECK(!touch(99, "pitch"));     // past the declared track count
        CHECK(!touch(-1, "pitch"));
        CHECK(onPitch.starts == 1 && onSend3.starts == 1);

        pitch->removeListener(&onPitch);
        send3->removeListener(&onSend3);
    }

    // §4c Automation is PER INSTANCE — two decks in one project, one automated.
    {
        ScoopyPluginProcessor a, b;
        a.prepareToPlay(48000.0, 512);
        b.prepareToPlay(48000.0, 512);
        CHECK(publishTone(a, 120.0, true));
        CHECK(publishTone(b, 120.0, true));
        a.hostParams().find("d0.t00.volume")->setValueNotifyingHost(
            a.hostParams().find("d0.t00.volume")->convertTo0to1(-1.0f));
        const double peakA = renderPeak(a, 512, 24);
        const double peakB = renderPeak(b, 512, 24);
        CHECK(peakA < 1e-5);   // silenced by its own lane
        CHECK(peakB > 1e-4);   // and its neighbour is untouched
    }

    std::printf("plugin_processor_test OK\n");
    return 0;
}
