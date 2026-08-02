// SCOOPY TAPE IS AN INSERT — headless, no host, no window server.
//
// ScoopyDeck's gate asks "does it make a sound". An effect's first duty is the
// opposite one and it is the claim a DAW would otherwise be first to test:
// dropping this on a track must not COST that track its audio. Every failure
// mode below is silent-or-worse in a real session, and none is caught by a
// green build.
//
//   §1 THRU          a stereo insert returns what it was given. The engine's
//                    main sums ON TOP of the dry; with nothing looping the
//                    output is the input.
//   §2 NOT-READY     a processor that never got prepareToPlay (or is mid
//     IS THRU        render-detach) leaves the buffer ALONE. Clearing would be
//                    the loudest possible way to fail — it mutes the track.
//   §3 CHUNKING      blocks larger than the engine's, and blocks that do not
//                    divide it, at three sample rates.
//   §4 LAYOUT        stereo in/out accepted; mono refused rather than
//                    half-supported (a mono layout would drop every loop's
//                    right channel silently).
//   §5 TWO           two processors in one process render independently — the
//     INSTANCES      vendored core was never audited for statics and every DAW
//                    loads N of these.
//   §6 THE TAPE      the tier this whole product is built on answers through
//     IS REACHABLE   the dispatcher from inside the plugin.
//
// It compiles the plugin's own sources (never a copy) — a harness built against
// a parallel processor would measure the harness.
#include "ScoopyTapeProcessor.h"
#include "sl_engine.h"

#include <cmath>
#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
using wizard::plugin::ScoopyTapeProcessor;

constexpr double kPi = 3.14159265358979;

/** A 220 Hz tone at 0.5, the signal a track would be feeding the insert. */
void fillTone(juce::AudioBuffer<float>& buf, double rate, int startSample = 0) {
    for (int c = 0; c < buf.getNumChannels(); ++c)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            buf.setSample(c, i,
                          (float) (0.5 * std::sin(2.0 * kPi * 220.0 * (startSample + i) / rate)));
}

double peakOf(const juce::AudioBuffer<float>& buf) {
    double peak = 0.0;
    for (int c = 0; c < buf.getNumChannels(); ++c)
        for (int i = 0; i < buf.getNumSamples(); ++i)
            peak = juce::jmax(peak, (double) std::abs(buf.getSample(c, i)));
    return peak;
}

/** Largest absolute difference between two buffers of the same shape. */
double maxDiff(const juce::AudioBuffer<float>& a, const juce::AudioBuffer<float>& b) {
    double d = 0.0;
    for (int c = 0; c < a.getNumChannels(); ++c)
        for (int i = 0; i < a.getNumSamples(); ++i)
            d = juce::jmax(d, (double) std::abs(a.getSample(c, i) - b.getSample(c, i)));
    return d;
}

int runThru(double rate, int blockSize) {
    ScoopyTapeProcessor p;
    p.prepareToPlay(rate, blockSize);

    juce::AudioBuffer<float> buf(2, blockSize);
    juce::AudioBuffer<float> reference(2, blockSize);
    juce::MidiBuffer midi;

    for (int b = 0; b < 8; ++b) {
        fillTone(buf, rate, b * blockSize);
        reference.makeCopyOf(buf);
        midi.clear();
        p.processBlock(buf, midi);
        // §1: nothing is looping, so the engine contributes silence and the
        // output must be the input — bit-for-bit is too strong a claim across
        // a float sum, but anything above the noise floor is a real defect.
        if (maxDiff(buf, reference) > 1e-6) {
            std::fprintf(stderr, "FAIL thru @%g Hz block %d: diff %g\n", rate, blockSize,
                         maxDiff(buf, reference));
            return 1;
        }
    }
    return 0;
}

} // namespace

