// THE PHANTOM CLICK — does it already emerge from the scrub path we have?
//
// docs/specs/scratching.md §1 quotes the Turntablist Transcription Methodology:
//
//   "at the exact point where the record changes direction, the record is
//    momentarily completely motionless. The instant where the record is still
//    creates an extremely short period of silence — a phantom click — which
//    breaks the sound of the scratch without requiring any movement of the
//    fader."
//
// It is why a baby scratch produces discrete bursts with NO FADER AT ALL, and
// why a two-click flare sounds like four. It is EMERGENT from the rate curve
// rather than authored into either gesture stream, and the spec's §6 open
// question 1 makes measuring it the first task of the whole feature: it decides
// whether scratch is "author some curves" or "model the platter".
//
// WHY THIS IS A REAL MEASUREMENT AND NOT AN ASSERTION HUNT. Our reader derives
// rate from the gap to the finger and smooths it on the one 10 ms D-WZ-RAMP-01
// constant (sl_tape.cpp), so rate passes through zero at every reversal by
// construction. The question is not whether the maths says so — it is whether
// the resulting notch is deep enough and long enough to HEAR, against the
// numbers the KTH studies measured on real turntables:
//
//   · direction-change silence  ~5 ms   (the authors' own estimate)
//   · below 10 ms is not a tone         (their artifact-rejection floor)
//
// WHAT "SILENCE" MEANS FOR A DIGITAL READER, and why this measures AC energy.
// A stationary magnetic cartridge outputs nothing. A stationary `sampleLerp`
// outputs the SAME SAMPLE FOREVER — a DC level, which is not zero but carries
// no sound. So the honest metric is mean-removed RMS in a short window: it
// falls to nothing exactly when the playhead stops moving, which is what a
// listener hears as the break. Peak amplitude would report a scratch that never
// breaks at all, and would be wrong.
//
// TWO BLOCK SIZES, because the control grain is a real part of the answer.
// `scrubTarget` is read once per engine block and never interpolated, so a
// caller posting from the app's 512-frame block has a 10.67 ms grain at 48k
// while this fixture's 64-frame configuration has 1.33 ms. Measuring both
// separates "the engine makes a notch" from "the control rate makes a notch".
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

constexpr double kRate = 48000.0;
/** The material: long enough to hold a full stroke either side of centre with
    room to spare, so nothing under test ever meets a buffer edge. */
constexpr uint64_t kLen = 65536;
/** A steady tone, so any change in the output envelope is the READER's doing
    and not the material's. 400 Hz at unity — comfortably above the ~1 kHz
    ceiling where lerp artefacts would start colouring the measurement, and
    comfortably above the stroke rate. */
constexpr double kToneHz = 400.0;

/** One full back-and-forth, in seconds. The KTH mean IOI for record strokes is
    213 ms and strokes come in pairs, so a ~400 ms cycle is one measured baby
    scratch rather than a number chosen for convenience. */
constexpr double kCycleSeconds = 0.4;
/** Peak rate of the gesture, in playback speeds. A sine's peak is 2*pi*A/T, so
    the amplitude below is solved from THIS rather than picked — the gesture is
    specified by how fast the hand moves, which is the thing that matters. */
constexpr double kPeakRate = 2.0;

/** The analysis window. 1 ms is fine enough to resolve a 5 ms notch and coarse
    enough that one tone period (2.5 ms at 400 Hz) does not alias the envelope
    into a comb. */
constexpr double kWindowSeconds = 0.001;

struct Notch {
    double floorRms;   // the quietest window near the reversal
    double strokeRms;  // the loudest window mid-stroke (the reference)
    double depthDb;    // how far down the floor is
    double widthMs;    // how long it stays more than kNotchDb down
    /** The DC the reader is PARKED ON through the notch. A stationary cartridge
        outputs nothing; a stationary sampleLerp outputs whatever sample the
        playhead froze on, which for a tone is an arbitrary level held for the
        width of the notch. Silent as a tone, but a step in and out of it — so
        this is the number that would turn into "scratching thumps" if it were
        large, and it is recorded rather than assumed away. */
    double floorDc;
};

constexpr double kNotchDb = -20.0; // "broken", not merely "quieter"

