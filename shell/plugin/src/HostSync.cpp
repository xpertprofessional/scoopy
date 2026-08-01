#include "HostSync.h"

#include "sl_engine.h"

#include <cmath>

namespace wizard::plugin {

namespace {
// The shipping app clamps the nudged target to ≤600 BPM (BeatSequencer's sync
// law); here the equivalent guard is on the RATIO, wide enough for any musical
// host tempo against any session tempo, tight enough that a garbage playhead
// (bpm=0 flickers, 1e6 automation spikes) never reaches the stretcher.
constexpr double kMinRatio = 1.0 / 16.0;
constexpr double kMaxRatio = 16.0;
// Mirrors the plane's dedup sensibility: the ABI already ignores identical
// values, this just avoids building the call at all for sub-audible drift.
constexpr double kRatioEpsilon = 1e-4;
} // namespace

void HostSync::capture(juce::AudioPlayHead* playhead, const sl_engine* engine) noexcept {
    if (playhead == nullptr) {
        hasPlayhead.store(false, std::memory_order_relaxed);
        return;
    }
    const auto pos = playhead->getPosition();
    if (!pos.hasValue()) {
        hasPlayhead.store(false, std::memory_order_relaxed);
        return;
    }
    if (const auto bpm = pos->getBpm(); bpm.hasValue() && *bpm > 0.0)
        hostBpm.store(*bpm, std::memory_order_relaxed);
    if (const auto ppq = pos->getPpqPosition(); ppq.hasValue())
        hostPpq.store(*ppq, std::memory_order_relaxed);
    hostPlaying.store(pos->getIsPlaying(), std::memory_order_relaxed);
    if (engine != nullptr)
        engineTimeAtCapture.store(sl_engine_time_samples(engine), std::memory_order_relaxed);
    hasPlayhead.store(true, std::memory_order_relaxed);
}

HostSync::Snapshot HostSync::snapshot() const noexcept {
    Snapshot s;
    s.bpm = hostBpm.load(std::memory_order_relaxed);
    s.ppq = hostPpq.load(std::memory_order_relaxed);
    s.playing = hostPlaying.load(std::memory_order_relaxed);
    s.valid = hasPlayhead.load(std::memory_order_relaxed);
    s.engineTime = engineTimeAtCapture.load(std::memory_order_relaxed);
    return s;
}

bool HostSync::pump(sl_engine* engine, bool writeRatio) {
    if (engine == nullptr) return false;
    const auto s = snapshot();
    if (!s.valid) return false;

    // Resolve-by-name once, never hardcode the int (the ABI's own rule).
    if (idSyncRatio == -2) idSyncRatio = sl_param_id_for_name("syncRatio");
    if (idTempoMode == -2) idTempoMode = sl_param_id_for_name("tempoMode");

    // THE MASTER TEMPO. The host's playhead by default; a positive
    // `recipe.masterBpm` is the user's INTERNAL master and wins (D2). Note the
    // valid-playhead guard above still applies — with no playhead we write
    // nothing even on an internal master, because `capture` is also how we know
    // the host is there at all, and an offline render should not be re-pitched.
    const double master = recipe.masterBpm > 0.0 ? recipe.masterBpm : s.bpm;

    if (writeRatio && recipe.syncEnabled && recipe.sessionBpm > 0.0 && master > 0.0 &&
        idSyncRatio != SL_PARAM_UNKNOWN && idTempoMode != SL_PARAM_UNKNOWN) {
        const double raw = master * recipe.pulseMultiplier / recipe.sessionBpm;
        const double ratio = std::clamp(raw, kMinRatio, kMaxRatio);
        const bool modeChanged = recipe.tempoMode != lastMode;
        if (modeChanged || std::abs(ratio - lastRatio) > kRatioEpsilon) {
            // Mode FIRST: applyDeckParams routes the ratio by the mode it
            // finds, and writing them in the other order would let one pump
            // tick run the old mode with the new ratio.
            if (modeChanged) sl_param_set(engine, 0, idTempoMode, (double) recipe.tempoMode);
            sl_param_set(engine, 0, idSyncRatio, ratio);
            lastMode = recipe.tempoMode;
            lastRatio = ratio;
        }
    }

    // Transport edge — reported, not applied: starting a deck is a WORLD
    // publish (isPlaying rides the snapshot), and the world lives with the
    // processor, not here.
    if (s.playing != lastPlaying) {
        lastPlaying = s.playing;
        return recipe.followTransport;
    }
    return false;
}

} // namespace wizard::plugin
