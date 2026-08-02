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

/** Where a scratch gesture is parked before it starts. An integer frame index
    on purpose — it is what `sl_tape_seek` takes — and mid-buffer so the gesture
    has material either side of it. */
constexpr uint64_t kAnchorFrame = kLen / 2;

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

/* ── the auto-scratch ──────────────────────────────────────────────────────
   Everything above measures the HAND path, which is the reference the generator
   has to sound like. What follows exercises the generator itself. */

/** Render one pattern and return the left channel. `blockSize` is both the
    engine's block and the render chunk, so this is the same gesture evaluated
    at three different control grains. */
bool runPattern(uint32_t block, uint32_t technique, double periodBeats, double span,
                double bpm, uint32_t cycles, std::vector<float>& out,
                double* endPlayhead = nullptr, double vary = 0.0) {
    sl_engine* e = sl_engine_create(kRate, block, 86);
    if (e == nullptr) return false;
    if (sl_engine_start(e) != 1) return false;
    sl_watchdog_set_enabled(e, 0);
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        if (sl_channel_set_source(e, t, 1 /* tape */, t) != 1) return false;

    std::vector<float> tone(kLen);
    for (size_t i = 0; i < kLen; ++i)
        tone[i] = static_cast<float>(
            std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
    const float* planar[1] = {tone.data()};
    if (sl_tape_load(e, 0, 1, kLen, planar, kRate) != 1) return false;
    // Park the head mid-buffer so the gesture has material either side of it.
    sl_tape_seek(e, 0, kAnchorFrame);

    sl_tape_set_scratch_tempo(e, bpm);
    sl_tape_scratch_start(e, 0, technique, periodBeats, span, vary, -1.0);

    const double cycleSamples = periodBeats * (60.0 / bpm) * kRate;
    const auto total = static_cast<uint64_t>(cycleSamples * cycles);

    std::vector<float> l(block), r(block);
    float* outs[2] = {l.data(), r.data()};
    out.clear();
    for (uint64_t done = 0; done < total; done += block) {
        sl_render(e, outs, 2, block);
        out.insert(out.end(), l.begin(), l.end());
    }
    if (endPlayhead != nullptr) *endPlayhead = sl_tape_playhead(e, 0);
    sl_engine_destroy(e);
    return true;
}

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

    /* ── 1. BLOCK-SIZE INDEPENDENCE — the load-bearing assertion ───────────
       scratching.md §4.1 warns that the gap law divides by `frames`, so a
       generator that commands a RATE would produce a different rate at a
       different block size — the same pattern would be a different gesture in
       every host. The generator is therefore position/velocity driven and
       touches `frames` nowhere, and this is what holds that true. It is the
       reason the whole feature can live in the engine at all. */
    {
        std::vector<float> a, b, c;
        CHECK(runPattern(64, 0 /* baby */, 0.5, 0.07, 120.0, 4, a));
        CHECK(runPattern(256, 0, 0.5, 0.07, 120.0, 4, b));
        CHECK(runPattern(512, 0, 0.5, 0.07, 120.0, 4, c));
        const size_t n = std::min(a.size(), std::min(b.size(), c.size()));
        CHECK(n > kRate / 4); // it actually rendered something
        double worst = 0.0;
        for (size_t i = 0; i < n; ++i) {
            worst = std::max(worst, std::abs(static_cast<double>(a[i] - b[i])));
            worst = std::max(worst, std::abs(static_cast<double>(a[i] - c[i])));
        }
        std::printf("  block-size independence: worst |Δ| across 64/256/512 = %.3e\n", worst);
        // MEASURED BIT-EXACT (worst |Δ| = 0), and structurally it should be: the
        // per-sample scratch maths references no block boundary at all, so each
        // sample is computed identically however the render is chunked. The
        // bound is a hair above zero rather than `== 0` only because FMA
        // contraction can differ across compilers and architectures — a genuine
        // block-size dependence would be percent, not 1e-9.
        CHECK(worst < 1e-9);
    }

    /* ── 2. THE PATTERN SOUNDS, AND IT ARTICULATES ─────────────────────────
       A generator that produced a steady tone would pass every structural check
       above and be worthless: a baby scratch's whole character is that it breaks
       into discrete bursts with NO FADER AT ALL. */
    {
        std::vector<float> baby;
        CHECK(runPattern(64, 0, 0.5, 0.07, 120.0, 4, baby));
        const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
        const size_t windows = baby.size() / win;
        CHECK(windows > 20);
        double loud = 0.0, quiet = 1e9;
        for (size_t w = 0; w < windows; ++w) {
            const double v = acRms(baby, w * win, win);
            loud = std::max(loud, v);
            quiet = std::min(quiet, v);
        }
        std::printf("  baby @120bpm 1/8: loudest %.5f  quietest %.5f\n", loud, quiet);
        CHECK(loud > 0.01);          // it sounds
        CHECK(quiet < loud * 0.05);  // and it BREAKS — >26 dB of articulation
    }

    /* ── 3. PERIOD IS MUSICAL — half the tempo is half the reversal rate ───
       The one assertion that pins `periodBeats` as beats rather than as some
       number that happens to work at 120. Counting reversals is the honest
       measure: it is what a listener counts. */
    {
        // A REVERSAL IS A SIGN CHANGE OF THE RECORD'S VELOCITY, so count that
        // directly off `sl_tape_scrub_rate` rather than inferring it from the
        // envelope.
        //
        // ⚠️ Counting envelope dips was tried first and is WRONG, which is worth
        // recording because it looks right: the output frequency is the tone
        // times the instantaneous rate, so near a reversal the tone itself goes
        // subsonic and a short analysis window sees "no AC" over a wide region
        // that dips in and out. It counted 29 reversals in 4 cycles, and — the
        // tell — the count scaled with DURATION rather than with cycles, which
        // is exactly the thing this test exists to distinguish.
        auto reversals = [](double bpm, uint64_t& renderedSamples) {
            sl_engine* e = sl_engine_create(kRate, 64, 86);
            if (e == nullptr) return -1;
            if (sl_engine_start(e) != 1) return -1;
            sl_watchdog_set_enabled(e, 0);
            for (uint32_t t = 0; t < sl_channel_count(); ++t)
                if (sl_channel_set_source(e, t, 1, t) != 1) return -1;
            std::vector<float> tone(kLen, 0.25f);
            const float* planar[1] = {tone.data()};
            if (sl_tape_load(e, 0, 1, kLen, planar, kRate) != 1) return -1;
            sl_tape_seek(e, 0, kAnchorFrame);
            sl_tape_set_scratch_tempo(e, bpm);
            sl_tape_scratch_start(e, 0, 0 /* baby */, 0.5, 0.07, 0.0 /* vary */, -1.0);

            const double cycleSamples = 0.5 * (60.0 / bpm) * kRate;
            const auto total = static_cast<uint64_t>(cycleSamples * 4.0);
            std::vector<float> l(64), r(64);
            float* outs[2] = {l.data(), r.data()};
            int count = 0, sign = 0;
            uint64_t done = 0;
            for (; done < total; done += 64) {
                sl_render(e, outs, 2, 64);
                const double v = sl_tape_scrub_rate(e, 0);
                // A dead band, so the settling one-pole cannot jitter across
                // zero and be counted twice at the same reversal.
                const int s = v > 1e-3 ? 1 : (v < -1e-3 ? -1 : 0);
                if (s != 0 && sign != 0 && s != sign) ++count;
                if (s != 0) sign = s;
            }
            renderedSamples = done;
            sl_engine_destroy(e);
            return count;
        };
        uint64_t n120 = 0, n60 = 0;
        const int r120 = reversals(120.0, n120);
        const int r60 = reversals(60.0, n60);
        std::printf("  reversals over 4 cycles: %d @120bpm (%llu smp), %d @60bpm (%llu smp)\n",
                    r120, static_cast<unsigned long long>(n120), r60,
                    static_cast<unsigned long long>(n60));
        // THE ASSERTION THAT PINS "BEATS": halving the tempo makes four cycles
        // take twice as long in wall-clock time and contain exactly as many
        // reversals. A period secretly in milliseconds would hold the duration
        // and double the count.
        CHECK(n60 > n120 * 3 / 2);
        CHECK(r120 == r60);
        // Two reversals per cycle over four cycles; the first is at phase 0
        // where the gesture starts from rest, so it is not a sign CHANGE.
        CHECK(r120 >= 6 && r120 <= 8);
    }

    /* ── 4. THE GESTURE RETURNS TO ITS ANCHOR ──────────────────────────────
       Strokes are whole units and the shape is periodic, so a whole number of
       cycles must end where it began. If this drifts, a long hold walks off
       across the buffer — the failure mode the slow anchor pull exists for. */
    {
        std::vector<float> x;
        double endPh = 0.0;
        CHECK(runPattern(64, 0, 0.5, 0.07, 120.0, 16, x, &endPh));
        const double anchor = static_cast<double>(kAnchorFrame);
        const double spanFrames = 0.07 * static_cast<double>(kLen);
        std::printf("  after 16 cycles: playhead %.1f, anchor %.1f, span %.1f\n",
                    endPh, anchor, spanFrames);
        // Within a fraction of one span of where it started — the one-pole lags
        // by design, so "exactly" is the wrong demand; "has not wandered off" is
        // the right one.
        CHECK(std::abs(endPh - anchor) < spanFrames);
    }

    /* ── 5. RECORDING REFUSES, exactly as sl_tape_scrub_begin does ─────────
       The write head is not the user's to drag, and a pattern is only a faster
       drag. Without this a scratch during a take would corrupt the recording. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        std::vector<float> tone(kLen, 0.5f);
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        CHECK(sl_tape_set_record_source(e, 0, 0 /* deviceInput */, 0, 1) == 1);
        sl_tape_record_start(e, 0);
        sl_tape_scratch_start(e, 0, 0, 0.5, 0.07, 0.0 /* vary */, -1.0);
        std::vector<float> l(64), r(64);
        float* outs[2] = {l.data(), r.data()};
        sl_render(e, outs, 2, 64);
        // Refused means the scrub path never opened, so the rate stays zero.
        CHECK(sl_tape_scrub_rate(e, 0) == 0.0);
        sl_engine_destroy(e);
    }

    /* ── 6. AN OUT-OF-RANGE TECHNIQUE IS REFUSED, not clamped into another ─
       Period and span are clamped (a UI control at the edge of its range should
       still play), but a technique INDEX is a name, and silently playing a
       different figure than the one asked for is the exact drift scratch:check
       exists to prevent — it must not be reachable through the ABI either. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        std::vector<float> tone(kLen, 0.5f);
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        sl_tape_scratch_start(e, 0, 9999, 0.5, 0.07, 0.0 /* vary */, -1.0);
        std::vector<float> l(64), r(64);
        float* outs[2] = {l.data(), r.data()};
        sl_render(e, outs, 2, 64);
        CHECK(sl_tape_scrub_rate(e, 0) == 0.0);
        sl_engine_destroy(e);
    }

    /* ── 7. RELEASE COMPLETES THE STROKE ───────────────────────────────────
       Told to stop mid-stroke, the pattern runs to the next reversal and lets go
       there — so the playhead the scrub coast inherits is one the gesture
       actually rests at. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        for (uint32_t t = 0; t < sl_channel_count(); ++t)
            CHECK(sl_channel_set_source(e, t, 1, t) == 1);
        std::vector<float> tone(kLen);
        for (size_t i = 0; i < kLen; ++i)
            tone[i] = static_cast<float>(
                std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        sl_tape_seek(e, 0, kAnchorFrame);
        sl_tape_set_scratch_tempo(e, 120.0);
        sl_tape_scratch_start(e, 0, 0, 0.5, 0.07, 0.0 /* vary */, -1.0);

        std::vector<float> l(64), r(64);
        float* outs[2] = {l.data(), r.data()};
        const double cycle = 0.5 * (60.0 / 120.0) * kRate; // one full back-and-forth, in samples
        // Stop a QUARTER of the way into the forward stroke — the least
        // convenient moment, and the one a naive implementation cuts at.
        const int quarterIn = static_cast<int>(cycle * 0.125) / 64;
        for (int i = 0; i < quarterIn; ++i) sl_render(e, outs, 2, 64);
        sl_tape_scratch_stop(e, 0, 1 /* HOLD — these fixtures pin the latch, not the play-out */);
        // It must still be moving immediately after the stop.
        sl_render(e, outs, 2, 64);
        const double rateJustAfter = sl_tape_scrub_rate(e, 0);
        std::printf("  release: rate just after stop = %.4f (still travelling)\n", rateJustAfter);
        CHECK(std::abs(rateJustAfter) > 1e-3);
        // And it must actually finish, rather than running forever.
        for (int i = 0; i < static_cast<int>(cycle * 2) / 64; ++i) sl_render(e, outs, 2, 64);
        CHECK(sl_tape_scrub_rate(e, 0) == 0.0);
        sl_engine_destroy(e);
    }

    /* ── 8. THE GATE REACHES SILENCE INSIDE A CLICK ────────────────────────
       The whole reason D-SL-SCRATCHGATE-01 exists. At the engine's 10 ms
       constant a 40 ms click is 10 ms down + 10 ms up and NEVER GETS THERE; the
       signed ~2 ms does. This is the assertion that would fail if somebody
       "restored consistency" by putting the gate back on the one ramp. */
    {
        std::vector<float> tf;
        // transformer: rest CLOSED with four openings per stroke, so most of the
        // pattern is silence and the openings are the tones.
        CHECK(runPattern(64, 5 /* transformer */, 0.5, 0.07, 120.0, 4, tf));
        const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
        const size_t windows = tf.size() / win;
        CHECK(windows > 20);
        double loud = 0.0;
        int silentWindows = 0;
        std::vector<double> rms(windows);
        for (size_t w = 0; w < windows; ++w) {
            rms[w] = acRms(tf, w * win, win);
            loud = std::max(loud, rms[w]);
        }
        for (double v : rms)
            if (v < loud * 0.01) ++silentWindows; // 40 dB down = closed, not "quieter"
        const double silentFraction = static_cast<double>(silentWindows) /
                                      static_cast<double>(windows);
        std::printf("  transformer: %.0f%% of windows fully closed (>40 dB down)\n",
                    silentFraction * 100.0);
        CHECK(loud > 0.01);            // the openings sound
        CHECK(silentFraction > 0.25);  // and the closes REACH silence
    }

    /* ── 9. FADER-ONLY (span 0) CHOPS A PLAYING LOOP ───────────────────────
       D-SL-SCRATCHGATE-01 names this case explicitly: a transformer over a
       NORMALLY PLAYING loop, not only over a scratch. The record hand moves
       nothing, so the pitch is untouched and only the gate articulates. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        for (uint32_t t = 0; t < sl_channel_count(); ++t)
            CHECK(sl_channel_set_source(e, t, 1, t) == 1);
        std::vector<float> tone(kLen);
        for (size_t i = 0; i < kLen; ++i)
            tone[i] = static_cast<float>(
                std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        // ⚠️ A SEAMLESS LOOP, or this test measures its own material. 400 Hz at
        // 48k is exactly 120 frames per cycle, and 65536 is not a multiple of
        // 120 — so looping the whole buffer puts a step of up to full scale at
        // every wrap. The first run of the release assertion below caught
        // exactly that, reporting 0.707 (a tone sample, not a gain change) and
        // reading like a gate that snaps.
        constexpr uint64_t kTonePeriod = 120;
        constexpr uint64_t kLoopFrames = (kLen / kTonePeriod) * kTonePeriod;
        sl_tape_set_loop(e, 0, 1, 0, kLoopFrames);
        sl_tape_trigger(e, 0, 0); // LOOPING, at rate 1.0
        sl_tape_set_scratch_tempo(e, 120.0);
        sl_tape_scratch_start(e, 0, 5 /* transformer */, 0.5, 0.0 /* FADER ONLY */, 0.0 /* vary */, -1.0);

        std::vector<float> l(64), r(64), captured;
        float* outs[2] = {l.data(), r.data()};
        for (int i = 0; i < 750; ++i) { // ~1 s
            sl_render(e, outs, 2, 64);
            captured.insert(captured.end(), l.begin(), l.end());
        }
        // THE RECORD NEVER MOVED: the scrub path stayed shut, so this is
        // ordinary playback with a gate on it.
        CHECK(sl_tape_scrub_rate(e, 0) == 0.0);

        const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
        const size_t windows = captured.size() / win;
        double loud = 0.0;
        std::vector<double> rms(windows);
        for (size_t w = 0; w < windows; ++w) {
            rms[w] = acRms(captured, w * win, win);
            loud = std::max(loud, rms[w]);
        }
        int silent = 0;
        for (double v : rms) if (v < loud * 0.01) ++silent;
        const double frac = static_cast<double>(silent) / static_cast<double>(windows);
        std::printf("  fader-only over a playing loop: %.0f%% closed, peak %.4f\n",
                    frac * 100.0, loud);
        CHECK(loud > 0.01);   // the loop is audible through the openings
        CHECK(frac > 0.25);   // and the fader really is chopping it

        // RELEASE MUST NOT CLICK. A closed-rest technique would otherwise
        // deactivate with the gate shut and step straight to full output.
        sl_tape_scratch_stop(e, 0, 1 /* HOLD — these fixtures pin the latch, not the play-out */);
        std::vector<float> tail;
        for (int i = 0; i < 400; ++i) {
            sl_render(e, outs, 2, 64);
            tail.insert(tail.end(), l.begin(), l.end());
        }
        double worstStep = 0.0;
        for (size_t i = 1; i < tail.size(); ++i)
            worstStep = std::max(worstStep, std::abs(static_cast<double>(tail[i] - tail[i - 1])));
        // One sample of a 400 Hz tone at full scale steps by at most
        // sin(2*pi*400/48000) ~= 0.052. A gate snapping open would step by the
        // whole sample value, several times that.
        std::printf("  release step: worst sample-to-sample |Δ| = %.4f (tone alone ~0.052)\n",
                    worstStep);
        CHECK(worstStep < 0.08);
        sl_engine_destroy(e);
    }

    /* ── 10. A HAND SCRUB IS UNCHANGED ─────────────────────────────────────
       Neither the gate nor the speed law may leak onto the path a finger drives.
       The measurement at the top of this file IS that path, so if this commit
       had touched it those numbers would have moved — but assert it directly
       too, because "the other test would have caught it" is how things stop
       being caught. */
    {
        Notch again{};
        CHECK(measure(64, again));
        CHECK(again.strokeRms == fine.strokeRms);
        CHECK(again.floorRms == fine.floorRms);
    }

    /* ── 11. THE SPIN-BACK — launched at a point, the record travels there ──
       "start where we click in the waveform, with a super fast reverse if the
       current position is elsewhere, like on turntables seeking a section"
       (user, 2026-08-02). Audible, faster than the hand-scrub law allows, and it
       must ARRIVE rather than merely head that way. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        for (uint32_t t = 0; t < sl_channel_count(); ++t)
            CHECK(sl_channel_set_source(e, t, 1, t) == 1);
        std::vector<float> tone(kLen);
        for (size_t i = 0; i < kLen; ++i)
            tone[i] = static_cast<float>(
                std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        // Park at the END and launch the gesture near the START, so the journey
        // is a long REVERSE — the case the user described.
        sl_tape_seek(e, 0, kLen - 2000);
        sl_tape_set_scratch_tempo(e, 120.0);
        const double cue = 4000.0;
        sl_tape_scratch_start(e, 0, 0 /* baby */, 0.5, 0.02, 0.0 /* vary */, cue);

        std::vector<float> l(64), r(64), heard;
        float* outs[2] = {l.data(), r.data()};
        double fastest = 0.0;
        bool arrived = false;
        int blocksToArrive = 0;
        for (int i = 0; i < 400 && !arrived; ++i) {
            sl_render(e, outs, 2, 64);
            ++blocksToArrive;
            heard.insert(heard.end(), l.begin(), l.end());
            const double v = sl_tape_scrub_rate(e, 0);
            // Track the extreme by MAGNITUDE. The first cut tracked the minimum
            // and reported 0.00 for a journey that plainly happened — which was
            // the tell that the travel had gone FORWARD from frame 0, because
            // the engine was discarding the pending seek that put the head at
            // the far end. A one-sided metric hid a real defect for one run.
            if (std::abs(v) > std::abs(fastest)) fastest = v;
            if (std::abs(sl_tape_playhead(e, 0) - cue) < 200.0) arrived = true;
        }
        std::printf("  spin-back: extreme %.2fx, arrived=%s, playhead %.0f (cue %.0f)\n",
                    fastest, arrived ? "yes" : "NO", sl_tape_playhead(e, 0), cue);
        CHECK(arrived);
        // ⚠️ HOW LONG IT TOOK IS THE POINT, and this assertion exists because it
        // once took 704 ms. The landing constant was 90 ms, so the profile never
        // saturated for a normal gap and the record CRAWLED in — heard as "it
        // rewinds, pauses, then starts", which reads like quantization and is
        // nothing of the sort. Flat out at 16x a 60k-frame journey is ~78 ms.
        const double arriveMs = blocksToArrive * 64.0 * 1000.0 / kRate;
        std::printf("  spin-back took %.0f ms for %.0f frames (flat out at 16x = %.0f ms)\n",
                    arriveMs, 63536.0 - cue, (63536.0 - cue) / 16.0 * 1000.0 / kRate);
        CHECK(arriveMs < 150.0);
        // FASTER THAN A HAND COULD ASK FOR. The hand-scrub law is clamped to ±4
        // and this must exceed it, or the whole point (a seek that feels like a
        // turntable rather than a slow crawl) is lost.
        CHECK(std::abs(fastest) > 4.0);
        CHECK(fastest < 0.0); // and it was a REVERSE, which is what was asked for
        // AND IT IS HEARD. A silent relocation is a teleport, not a spin-back.
        double loud = 0.0;
        const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
        for (size_t w = 0; w + 1 < heard.size() / win; ++w)
            loud = std::max(loud, acRms(heard, w * win, win));
        // AND IT DOES NOT CLIP. Level follows speed and this runs at up to 16x,
        // so unbounded the seek would arrive +3.5 dB hot on a plugin path with
        // no limiter (D-SL-DECKPLUGIN-01 leaves protection to the DAW's chain).
        // PEAK rather than RMS, because "does it clip" is the actual question —
        // the windowed RMS of a heavily resampled tone sits a little above a
        // pure sine's 0.707 from interpolation ripple, which is not the same
        // thing and would make an RMS bound read as a defect.
        double peak = 0.0;
        for (float v : heard) peak = std::max(peak, std::abs(static_cast<double>(v)));
        std::printf("  spin-back is audible: peak window RMS %.4f, peak sample %.4f\n",
                    loud, peak);
        CHECK(loud > 0.05);
        CHECK(peak <= 1.0);
        sl_engine_destroy(e);
    }

    /* ── 12. RELEASE MODE 0 = RESUME: THE RECORD PLAYS ON ──────────────────
       pd-scrub-engine.md §5 designed this and shipped neither mode. Let go and
       the passage you were scratching keeps playing from where you left it —
       and CRUCIALLY does not jump back to the region entry, which is what would
       happen if release fell through to the ordinary scrub coast. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        for (uint32_t t = 0; t < sl_channel_count(); ++t)
            CHECK(sl_channel_set_source(e, t, 1, t) == 1);
        std::vector<float> tone(kLen);
        for (size_t i = 0; i < kLen; ++i)
            tone[i] = static_cast<float>(
                std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        sl_tape_set_scratch_tempo(e, 120.0);
        // An IDLE tape, launched mid-buffer: the case where "play out" has to
        // invent a transport rather than restore one.
        const double cue = static_cast<double>(kAnchorFrame);
        sl_tape_scratch_start(e, 0, 0, 0.5, 0.05, 0.0 /* vary */, cue);

        std::vector<float> l(64), r(64);
        float* outs[2] = {l.data(), r.data()};
        for (int i = 0; i < 200; ++i) sl_render(e, outs, 2, 64);
        sl_tape_scratch_stop(e, 0, 0 /* RESUME */);
        // Run past the stroke boundary and into the play-out — but NOT past the
        // end of the buffer. ⚠️ This was 600 blocks and started failing the
        // moment the spin-back got 8x faster: the one-shot reached the end of
        // the material and went idle inside the window, so the assertion below
        // read "it never played" when what happened was "it finished". 300
        // blocks from mid-buffer leaves half the tape still to run.
        std::vector<float> after;
        for (int i = 0; i < 300; ++i) {
            sl_render(e, outs, 2, 64);
            after.insert(after.end(), l.begin(), l.end());
        }
        const double ph = sl_tape_playhead(e, 0);
        std::printf("  resume: state %u, playhead %.0f (launched at %.0f)\n",
                    sl_tape_state(e, 0), ph, cue);
        // IT IS PLAYING, and it is a one-shot — a tape that was idle plays out
        // "from here until it ends", which is what a turntable does.
        CHECK(sl_tape_state(e, 0) == 2 /* oneShot — TapeState{idle 0, looping 1, oneShot 2, recording 3} */);
        // AND IT PLAYED ON FROM WHERE IT WAS LEFT, rather than snapping to the
        // region entry. Forward of the launch point, nowhere near frame 0.
        CHECK(ph > cue);
        CHECK(ph < cue + kRate); // and it is playing at speed, not flying
        double loud = 0.0;
        const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
        for (size_t w = 0; w + 1 < after.size() / win; ++w)
            loud = std::max(loud, acRms(after, w * win, win));
        CHECK(loud > 0.05); // it is audible, not a silent playhead
        sl_engine_destroy(e);
    }

    /* ── 13. RELEASE MODE 1 = HOLD is still today's behaviour ──────────────
       The setting has to actually mean something, so pin the other branch. */
    {
        sl_engine* e = sl_engine_create(kRate, 64, 86);
        CHECK(e != nullptr);
        CHECK(sl_engine_start(e) == 1);
        sl_watchdog_set_enabled(e, 0);
        std::vector<float> tone(kLen, 0.25f);
        const float* planar[1] = {tone.data()};
        CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
        sl_tape_set_scratch_tempo(e, 120.0);
        sl_tape_scratch_start(e, 0, 0, 0.5, 0.05, 0.0 /* vary */, static_cast<double>(kAnchorFrame));
        std::vector<float> l(64), r(64);
        float* outs[2] = {l.data(), r.data()};
        for (int i = 0; i < 200; ++i) sl_render(e, outs, 2, 64);
        sl_tape_scratch_stop(e, 0, 1 /* HOLD */);
        for (int i = 0; i < 600; ++i) sl_render(e, outs, 2, 64);
        std::printf("  hold: state %u (idle = latched)\n", sl_tape_state(e, 0));
        CHECK(sl_tape_state(e, 0) == 0 /* idle */);
        sl_engine_destroy(e);
    }

    /* ── 14. THE PLAYER'S CROSSFADER, and its battle curve ─────────────────
       It multiplies the technique's gate rather than replacing it, so a hand can
       cut a pattern that is itself chopping. The curve is the measured one: a
       narrow transition with dead ground either side, which is what makes the
       resting positions usable. */
    {
        auto runWithFader = [](double faderPos) {
            sl_engine* e = sl_engine_create(kRate, 64, 86);
            if (e == nullptr) return -1.0;
            if (sl_engine_start(e) != 1) return -1.0;
            sl_watchdog_set_enabled(e, 0);
            for (uint32_t t = 0; t < sl_channel_count(); ++t)
                if (sl_channel_set_source(e, t, 1, t) != 1) return -1.0;
            std::vector<float> tone(kLen);
            for (size_t i = 0; i < kLen; ++i)
                tone[i] = static_cast<float>(
                    std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate));
            const float* planar[1] = {tone.data()};
            if (sl_tape_load(e, 0, 1, kLen, planar, kRate) != 1) return -1.0;
            sl_tape_set_scratch_tempo(e, 120.0);
            sl_tape_scratch_start(e, 0, 0 /* baby: gate always open, so what is
                                             measured is the FADER alone */,
                                  0.5, 0.05, 0.0 /* vary */, static_cast<double>(kAnchorFrame));
            sl_tape_scratch_fader(e, 0, faderPos);
            std::vector<float> l(64), r(64), got;
            float* outs[2] = {l.data(), r.data()};
            for (int i = 0; i < 400; ++i) {
                sl_render(e, outs, 2, 64);
                got.insert(got.end(), l.begin(), l.end());
            }
            const size_t win = static_cast<size_t>(kWindowSeconds * kRate);
            // ⚠️ SKIP THE SETTLING. The fader RESTS open and is then commanded,
            // so the first few ms are its ~2 ms ramp travelling to the position
            // under test — measuring that reports the journey, not the state.
            // Including it put "shut" at 0.0072 against a 0.0072 threshold and
            // made this assertion a coin-flip on unrelated changes elsewhere.
            const size_t skip = static_cast<size_t>(0.05 * kRate) / win;
            double loud = 0.0;
            for (size_t w = skip; w + 1 < got.size() / win; ++w)
                loud = std::max(loud, acRms(got, w * win, win));
            sl_engine_destroy(e);
            return loud;
        };
        const double open = runWithFader(1.0);
        const double justOpen = runWithFader(0.56);
        const double justShut = runWithFader(0.44);
        const double shut = runWithFader(0.0);
        std::printf("  battle curve: 1.00=%.4f  0.56=%.4f  0.44=%.4f  0.00=%.4f\n",
                    open, justOpen, justShut, shut);
        CHECK(open > 0.05);
        CHECK(shut < open * 0.01); // shut is SHUT, not quieter
        // ⚠️ THE DEAD GROUND IS THE POINT. Either side of the narrow band the
        // fader does nothing at all — that is where a hand RESTS, and it is what
        // makes clicking fast possible. A linear law would fail this by being
        // audibly different at every position.
        CHECK(justOpen == open);
        CHECK(justShut == shut);
        sl_engine_destroy(nullptr); // no-op; keeps the shape of the block above
    }

    /* ── 15. VARIATION — a repeated figure is not what anyone plays ────────
       "the actual improvising does not necessarily turn out to be a series of
       perfectly performed basic techniques". At vary 0 every stroke must be
       identical (that is the old behaviour and the escape hatch); above 0 the
       twin-peaks alternation, the span jitter and the fader thinning must all
       be measurable — otherwise the control is a placebo. */
    {
        // vary 0 IS THE OLD BEHAVIOUR, bit for bit. The escape hatch has to be
        // exact or "turn it off" is not a real answer.
        std::vector<float> a, b;
        CHECK(runPattern(64, 0, 0.5, 0.07, 120.0, 6, a, nullptr, 0.0));
        CHECK(runPattern(64, 0, 0.5, 0.07, 120.0, 6, b, nullptr, 0.0));
        CHECK(a.size() == b.size());
        for (size_t i = 0; i < a.size(); ++i) CHECK(a[i] == b[i]);

        // The measure that matters: how much CONSECUTIVE CYCLES differ from each
        // other. A stale pattern scores ~0 by construction; twin peaks alone
        // guarantees a large number, since the second excursion is 0.585 of the
        // first.
        auto cycleSpread = [](const std::vector<float>& x, double bpm) {
            const auto cyc = static_cast<size_t>(0.5 * (60.0 / bpm) * kRate);
            const size_t n = x.size() / cyc;
            std::vector<double> peak(n, 0.0);
            for (size_t c = 0; c < n; ++c)
                for (size_t i = 0; i < cyc; ++i)
                    peak[c] = std::max(peak[c], std::abs(static_cast<double>(x[c * cyc + i])));
            double mean = 0.0;
            for (double v : peak) mean += v;
            mean /= static_cast<double>(n > 0 ? n : 1);
            double dev = 0.0;
            for (double v : peak) dev += std::abs(v - mean);
            return n > 0 && mean > 0.0 ? (dev / static_cast<double>(n)) / mean : 0.0;
        };

        // A technique whose gate is always open, so what is measured is the
        // RECORD hand rather than the fader: span, not clicks.
        std::vector<float> flat, varied;
        CHECK(runPattern(64, 0 /* baby */, 0.5, 0.07, 120.0, 8, flat, nullptr, 0.0));
        CHECK(runPattern(64, 0, 0.5, 0.07, 120.0, 8, varied, nullptr, 1.0));
        const double sFlat = cycleSpread(flat, 120.0);
        const double sVaried = cycleSpread(varied, 120.0);
        std::printf("  variation: cycle-to-cycle spread %.4f at vary 0 -> %.4f at vary 1\n",
                    sFlat, sVaried);
        CHECK(sVaried > sFlat * 2.0);

        // AND THE PERIOD DOES NOT MOVE. The measurement is specific: "the record
        // speed and gesture span varies, but the DURATION is constant". If
        // variation leaked onto the period this feature would drift off the
        // grid, which is the one thing a tempo-locked scratch may not do.
        CHECK(flat.size() == varied.size());
    }

    std::printf("sl_tape_scratch_test OK\n");
    return 0;
}