/** Mean-removed RMS: a frozen playhead holds a DC level, which is silence to a
    listener and would read as full amplitude to a plain RMS. */
double acRms(const std::vector<float>& x, size_t from, size_t n) {
    if (n == 0) return 0.0;
    double mean = 0.0;
    for (size_t i = 0; i < n; ++i) mean += x[from + i];
    mean /= static_cast<double>(n);
    double acc = 0.0;
    for (size_t i = 0; i < n; ++i) {
        const double d = x[from + i] - mean;
        acc += d * d;
    }
    return std::sqrt(acc / static_cast<double>(n));
}

/** Drive one full sine gesture through sl_tape_scrub_to at `block` frames of
    control grain, capture the output, and report the envelope around the
    reversal at the top of the stroke. */
bool measure(uint32_t block, Notch& out) {
    sl_engine* e = sl_engine_create(kRate, block, 86);
    if (e == nullptr) return false;
    if (sl_engine_start(e) != 1) return false;
    sl_watchdog_set_enabled(e, 0); // measure the path under test, not the safety net
    // A tape is heard through its channel, bound 1:1 at unity (see sl_tape_test).
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        if (sl_channel_set_source(e, t, 1 /* tape */, t) != 1) return false;

    std::vector<float> tone(kLen);
    for (size_t i = 0; i < kLen; ++i)
        tone[i] = static_cast<float>(
            std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
    const float* planar[1] = {tone.data()};
    if (sl_tape_load(e, 0, 1, kLen, planar, kRate) != 1) return false;

    const double cycle = kCycleSeconds * kRate;          // samples per full cycle
    const double amp = kPeakRate * cycle / (2.0 * M_PI); // frames, solved from the peak rate
    const double centre = static_cast<double>(kLen) / 2.0;

    std::vector<float> l(block), r(block);
    float* outs[2] = {l.data(), r.data()};

    // The gesture starts at the centre moving forward, which is phase 0 of a
    // sine — so the position curve needs no offset and the reversal lands at a
    // quarter cycle, exactly where the maths says the rate crosses zero.
    auto position = [&](double t) { return centre + amp * std::sin(2.0 * M_PI * t / cycle); };

    sl_tape_scrub_begin(e, 0);

    // SETTLE FIRST. scrubGain ramps up over 10 ms and scrubRate is a one-pole
    // seeded at zero, so the first stroke is a transient rather than a gesture.
    // Run a full cycle and throw it away.
    double t = 0.0;
    for (double done = 0.0; done < cycle; done += block) {
        sl_tape_scrub_to(e, 0, position(t));
        sl_render(e, outs, 2, block);
        t += block;
    }

    // Now capture one clean cycle.
    std::vector<float> captured;
    captured.reserve(static_cast<size_t>(cycle) + block);
    const double captureStart = t;
    for (double done = 0.0; done < cycle; done += block) {
        sl_tape_scrub_to(e, 0, position(t));
        sl_render(e, outs, 2, block);
        captured.insert(captured.end(), l.begin(), l.end());
        t += block;
    }
    sl_tape_scrub_end(e, 0);
    sl_engine_destroy(e);

    // The reversal is a quarter cycle after the capture began, because position
    // is a sine and its extremum is where the derivative crosses zero.
    const size_t reversal = static_cast<size_t>(cycle / 4.0);
    const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
    const size_t windows = captured.size() / win;
    if (windows == 0) return false;

    std::vector<double> rms(windows);
    for (size_t w = 0; w < windows; ++w) rms[w] = acRms(captured, w * win, win);

    // The reference is the loudest window in the cycle — mid-stroke, where the
    // hand is at full speed. Comparing the notch to a per-cycle peak rather than
    // to a constant keeps the number meaningful if the gesture is retuned.
    out.strokeRms = 0.0;
    for (double v : rms) out.strokeRms = v > out.strokeRms ? v : out.strokeRms;

    // Search a generous ±20 ms around the reversal so a notch that is EARLY or
    // LATE (the one-pole lags, so it will be late) is still found rather than
    // measured as absent.
    const size_t guard = static_cast<size_t>(0.020 * kRate) / win;
    const size_t rw = reversal / win;
    const size_t lo = rw > guard ? rw - guard : 0;
    const size_t hi = rw + guard < windows ? rw + guard : windows - 1;

    out.floorRms = rms[lo];
    for (size_t w = lo; w <= hi; ++w) out.floorRms = rms[w] < out.floorRms ? rms[w] : out.floorRms;

    // The level the reader is parked on through the quietest window.
    {
        size_t at = lo;
        for (size_t w = lo; w <= hi; ++w)
            if (rms[w] == out.floorRms) { at = w; break; }
        double mean = 0.0;
        for (size_t i = 0; i < win; ++i) mean += captured[at * win + i];
        out.floorDc = std::abs(mean / static_cast<double>(win));
    }

    out.depthDb = out.strokeRms > 0.0 && out.floorRms > 0.0
                      ? 20.0 * std::log10(out.floorRms / out.strokeRms)
                      : (out.strokeRms > 0.0 ? -160.0 : 0.0);

    // Width: contiguous windows around the floor that stay more than kNotchDb
    // down. Contiguous, not a count — a scattered set of quiet windows is not a
    // break in the sound, it is a modulation.
    const double thresh = out.strokeRms * std::pow(10.0, kNotchDb / 20.0);
    size_t floorAt = lo;
    for (size_t w = lo; w <= hi; ++w)
        if (rms[w] == out.floorRms) { floorAt = w; break; }
    size_t a = floorAt, b = floorAt;
    while (a > lo && rms[a - 1] < thresh) --a;
    while (b < hi && rms[b + 1] < thresh) ++b;
    out.widthMs = rms[floorAt] < thresh
                      ? static_cast<double>(b - a + 1) * kWindowSeconds * 1000.0
                      : 0.0;

    (void) captureStart;
    return true;
}

} // namespace

