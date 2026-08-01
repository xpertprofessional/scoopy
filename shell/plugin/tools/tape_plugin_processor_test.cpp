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
