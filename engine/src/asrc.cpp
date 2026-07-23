#include "asrc.h"

namespace wz {

namespace {
// CONTROL LAW: pure feedforward. The ratio is set to engineRate / trueRate,
// where trueRate is estimated from the ring's CUMULATIVE {framesWritten,
// host_time} — an average over the whole stream, so for a constant clock drift
// it converges to the exact rate and the effective conversion ratio matches
// engineRate/trueRate to sub-ppm. That alone holds alignment to ~0 over an hour
// (asrc_drift_test: 0.0002 ms/hr vs the naive 22.5 ms/hr).
//
// A ring-fill PI trim was evaluated and REJECTED: reading a whole quantum per
// supply callback makes the ring fill sawtooth, which biases a fill servo into
// FIGHTING the (already-correct) feedforward and made drift WORSE. Feedforward
// needs no fill feedback — it matches the rate, so fill is stationary by
// construction. The gains stay as a disabled seam; active fill re-centering for
// disruption recovery (format change, glitch) is a later robustness refinement,
// not needed for correctness. See P2-03a.
constexpr double kKp = 0.00;
constexpr double kKi = 0.00;
constexpr double kIntegralClamp = 0.02; // anti-windup; >> any real ppm drift
} // namespace

SourceAsrc::~SourceAsrc() {
    if (src_ != nullptr) src_delete(src_);
}

bool SourceAsrc::init(SourceRing* ring, double engineRate, double nominalRate,
                      uint32_t quantum) {
    if (ring == nullptr || engineRate <= 0.0 || nominalRate <= 0.0 || quantum == 0)
        return false;
    ring_ = ring;
    channels_ = ring->channels;
    engineRate_ = engineRate;
    nominalRate_ = nominalRate;
    // Target fill in SOURCE frames (D-WZ-CLOCK-01: 1.5× the quantum, scaled by
    // the rate ratio since the quantum is engine frames).
    targetFill_ = 1.5 * static_cast<double>(quantum) * (nominalRate / engineRate);
    ratio_ = engineRate / nominalRate;
    // Supply exactly one quantum per callback. Larger chunks let libsamplerate
    // hoard an unbounded internal buffer (which then absorbs drift invisibly);
    // one quantum keeps the RING the buffer, so its fill faithfully reflects
    // accumulation and the controller has a real signal. The stable feedforward
    // ratio (~unity) means no expensive re-priming of the SINC filter per block.
    supplyChunk_ = quantum;
    inScratch_.assign(static_cast<size_t>(supplyChunk_) * channels_, 0.0f);

    int err = 0;
    src_ = src_callback_new(&SourceAsrc::supplyCb, SRC_SINC_BEST_QUALITY,
                            static_cast<int>(channels_), &err, this);
    return src_ != nullptr;
}

long SourceAsrc::supplyCb(void* cbData, float** data) {
    return static_cast<SourceAsrc*>(cbData)->supply(data);
}

long SourceAsrc::supply(float** data) {
    // Hand libsamplerate only the frames actually present (no zero-padding —
    // padding would inject silence the SRC would smear). An empty ring returns 0
    // and the SRC produces what it can; the caller sees the short read.
    const uint64_t fill = ring_->fillFrames();
    uint32_t n = supplyChunk_;
    if (fill < n) n = static_cast<uint32_t>(fill);
    *data = inScratch_.data();
    if (n == 0) return 0;
    ring_->read(inScratch_.data(), n); // n ≤ fill → no underrun counted here
    return n;
}

uint32_t SourceAsrc::process(float* out, uint32_t frames) {
    if (src_ == nullptr || out == nullptr || frames == 0) return 0;

    // --- true-rate estimate from the ring's timestamp clock ------------------
    uint64_t hostNs = 0;
    double reportedRate = 0.0;
    uint64_t framesNow = 0;
    ring_->readClock(hostNs, reportedRate, framesNow);

    // FEEDFORWARD ratio from the timestamp-derived true source rate: this alone
    // rejects the drift and holds the ratio stable near unity (no clamp-slamming
    // → no instability). Falls back to nominal until the observation window is
    // meaningful. driftPpm is published for the per-strip HotFrame readout.
    double feedforward = engineRate_ / nominalRate_;
    if (framesNow > 0) {
        if (!haveBaseline_) {
            haveBaseline_ = true;
            baseHostNs_ = hostNs;
            baseFrames_ = framesNow;
        }
        const uint64_t dFrames = framesNow - baseFrames_;
        const uint64_t dNs = hostNs - baseHostNs_;
        if (dNs > 1000000ull && dFrames > 0) { // > 1 ms of observation
            const double trueRate =
                static_cast<double>(dFrames) / (static_cast<double>(dNs) / 1e9);
            feedforward = engineRate_ / trueRate;
            driftPpm_ = (trueRate / nominalRate_ - 1.0) * 1e6;
        }
    }

    double ratio = engineRate_ / nominalRate_; // negative control: naive nominal
    if (controllerOn_) {
        const double fill = static_cast<double>(ring_->fillFrames());
        const double fillErr = (fill - targetFill_) / targetFill_; // >0 = too full
        const double dt = static_cast<double>(frames) / engineRate_;
        integral_ += fillErr * dt;
        if (integral_ > kIntegralClamp) integral_ = kIntegralClamp;
        if (integral_ < -kIntegralClamp) integral_ = -kIntegralClamp;
        // Feedforward sets the operating point; the gentle PI trim centers the
        // ring. Too full → consume faster → LOWER ratio (more input per output).
        ratio = feedforward * (1.0 - kKp * fillErr - kKi * integral_);
    }
    // Guard against a runaway ratio (drift is tiny; anything large is a bug).
    if (ratio < 0.5) ratio = 0.5;
    if (ratio > 2.0) ratio = 2.0;
    ratio_ = ratio;

    const long produced = src_callback_read(src_, ratio, static_cast<long>(frames), out);
    return produced < 0 ? 0u : static_cast<uint32_t>(produced);
}

} // namespace wz
