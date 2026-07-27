#include "NativeBusStretcher.hpp"

namespace scoopyloops {

namespace {

// Resolve a texture position into the active node pair + morph fraction. Near-node
// positions snap to a single stretcher so a resting knob costs one node, not two.
inline void texturePosition(double texture01, int& i0, int& i1, double& frac) {
    const double pos = std::clamp(texture01, 0.0, 1.0)
                     * static_cast<double>(kBusTextureNodes - 1);
    i0 = static_cast<int>(pos);
    if (i0 >= kBusTextureNodes - 1) { i0 = kBusTextureNodes - 1; i1 = i0; frac = 0.0; return; }
    i1 = i0 + 1;
    frac = pos - static_cast<double>(i0);
    if (frac < 0.005)      { i1 = i0; frac = 0.0; }
    else if (frac > 0.995) { i0 = i1; frac = 0.0; }
}

// Channel-pointer scratch bound (channels_ is 6 in practice: main L/R + 4 sends).
constexpr int kMaxBusChannels = 8;

} // namespace

void NativeBusStretcher::configure(double sampleRate, int channels, int maxBlockFrames,
                                   bool asyncWarmup) {
    // A previous configure()'s background warm-up may still own the nodes — wait it out
    // before touching them. (configure is never called from the render thread.)
    joinWarmup();
    warm_.store(false, std::memory_order_relaxed);

    sampleRate_     = sampleRate;
    channels_       = std::min(channels, kMaxBusChannels);
    maxBlockFrames_ = maxBlockFrames;
    warpPivotNorm_  = 200.0 / sampleRate;
    warpFocusCenterNorm_ = kWarpFocusCenterHz / sampleRate;

    const int maxInput =
        static_cast<int>(std::ceil(static_cast<double>(maxBlockFrames) / kBusStretchMinRatio)) + 8;

    int maxSeekLen = 0;
    for (int n = 0; n < kBusTextureNodes; ++n) {
        Node& node = nodes_[static_cast<std::size_t>(n)];
        node.block    = std::max(64, static_cast<int>(sampleRate * kBusTextureBlockMs[n] / 1000.0));
        node.interval = std::max(16, node.block / 4);
        // splitComputation=true spreads the FFT work evenly across process() calls instead
        // of bunching it at hop boundaries — kills periodic CPU spikes at small buffers.
        node.stretcher.configure(channels_, node.block, node.interval, /*splitComputation=*/true);
        // Composite frequency map (transpose key-lock + spectral warp), installed ONCE per
        // node. Survives reset(); only setTransposeFactor/Semitones would clear it, which
        // this class deliberately never calls (setTranspose writes the members instead).
        node.stretcher.setFreqMap([this](float f) { return mapWarp(f); });
        node.engaged = false;
        maxSeekLen = std::max(maxSeekLen, node.stretcher.outputSeekLength(
            static_cast<float>(1.0 / kBusStretchMinRatio)));
    }

    // Internal pre-stretch input history: sized so the LARGEST node can be outputSeek-primed
    // at worst-case speed-up when a texture morph pulls it in mid-stream.
    histCap_ = maxSeekLen + 8;
    histRing_.assign(static_cast<std::size_t>(channels_),
                     std::vector<float>(static_cast<std::size_t>(histCap_), 0.0f));
    histLin_.assign(static_cast<std::size_t>(channels_),
                    std::vector<float>(static_cast<std::size_t>(histCap_), 0.0f));
    blendBuf_.assign(static_cast<std::size_t>(channels_),
                     std::vector<float>(static_cast<std::size_t>(maxBlockFrames), 0.0f));
    warmBuf_.assign(static_cast<std::size_t>(channels_),
                    std::vector<float>(static_cast<std::size_t>(maxBlockFrames), 0.0f));
    histPos_ = histCount_ = 0;
    fallbackNode_ = -1;

    textureTarget_ = textureSmoothed_ = kBusTextureDefault;
    warpPivotEff_ = warpPivotNorm_;
    // Air shelf corner ≈ 5 kHz (one-pole): lp coefficient = 1 − exp(−2π·fc/sr).
    airCoeff_ = 1.0 - std::exp(-2.0 * 3.14159265358979 * 5000.0 / sampleRate);
    // Tilt split ≈ 1 kHz (one-pole).
    tiltCoeff_ = 1.0 - std::exp(-2.0 * 3.14159265358979 * 1000.0 / sampleRate);
    resetNeutral();
    configured_ = true;

    // Warm up every node (worst-case process + outputSeek) so neither path allocates on
    // the render thread later. Ends with a reset() per node, leaving them pristine.
    // Everything the warm-up touches (the nodes + the mapWarp members read through the
    // installed freq map) is set above, BEFORE the thread may start; warm_ is the
    // release/acquire gate that hands the nodes back.
    auto warmup = [this, maxInput, maxSeekLen] {
        std::vector<float> zero(static_cast<std::size_t>(std::max(maxInput, maxSeekLen)), 0.0f);
        std::vector<const float*> inP(static_cast<std::size_t>(channels_), zero.data());
        std::vector<std::vector<float>> outBuf(static_cast<std::size_t>(channels_),
            std::vector<float>(static_cast<std::size_t>(maxBlockFrames_), 0.0f));
        std::vector<float*> outP(static_cast<std::size_t>(channels_));
        for (int c = 0; c < channels_; ++c)
            outP[static_cast<std::size_t>(c)] = outBuf[static_cast<std::size_t>(c)].data();
        for (auto& node : nodes_) {
            node.stretcher.process(inP.data(), maxInput, outP.data(), maxBlockFrames_);
            node.stretcher.outputSeek(inP.data(), maxSeekLen);
            node.stretcher.reset();
        }
        warm_.store(true, std::memory_order_release);
    };
    // P8-1b — WASM: a single-threaded build has no `std::thread` (Emscripten ABORTS on it without
    // -pthread, which itself needs SharedArrayBuffer + COOP/COEP headers). An AudioWorklet is
    // single-threaded anyway, so the async warm-up is meaningless there: take the SYNCHRONOUS path
    // that already exists. It costs ~600 ms once, at construction — not on the audio thread, and
    // not per block.
#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)
    (void)asyncWarmup;
    warmup();
#else
    if (asyncWarmup) {
        // ~600 ms for a 6-node bank — off the calling (main) thread; see the header note.
        warmupThread_ = std::thread(std::move(warmup));
    } else {
        warmup();
    }
#endif
}

NativeBusStretcher::~NativeBusStretcher() {
    joinWarmup();
}

void NativeBusStretcher::joinWarmup() {
    if (warmupThread_.joinable()) warmupThread_.join();
}

void NativeBusStretcher::setAir(double gainDb) {
    if (!configured_) return;
    const double db = std::clamp(gainDb, 0.0, 12.0);
    airGain_ = db <= 0.01 ? 0.0 : std::pow(10.0, db / 20.0) - 1.0;
}

void NativeBusStretcher::setFormant(double semitones) {
    if (!configured_) return;
    // Touches the nodes — skip while the warm-up thread owns them (re-pushed per block).
    if (!warm_.load(std::memory_order_acquire)) return;
    // 0 semitones → formantMultiplier 1 → Signalsmith skips formant processing (no cost).
    const float st = static_cast<float>(std::clamp(semitones, -24.0, 24.0));
    for (auto& node : nodes_) node.stretcher.setFormantSemitones(st, /*compensatePitch=*/false);
}

void NativeBusStretcher::setTilt(double tiltBipolar) {
    if (!configured_) return;
    // Scale the bipolar control to a musical range; 0 = flat (applyTilt early-outs).
    tiltGain_ = std::clamp(tiltBipolar, -1.0, 1.0) * 0.6;
}

void NativeBusStretcher::resetNeutral() {
    // While the configure() warm-up thread owns the nodes, skip the stretcher resets —
    // the warm-up ends with a reset() per node, so they come back pristine anyway.
    const bool touchNodes = warm_.load(std::memory_order_acquire);
    for (auto& node : nodes_) {
        if (touchNodes) node.stretcher.reset();
        node.engaged = false;
        node.warmupRemaining = 0;
        node.fadeGain = 0.0;
    }
    histPos_ = histCount_ = 0;
    fallbackNode_ = -1;
    airLp_.fill(0.0);
}

void NativeBusStretcher::reset() {
    resetNeutral();
    wasActive_ = false;
}

void NativeBusStretcher::setActive(bool active) {
    if (active != wasActive_) resetNeutral();
    wasActive_ = active;
}

void NativeBusStretcher::setTexture(double texture01) {
    if (!configured_) return;
    textureTarget_ = std::clamp(texture01, 0.0, 1.0);
}

void NativeBusStretcher::setPhaseChaos(double chaos01) {
    if (!configured_) return;
    // Touches the nodes — skip while the warm-up thread owns them (re-pushed per callback).
    if (!warm_.load(std::memory_order_acquire)) return;
    for (auto& node : nodes_) node.stretcher.setPhaseChaos(static_cast<float>(chaos01));
}

void NativeBusStretcher::setSpectralBlur(double blur01) {
    if (!configured_) return;
    // Base value only — the effective (modulated) blur is recomputed per callback in
    // updateWarpModulation() and pushed to the nodes at the top of process().
    blurBase_ = std::clamp(blur01, 0.0, 1.0);
}

void NativeBusStretcher::appendHistory(const float* const* in, int frames) {
    if (histCap_ <= 0 || frames <= 0) return;
    int srcOffset = 0;
    if (frames > histCap_) { srcOffset = frames - histCap_; frames = histCap_; }
    const int first = std::min(frames, histCap_ - histPos_);
    for (int c = 0; c < channels_; ++c) {
        float* ring = histRing_[static_cast<std::size_t>(c)].data();
        std::copy_n(in[c] + srcOffset, first, ring + histPos_);
        if (frames > first)
            std::copy_n(in[c] + srcOffset + first, frames - first, ring);
    }
    histPos_   = (histPos_ + frames) % histCap_;
    histCount_ = std::min(histCap_, histCount_ + frames);
}

int NativeBusStretcher::linearizeHistory(int frames) {
    frames = std::min(frames, histCount_);
    if (frames <= 0) return 0;
    int start = histPos_ - frames;
    if (start < 0) start += histCap_;
    const int first = std::min(frames, histCap_ - start);
    for (int c = 0; c < channels_; ++c) {
        const float* ring = histRing_[static_cast<std::size_t>(c)].data();
        float* lin = histLin_[static_cast<std::size_t>(c)].data();
        std::copy_n(ring + start, first, lin);
        if (frames > first)
            std::copy_n(ring, frames - first, lin + first);
    }
    return frames;
}

void NativeBusStretcher::beginNodeWarmup(int nodeIndex) {
    Node& node = nodes_[static_cast<std::size_t>(nodeIndex)];
    if (node.engaged) return;
    // Cheap engage: seek() is buffer copies only (no FFT work — unlike outputSeek, whose
    // inline pre-roll synthesis burst was audible as buffer noise during fast texture
    // drags). The node's startup latency is then produced-and-discarded across the
    // following callbacks (steady-state cost, spread) before it joins the mix.
    const int want = std::min(node.stretcher.seekLength(), histCap_);
    const int have = linearizeHistory(want);
    if (have >= node.block / 2) {
        const float* histPtrs[kMaxBusChannels] = {};
        for (int c = 0; c < channels_; ++c)
            histPtrs[c] = histLin_[static_cast<std::size_t>(c)].data();
        node.stretcher.seek(histPtrs, have, 1.0);
    } else {
        node.stretcher.reset();   // stream start / no usable history: cold start
    }
    node.warmupRemaining = node.stretcher.outputLatency();
    node.fadeGain = 0.0;
    node.engaged = true;
}

void NativeBusStretcher::process(const float* const* in, int inFrames,
                                 float* const* out, int outFrames, double /*ratio*/) {
    if (!configured_ || outFrames <= 0) return;
    if (!warm_.load(std::memory_order_acquire)) {
        // Background warm-up still owns the nodes (configure(asyncWarmup:true)): dry-copy
        // input → output and keep the internal history current so the first post-warm
        // engage can still prime seamlessly. The core normally routes around this via
        // isWarm() (keeping its declick state on the bypass path); this is the belt for
        // callers that don't (the plugin warms synchronously and never lands here).
        const int copyN = std::clamp(inFrames, 0, outFrames);
        for (int ch = 0; ch < channels_; ++ch) {
            std::copy_n(in[ch], copyN, out[ch]);
            if (copyN < outFrames) std::fill_n(out[ch] + copyN, outFrames - copyN, 0.0f);
        }
        appendHistory(in, inFrames);
        return;
    }

    // Advance the MOD gesture envelope and refresh the effective shift/alpha/pivot/blur.
    updateGestureModulation(outFrames);
    // Push the (possibly LFO-modulated) spectral blur into every node — cheap member
    // writes, same pattern as setPhaseChaos, so a blur sweep is click-free.
    for (auto& node : nodes_) {
        node.stretcher.setPhaseBlur(static_cast<float>(blurEff_));
        // Low-band map tracking only when Focus pulls the warp toward the lows — the stock
        // bottom fill would otherwise pin everything below the lowest detected peak.
        node.stretcher.setFreqMapLowFill(warpFocus_ < 0.0);
    }

    // Smooth the texture control (~50 ms) so coarse UI steps don't zipper the blend.
    const double k = 1.0 - std::exp(-static_cast<double>(outFrames) / (0.05 * sampleRate_));
    textureSmoothed_ += (textureTarget_ - textureSmoothed_) * k;
    if (std::abs(textureSmoothed_ - textureTarget_) < 1.0e-4) textureSmoothed_ = textureTarget_;

    int i0 = 0, i1 = 0;
    double frac = 0.0;
    texturePosition(textureSmoothed_, i0, i1, frac);

    beginNodeWarmup(i0);
    if (i1 != i0) beginNodeWarmup(i1);
    // Keep the fallback fed while the desired node(s) warm; everything else disengages
    // (idle nodes cost nothing and re-warm from history whenever the knob returns).
    for (int n = 0; n < kBusTextureNodes; ++n)
        if (n != i0 && n != i1 && n != fallbackNode_)
            nodes_[static_cast<std::size_t>(n)].engaged = false;

    // Advance fades on ready desired nodes (~20 ms so a node never pops in).
    const double fadeStep = static_cast<double>(outFrames) / (0.02 * sampleRate_);
    for (int n : { i0, i1 }) {
        Node& node = nodes_[static_cast<std::size_t>(n)];
        if (node.ready()) node.fadeGain = std::min(1.0, node.fadeGain + fadeStep);
    }

    // Contribution amplitudes: equal-power pair, each gated by its warm-up fade; any
    // energy deficit is covered by the fallback node (or folded into a ready desired
    // node when it IS the fallback), so the bus never dips while a big window warms.
    const Node& n0 = nodes_[static_cast<std::size_t>(i0)];
    const Node& n1 = nodes_[static_cast<std::size_t>(i1)];
    double a0 = (i1 == i0 ? 1.0 : std::cos(frac * 1.5707963267948966))
              * (n0.ready() ? n0.fadeGain : 0.0);
    double a1 = (i1 == i0 ? 0.0 : std::sin(frac * 1.5707963267948966))
              * (n1.ready() ? n1.fadeGain : 0.0);
    double deficit = std::sqrt(std::max(0.0, 1.0 - a0 * a0 - a1 * a1));
    double aF = 0.0;
    const bool fallbackDistinct = fallbackNode_ >= 0 && fallbackNode_ != i0 && fallbackNode_ != i1
        && nodes_[static_cast<std::size_t>(fallbackNode_)].ready();
    if (deficit > 1.0e-3) {
        if (fallbackDistinct) {
            aF = deficit;
        } else if (a0 > 0.0) {
            a0 = std::sqrt(a0 * a0 + deficit * deficit);
        } else if (a1 > 0.0) {
            a1 = std::sqrt(a1 * a1 + deficit * deficit);
        }
    }

    if (a0 <= 0.0 && a1 <= 0.0 && aF <= 0.0) {
        // Nothing ready anywhere (stream start): run the primary cold, full weight.
        Node& node = nodes_[static_cast<std::size_t>(i0)];
        node.warmupRemaining = 0;
        node.fadeGain = 1.0;
        node.stretcher.process(in, inFrames, out, outFrames);
        fallbackNode_ = i0;
        appendHistory(in, inFrames);
        return;
    }

    // Zero the output, then accumulate each contributor; warming nodes process into the
    // discard scratch (same input as everyone → they stay timeline-aligned by construction).
    for (int c = 0; c < channels_; ++c)
        std::fill_n(out[c], outFrames, 0.0f);
    float* scratch[kMaxBusChannels] = {};
    for (int c = 0; c < channels_; ++c)
        scratch[c] = blendBuf_[static_cast<std::size_t>(c)].data();
    float* discard[kMaxBusChannels] = {};
    for (int c = 0; c < channels_; ++c)
        discard[c] = warmBuf_[static_cast<std::size_t>(c)].data();

    auto contribute = [&](int nodeIndex, double amp) {
        Node& node = nodes_[static_cast<std::size_t>(nodeIndex)];
        if (!node.engaged) return;
        if (node.warmupRemaining > 0) {
            node.stretcher.process(in, inFrames, discard, outFrames);
            node.warmupRemaining -= outFrames;
            return;
        }
        node.stretcher.process(in, inFrames, scratch, outFrames);
        if (amp <= 0.0) return;
        const float a = static_cast<float>(amp);
        for (int c = 0; c < channels_; ++c) {
            float* o = out[c];
            const float* s = scratch[c];
            for (int i = 0; i < outFrames; ++i) o[i] += s[i] * a;
        }
    };

    contribute(i0, a0);
    if (i1 != i0) contribute(i1, a1);
    if (fallbackDistinct) contribute(fallbackNode_, aF);

    // Hand off the fallback role once the primary is fully faded in; the old fallback
    // then disengages on the next callback (no longer desired, no longer fallback).
    if (nodes_[static_cast<std::size_t>(i0)].ready()
        && nodes_[static_cast<std::size_t>(i0)].fadeGain >= 1.0) {
        fallbackNode_ = i0;
    }

    applyAirShelf(out, outFrames);
    applyTilt(out, outFrames);

    // Record this block's input AFTER processing so history always ends at "now".
    appendHistory(in, inFrames);
}

void NativeBusStretcher::applyAirShelf(float* const* out, int outFrames) {
    if (airGain_ <= 0.0) return;
    const double g = airGain_;
    const double c = airCoeff_;
    for (int ch = 0; ch < channels_; ++ch) {
        double lp = airLp_[static_cast<std::size_t>(ch)];
        float* o = out[ch];
        for (int i = 0; i < outFrames; ++i) {
            const double x = static_cast<double>(o[i]);
            lp += c * (x - lp);
            o[i] = static_cast<float>(x + g * (x - lp));
        }
        airLp_[static_cast<std::size_t>(ch)] = lp;
    }
}

void NativeBusStretcher::applyTilt(float* const* out, int outFrames) {
    if (std::abs(tiltGain_) <= 1.0e-4) return;
    const double g = tiltGain_;
    const double c = tiltCoeff_;
    for (int ch = 0; ch < channels_; ++ch) {
        double lp = tiltLp_[static_cast<std::size_t>(ch)];
        float* o = out[ch];
        for (int i = 0; i < outFrames; ++i) {
            const double x = static_cast<double>(o[i]);
            lp += c * (x - lp);
            // out = x + g·(high − low), high = x − lp, low = lp → x + g·(x − 2·lp).
            o[i] = static_cast<float>(x + g * (x - 2.0 * lp));
        }
        tiltLp_[static_cast<std::size_t>(ch)] = lp;
    }
}

void NativeBusStretcher::setTranspose(double semitones, double tonalityLimit) {
    if (!configured_) return;
    // transposeMult_/keylockCorner_ are read by mapWarp, which the warm-up thread drives
    // through the installed freq map — don't race it. Re-pushed every callback, so a
    // skipped write during the warm-up window is applied on the first post-warm block.
    if (!warm_.load(std::memory_order_acquire)) return;
    // RT-safe member writes consumed by mapWarp (shared by every node's frequency map).
    // Mirrors the library's own setTransposeFactor math (corner = tonality/√mult; ≤0 →
    // corner above Nyquist = off). Deliberately NOT setTransposeSemitones — that clears
    // the custom map.
    const double mult = std::pow(2.0, semitones / 12.0);
    transposeMult_ = mult;
    keylockCorner_ = tonalityLimit > 0.0 ? tonalityLimit / std::sqrt(mult) : 1.0;
}

void NativeBusStretcher::setWarp(double shiftNorm, double alpha, double pivotNorm) {
    if (!configured_) return;
    warpShiftNorm_ = shiftNorm;
    warpAlpha_     = alpha > 1.0e-3 ? alpha : 1.0e-3;   // α must stay positive (monotonicity)
    if (pivotNorm > 1.0e-9) warpPivotNorm_ = pivotNorm;
}

void NativeBusStretcher::setWarpFocus(double focusBipolar) {
    if (!configured_) return;
    warpFocus_ = std::clamp(focusBipolar, -1.0, 1.0);
}

void NativeBusStretcher::setGestureTarget(double target) {
    if (!configured_) return;
    gestureTarget_ = std::clamp(target, -1.0, 1.0);
}

void NativeBusStretcher::setGestureShape(double depth, double riseSecs) {
    if (!configured_) return;
    gestureDepth_    = std::clamp(depth, 0.0, 1.0);
    gestureRiseSecs_ = std::clamp(riseSecs, 0.05, 2.0);
}

void NativeBusStretcher::setCrossMod(double amount) {
    if (!configured_) return;
    xmodAmount_ = std::clamp(amount, -1.0, 1.0);
}

void NativeBusStretcher::injectGesturePulse(double strength) {
    if (!configured_) return;
    // Retriggers take the max so a hard hit is never softened by a decaying tail.
    xmodPulse_ = std::max(xmodPulse_, std::clamp(strength, 0.0, 1.0));
}

void NativeBusStretcher::setModExternal(double bipolar) {
    if (!configured_) return;
    modExternal_ = std::clamp(bipolar, -1.0, 1.0);
}

void NativeBusStretcher::updateGestureModulation(int outFrames) {
    // ── MOD gesture envelope ─────────────────────────────────────────────────────────
    // Spring-loaded momentary sweep: charge toward the held target with a FAST START
    // (a ~150 ms tap already reaches a satisfying zap depth, full sweep after ~1.5 s of
    // hold), then spring back to 0 on release over a time proportional to how long the
    // gesture was performed (tap = quick zap-back, long hold = slow settle).
    const double dt = static_cast<double>(outFrames) / sampleRate_;
    if (gestureTarget_ != 0.0) {
        // Charge rate ∝ (headroom + margin): fast when far from the target, easing as it
        // approaches — with the default rise (0.35 s time constant) |value| ≈ 40% after a
        // 150 ms tap, ~full at 1.5 s. gestureRiseSecs_ ("MOD rise") scales the whole feel:
        // smaller = snappier taps AND faster full sweeps, larger = slow swells.
        const double toward = gestureTarget_ - gestureValue_;
        gestureValue_ += toward * std::min(1.0, dt / gestureRiseSecs_ * 1.2);
        gestureValue_ = std::clamp(gestureValue_, -1.0, 1.0);
        gestureHeldSecs_ += dt;
        // Release length armed continuously so a target→0 edge between callbacks is safe.
        gestureReleaseSecs_ = std::clamp(0.5 * gestureHeldSecs_, 0.08, 1.2);
    } else if (gestureValue_ != 0.0) {
        const double step = dt / std::max(0.08, gestureReleaseSecs_);
        if (std::abs(gestureValue_) <= step) {
            gestureValue_ = 0.0;
            gestureHeldSecs_ = 0.0;
        } else {
            gestureValue_ -= step * (gestureValue_ > 0.0 ? 1.0 : -1.0);
        }
    } else {
        gestureHeldSecs_ = 0.0;
    }

    // ── X-MOD pulse envelope ─────────────────────────────────────────────────────────
    // Opposite-deck onsets (injected by the core) hit instantly and decay exponentially —
    // punchy, sidechain-like. Rides the SAME voicing as the manual gesture below.
    const double kXModDecaySecs = 0.15;
    if (xmodPulse_ > 0.0) {
        xmodPulse_ *= std::exp(-dt / kXModDecaySecs);
        if (xmodPulse_ < 1.0e-3) xmodPulse_ = 0.0;
    }

    // ── Gesture voicing (the one place to tune the sound of the sweep) ─────────────────
    // g > 0 (rise): shift up + overtones spread + pivot/formants climb + light blur bloom
    //               → laser/riser, brightening.
    // g < 0 (dive): shift hollows + overtones compress + formants fall + heavy blur bloom
    //               → dark smear/dive. Relations are multiplicative where a base value
    //               exists (α, pivot, blur) so the gesture scales WITH the dialled sound.
    // Sources: manual spring gesture (scaled by "MOD depth") + X-MOD pulses (scaled by the
    // bipolar X-MOD amount — its sign picks rise-stabs vs sidechain-dives).
    const double g = std::clamp(gestureValue_ * gestureDepth_ + xmodAmount_ * xmodPulse_
                                    + modExternal_,
                                -1.0, 1.0);
    gestureDisplay_ = std::clamp(gestureValue_ + xmodAmount_ * xmodPulse_, -1.0, 1.0);
    const double kGestureShiftHz   = 600.0;  // ± full-sweep frequency shift
    const double kGestureAlphaOct  = 0.6;    // ± octaves on the stretch exponent
    const double kGesturePivotOct  = 1.5;    // ± octaves of formant rise/fall
    const double kGestureBlurRise  = 0.25;   // blur bloom at full rise
    const double kGestureBlurDive  = 0.5;    // blur bloom at full dive (smears harder)
    warpShiftEff_ = warpShiftNorm_ + g * (kGestureShiftHz / sampleRate_);
    warpAlphaEff_ = std::clamp(warpAlpha_ * std::exp2(g * kGestureAlphaOct), 1.0e-3, 16.0);
    warpPivotEff_ = std::clamp(warpPivotNorm_ * std::exp2(g * kGesturePivotOct),
                               20.0 / sampleRate_, 0.45);
    blurEff_ = std::clamp(blurBase_ + std::abs(g) * (g < 0.0 ? kGestureBlurDive
                                                             : kGestureBlurRise),
                          0.0, 1.0);
}

void NativeBusStretcher::engagePrimed(const float* const* history, int historyFrames) {
    if (!configured_ || historyFrames <= 0) return;
    if (!warm_.load(std::memory_order_acquire)) return;  // warm-up thread owns the nodes
    // Seed the internal history from the core's ring so texture morphs shortly after the
    // engage can warm further nodes.
    histPos_ = histCount_ = 0;
    appendHistory(history, historyFrames);

    int i0 = 0, i1 = 0;
    double frac = 0.0;
    texturePosition(textureSmoothed_, i0, i1, frac);
    for (auto& node : nodes_) {
        node.engaged = false;
        node.warmupRemaining = 0;
        node.fadeGain = 0.0;
    }

    // The engage itself must produce aligned audio IMMEDIATELY (the core crossfades
    // dry→wet right after this call), so one node is primed inline via outputSeek. Its
    // pre-roll synthesis burst is bounded by capping the bridge at the 240 ms node; a
    // larger desired window then warms in spread across the following callbacks and the
    // normal morph machinery hands over — the texture blooms into the wide setting over
    // ~its window length instead of glitching the callback.
    const int bridge = std::min(i0, 3);
    Node& bridgeNode = nodes_[static_cast<std::size_t>(bridge)];
    bridgeNode.stretcher.outputSeek(history, historyFrames);
    bridgeNode.engaged = true;
    bridgeNode.warmupRemaining = 0;
    bridgeNode.fadeGain = 1.0;
    fallbackNode_ = bridge;

    if (i0 != bridge) beginNodeWarmup(i0);
    if (i1 != i0 && i1 != bridge) beginNodeWarmup(i1);
}

int NativeBusStretcher::engageInputLength(double playbackRate) const {
    if (!configured_) return 0;
    // Conservative: the LARGEST node's requirement, so any texture position primes fully.
    return nodes_[kBusTextureNodes - 1].stretcher.outputSeekLength(
        static_cast<float>(std::max(0.0, playbackRate)));
}

int NativeBusStretcher::blockFrames() const {
    if (!configured_) return 0;
    int i0 = 0, i1 = 0;
    double frac = 0.0;
    texturePosition(textureSmoothed_, i0, i1, frac);
    return nodes_[static_cast<std::size_t>(i0)].block;
}

int NativeBusStretcher::intervalFrames() const {
    if (!configured_) return 0;
    int i0 = 0, i1 = 0;
    double frac = 0.0;
    texturePosition(textureSmoothed_, i0, i1, frac);
    return nodes_[static_cast<std::size_t>(i0)].interval;
}

int NativeBusStretcher::startupLatencyFrames() const {
    if (!configured_) return 0;
    int i0 = 0, i1 = 0;
    double frac = 0.0;
    texturePosition(textureSmoothed_, i0, i1, frac);
    const auto& s = nodes_[static_cast<std::size_t>(i0)].stretcher;
    return s.inputLatency() + s.outputLatency();
}

} // namespace scoopyloops