int main() {
    // §1 + §3. 512 is the common case; 4096 is LARGER than the engine's block
    // (so the chunk loop runs); 300 divides neither.
    for (const double rate : {44100.0, 48000.0, 96000.0})
        for (const int block : {512, 4096, 300})
            if (runThru(rate, block) != 0) return 1;

    // §2 — never prepared. inScratch is empty, so processBlock takes its early
    // return; the buffer must come back untouched rather than cleared.
    {
        ScoopyTapeProcessor p;
        juce::AudioBuffer<float> buf(2, 512);
        juce::AudioBuffer<float> reference(2, 512);
        juce::MidiBuffer midi;
        fillTone(buf, 48000.0);
        reference.makeCopyOf(buf);
        p.processBlock(buf, midi);
        CHECK(maxDiff(buf, reference) == 0.0);
        CHECK(peakOf(buf) > 0.4); // and it really was a signal, not silence both times
    }

    // §4 — the layout contract.
    {
        ScoopyTapeProcessor p;
        juce::AudioProcessor::BusesLayout stereo;
        stereo.inputBuses.add(juce::AudioChannelSet::stereo());
        stereo.outputBuses.add(juce::AudioChannelSet::stereo());
        CHECK(p.isBusesLayoutSupported(stereo));

        juce::AudioProcessor::BusesLayout mono;
        mono.inputBuses.add(juce::AudioChannelSet::mono());
        mono.outputBuses.add(juce::AudioChannelSet::mono());
        CHECK(!p.isBusesLayoutSupported(mono));

        // An effect, not an instrument — the thing A1 exists to make true.
        CHECK(!p.isMidiEffect());
        CHECK(p.getName() == "Scoopy Tape");
    }

    // §5 — two instances, one process.
    {
        ScoopyTapeProcessor a, b;
        a.prepareToPlay(48000.0, 512);
        b.prepareToPlay(48000.0, 512);
        CHECK(a.engineForTest() != nullptr);
        CHECK(b.engineForTest() != nullptr);
        CHECK(a.engineForTest() != b.engineForTest());

        juce::AudioBuffer<float> bufA(2, 512), bufB(2, 512), ref(2, 512);
        juce::MidiBuffer midi;
        fillTone(bufA, 48000.0);
        ref.makeCopyOf(bufA);
        bufB.makeCopyOf(bufA);
        a.processBlock(bufA, midi);
        midi.clear();
        b.processBlock(bufB, midi);
        CHECK(maxDiff(bufA, ref) <= 1e-6);
        CHECK(maxDiff(bufB, ref) <= 1e-6);
    }

    // ── §7 A RECORDED LOOP IS AUDIBLE ───────────────────────────────────────
    //
    // THE CLAIM §1 NEVER MADE, AND THE DEFECT IT LET THROUGH. The gate above
    // proves the insert passes DRY through, which it did perfectly while the
    // looper itself was silent — "no output, stays silent even with recorded
    // content" (real host, 2026-08-02). A tape renders into a CHANNEL, and a
    // fresh channel's source is kind 0 = none, so the audio had nowhere to go.
    // Nothing bound them, and nothing asked whether anything had.
    //
    // Recording is driven through the ABI rather than through `slRecord` on
    // purpose: this asserts the AUDIO path, and slRecord additionally needs the
    // take-file recorder started, which would make a file-system failure look
    // like silence — the two must not be able to alias.
    {
        ScoopyTapeProcessor p;
        constexpr double kRate = 48000.0;
        constexpr int kBlock = 512;
        p.prepareToPlay(kRate, kBlock);
        auto* e = p.engineForTest();
        CHECK(e != nullptr);

        juce::AudioBuffer<float> buf(2, kBlock);
        juce::MidiBuffer midi;

        // Record ~8 blocks of tone off the plugin's own input bus.
        CHECK(sl_tape_set_record_source(e, 0, /*deviceInput*/ 0, 0, 1) == 1);
        sl_tape_record_service(e);
        sl_tape_record_start(e, 0);
        for (int b = 0; b < 8; ++b) {
            fillTone(buf, kRate, b * kBlock);
            midi.clear();
            p.processBlock(buf, midi);
        }
        sl_tape_record_stop(e, 0);
        // Law C-3: the same chunks become the playback buffer in the same block.
        CHECK(sl_tape_frames(e, 0) > 0);

        sl_tape_trigger(e, 0, /*loop*/ 0);

        // NOW RENDER SILENCE IN. Any output at all is the tape, which is what
        // makes this isolate the loop from the dry path completely.
        double loudest = 0.0;
        for (int b = 0; b < 24; ++b) {
            buf.clear();
            midi.clear();
            p.processBlock(buf, midi);
            loudest = juce::jmax(loudest, (double) peakOf(buf));
        }
        CHECK(sl_tape_state(e, 0) == 1 /* looping */);
        if (loudest <= 1.0e-4) {
            std::fprintf(stderr,
                         "FAIL §7: a recorded, looping tape is SILENT (peak %g). "
                         "frames=%llu state=%u — is the tape bound to a channel?\n",
                         loudest, (unsigned long long) sl_tape_frames(e, 0),
                         sl_tape_state(e, 0));
            return 1;
        }
    }

    // ── §8 RECORDING DOES NOT DOUBLE THE INPUT ──────────────────────────────
    //
    // The engine opens the channel MONITOR itself at record-start when the
    // source is a device input (D-WZ-MON-01) and closes it at the Law C-3
    // handoff (D-WZ-MON-02). That exists for a host with a sound card, where
    // the input is not otherwise audible. In a DAW INSERT it already is — it is
    // the track — so the monitor's copy lands on top of the dry this processor
    // sums, and the signal jumps while a take is running.
    //
    // §1 recorded this as a question §2 would inherit. It became reachable the
    // moment the silence was fixed, so it is answered here instead.
    {
        ScoopyTapeProcessor p;
        constexpr double kRate = 48000.0;
        constexpr int kBlock = 512;
        p.prepareToPlay(kRate, kBlock);
        auto* e = p.engineForTest();

        juce::AudioBuffer<float> buf(2, kBlock), reference(2, kBlock);
        juce::MidiBuffer midi;

        // Baseline: idle, so output == input exactly (§1's thru claim).
        fillTone(buf, kRate);
        reference.makeCopyOf(buf);
        p.processBlock(buf, midi);
        const double idlePeak = peakOf(buf);

        sl_tape_set_record_source(e, 0, 0, 0, 1);
        sl_tape_record_service(e);
        sl_tape_record_start(e, 0);

        double recPeak = 0.0;
        for (int b = 0; b < 8; ++b) {
            fillTone(buf, kRate, b * kBlock);
            midi.clear();
            p.processBlock(buf, midi);
            recPeak = juce::jmax(recPeak, peakOf(buf));
        }
        sl_tape_record_stop(e, 0);

        // The same tone in must give the same tone out. A monitor summing a
        // second copy shows up here as ~2x and nowhere else.
        if (recPeak > idlePeak * 1.5) {
            std::fprintf(stderr,
                         "FAIL §8: the input DOUBLES while recording (idle %g → rec %g). "
                         "The engine's monitor is summing a copy the insert already carries.\n",
                         idlePeak, recPeak);
            return 1;
        }
    }

    // §6 — the tape tier answers from inside the plugin. `info` is the read-only
    // verb, so this asserts reachability without changing any state.
    {
        ScoopyTapeProcessor p;
        p.prepareToPlay(48000.0, 512);
        auto* q = new juce::DynamicObject();
        q->setProperty("action", "info");
        q->setProperty("tape", 0);
        const auto reply = p.dispatchFromUi("slTape", juce::var(q));
        CHECK((bool) reply.getProperty("ok", false));
        // And the bank really is the 8 slots A4's snapshot system maps onto.
        CHECK(sl_tape_count() == 8);
    }

    std::printf("tape_plugin_processor_test OK\n");
    return 0;
}