int main() {
    // 64 frames = 1.33 ms control grain: what the ENGINE does, with the control
    // rate almost out of the picture.
    Notch fine{};
    CHECK(measure(64, fine));
    // 512 frames = 10.67 ms: the real ceiling every host actually runs at
    // (sl_engine_create(rate, 512, ...) in both plugin processors).
    Notch coarse{};
    CHECK(measure(512, coarse));

    std::printf("phantom click, measured (docs/specs/scratching.md §6 Q1)\n");
    std::printf("  gesture: %.0f ms cycle, peak %.1fx, %.0f Hz tone, %.0f ms windows\n",
                kCycleSeconds * 1000.0, kPeakRate, kToneHz, kWindowSeconds * 1000.0);
    std::printf("  64-frame grain  (1.33 ms): stroke %.5f  floor %.5f  depth %6.1f dB  width %2.0f ms  parked DC %.3f\n",
                fine.strokeRms, fine.floorRms, fine.depthDb, fine.widthMs, fine.floorDc);
    std::printf("  512-frame grain (10.7 ms): stroke %.5f  floor %.5f  depth %6.1f dB  width %2.0f ms  parked DC %.3f\n",
                coarse.strokeRms, coarse.floorRms, coarse.depthDb, coarse.widthMs, coarse.floorDc);

    // THE GESTURE ITSELF MUST HAVE SOUNDED. Without this a silent render would
    // report a magnificent notch and the measurement would be a lie.
    CHECK(fine.strokeRms > 0.01);
    CHECK(coarse.strokeRms > 0.01);

    // THE ARTICULATION EXISTS, AND MUST KEEP EXISTING. These bands are wide on
    // purpose: they are not a pin on today's numbers, they are the statement
    // that a reversal still BREAKS THE SOUND. What they catch is somebody
    // "improving" the one-pole at sl_tape.cpp — shortening it toward a step, or
    // replacing the gap law with something that drives the playhead straight
    // through the reversal — either of which silently removes the reason a baby
    // scratch has any rhythm at all, with every existing test still green.
    CHECK(fine.depthDb < -30.0);
    CHECK(coarse.depthDb < -30.0);
    // A click, not a dropout. The KTH estimate for a real turntable is ~5 ms and
    // their "not a tone" floor is 10 ms; anything past 20 ms stopped being an
    // articulation and became a gap.
    CHECK(fine.widthMs >= 2.0 && fine.widthMs <= 20.0);
    CHECK(coarse.widthMs >= 2.0 && coarse.widthMs <= 20.0);

    return 0;
}
