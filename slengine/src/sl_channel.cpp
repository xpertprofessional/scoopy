// The uniform strip channel — see sl_channel.h for why this is a projection
// rather than a second mixer.
#include "sl_channel.h"

#include "sl_tape.h"
#include "NativeMasterDrive.hpp" // per-strip DRV (P3-X2) — reused as-is, one instance per channel

#include <algorithm>
#include <cmath>

namespace sl {
namespace {

constexpr double kRampSeconds = 0.010; // D-WZ-RAMP-01: the one 10 ms constant

/** The structural bound on a channel's output, +24 dBFS.

    WHY IT EXISTS, and why the output watchdog is not enough on its own: every
    route reads a CHANNEL OUTPUT, so a feedback loop between strips closes here
    and never passes through the main bus. A limiter on the output therefore
    cannot bound it — the internal signal reaches infinity first, and limiting
    infinity still gives infinity. (Wizard's watchdog did bound its loop, but
    only because that loop ran THROUGH the limited output bus; this topology
    bypasses it, which is a difference worth stating rather than inheriting the
    old reasoning by habit.)

    So the loop is bounded where it closes. This is a NUMERICAL guard, not a
    musical one: it exists to stop divergence reaching infinity, and the audible
    protection is the watchdog's RMS limiter on the main bus. It is therefore
    set far above anything that could occur legitimately — real audio lives
    below ~10 even in a hot sum, and the headless fixtures use values up to a
    few hundred (their "sample value = frame index" convention). Nothing that is
    not already a fault comes near it, so it colours nothing; it simply turns a
    runaway from "NaN reaches the device" into "the guard engages, the lamp
    lights, and the output is held". */
constexpr double kChannelCeiling = 4096.0; // +72 dBFS

/** Bound a channel sample: non-finite becomes silence rather than spreading,
    and magnitude is capped. A NaN admitted here would propagate through every
    route and every take that touches this strip. */
inline float boundSample(double v) {
    if (!std::isfinite(v)) return 0.0f;
    return static_cast<float>(std::clamp(v, -kChannelCeiling, kChannelCeiling));
}

/** Glide `sm` toward `target` by one sample. A negative `sm` means "not seeded
    yet": take the target outright, so a channel does not fade in from silence
    the first time it is heard — the ramp exists to stop STEPS, not to add an
    attack to every strip that has been sitting at a fixed level all along. */
/** Raise `a` to `v` if `v` is larger, atomically. The loop re-reads on failure,
    which is the whole point: a concurrent consume-and-reset must win, or the
    meter it just cleared would be refilled with a value already displayed. */
inline void fetchMax(std::atomic<double>& a, double v) {
    double cur = a.load(std::memory_order_relaxed);
    while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {}
}

inline void glide(double& sm, double target, double alpha) {
    if (sm < 0.0) { sm = target; return; }
    sm += alpha * (target - sm);
    // Snap when inaudibly close, so a channel parked at unity multiplies by
    // EXACTLY 1.0 and a tape's bit-exact identity path survives the channel.
    // A one-pole only approaches its target, so without this "unity" would be
    // 0.99999… forever and every sample would be quietly scaled.
    if (std::abs(target - sm) < 1e-9) sm = target;
}

} // namespace

void ChannelBank::configure(double sampleRate, uint32_t maxBlockFrames) {
    (void)sampleRate; // scratch is sized in frames; the rate only shapes ramps
    for (uint32_t c = 0; c < kMaxChannels; ++c) {
        outL_[c].assign(maxBlockFrames, 0.0f);
        outR_[c].assign(maxBlockFrames, 0.0f);
        prevL_[c].assign(maxBlockFrames, 0.0f);
        prevR_[c].assign(maxBlockFrames, 0.0f);
        inL_[c].assign(maxBlockFrames, 0.0f);
        inR_[c].assign(maxBlockFrames, 0.0f);
        mon_[c].assign(maxBlockFrames, 0.0f);
        // The DRV DSP (P3-X2). Allocated here — the one place this bank may
        // allocate — and merely RESET on a reconfigure, since drive history is
        // scratch, not document (the params survive; they are atomics above).
        if (drive_[c] == nullptr)
            drive_[c] = std::make_unique<scoopyloops::NativeMasterDrive>();
        drive_[c]->reset();
        driveActive_[c] = false;
    }
    // ROUTES ARE NOT TOUCHED HERE, and that is the whole point of this comment.
    //
    // configure() runs on every rate change, and SlRenderSink::setSampleRate
    // performs one on every device open (D-WZ-RATE-01's stop → set → start
    // rebuild). An earlier cut of this file cleared the routes and reinstalled
    // the boot defaults here, which meant plugging in a different interface
    // silently threw away the user's entire patchbay and wired everything back
    // to main. Sizing buffers and owning the document are different jobs.
    //
    // The same care is already taken with tape MATERIAL for the same reason —
    // a rate change must not silently discard a take — so it would be a strange
    // asymmetry to protect the audio and drop the wiring.
    //
    // Defaults are installed ONCE, explicitly, at engine create.
    // Recompute the order rather than resetting it to identity: on a fresh bank
    // there are no routes and it IS identity, and on a reconfigure the surviving
    // routes still constrain it.
    rebuildOrder();
}

/* --- routing -------------------------------------------------------------- */

void ChannelBank::clearRoutes() {
    for (auto& rt : routes_) rt.active.store(0u, std::memory_order_release);
    rebuildOrder();
}

void ChannelBank::installDefaultRoutes() {
    // A fresh engine is wired straight through, the way a mixer's channel 1 is
    // wired to jack 1: every strip reaches main, every send reaches its
    // matching effect. These are REAL routes, visible and removable — the
    // document can re-point any of them (decision 5: the channel owns the
    // send's level, the routing owns its destination) — but they exist so a
    // strip you just made is audible without ceremony.
    // `instant` (no fade-in) and `markDefault` go in through addRouteInternal
    // so they are written BEFORE the slot is published. Setting them afterwards
    // races the render, which is already gliding the new route's gain.
    for (uint32_t c = 0; c < kMaxChannels; ++c) {
        addRouteInternal(static_cast<uint32_t>(SourceEndpoint::channelOut), c, kNoIndex,
                         static_cast<uint32_t>(DestEndpoint::main), 0, 1.0, 0,
                         /*instant=*/true, /*markDefault=*/true);
        for (uint32_t s = 0; s < kNumSends; ++s)
            addRouteInternal(static_cast<uint32_t>(SourceEndpoint::channelSend), c, s,
                             static_cast<uint32_t>(DestEndpoint::sendBus), s, 1.0, 0,
                             /*instant=*/true, /*markDefault=*/true);
    }
}

uint32_t ChannelBank::routeCountActive() const {
    uint32_t n = 0;
    for (const auto& rt : routes_)
        if (rt.active.load(std::memory_order_acquire) == 1u) ++n;
    return n;
}

bool ChannelBank::reaches(uint32_t src, uint32_t dst) const {
    // Depth-first over ACTIVE NON-FEEDBACK routes only: a feedback edge is
    // broken by the block boundary, so it can never be part of a cycle that
    // matters to the render order.
    if (src >= kMaxChannels || dst >= kMaxChannels) return false;
    bool seen[kMaxChannels] = {};
    uint32_t stack[kMaxChannels];
    uint32_t top = 0;
    stack[top++] = src;
    seen[src] = true;
    while (top > 0) {
        const uint32_t node = stack[--top];
        if (node == dst && node != src) return true;
        for (uint32_t r = 0; r < kMaxRoutes; ++r) {
            const Route& rt = routes_[r];
            if (rt.active.load(std::memory_order_acquire) == 0) continue;
            if (rt.feedback.load(std::memory_order_relaxed) != 0) continue;
            if (rt.dependsOn() != node) continue;
            const uint32_t next = rt.feeds();
            if (next >= kMaxChannels || seen[next]) continue;
            if (next == dst) return true;
            seen[next] = true;
            stack[top++] = next;
        }
    }
    return false;
}

int32_t ChannelBank::addRoute(uint32_t src, uint32_t dst, double gain, uint32_t feedback) {
    return addRoute(static_cast<uint32_t>(SourceEndpoint::channelOut), src, kNoIndex,
                    static_cast<uint32_t>(DestEndpoint::channelIn), dst, gain, feedback);
}

int32_t ChannelBank::addRoute(uint32_t srcKind, uint32_t srcIndex, uint32_t srcSub,
                              uint32_t dstKind, uint32_t dstIndex, double gain,
                              uint32_t feedback) {
    return addRouteInternal(srcKind, srcIndex, srcSub, dstKind, dstIndex, gain, feedback,
                            /*instant=*/false, /*markDefault=*/false);
}

int32_t ChannelBank::addRouteInternal(uint32_t srcKind, uint32_t srcIndex, uint32_t srcSub,
                                      uint32_t dstKind, uint32_t dstIndex, double gain,
                                      uint32_t feedback, bool instant, bool markDefault) {
    if (!std::isfinite(gain) || gain < 0.0) return -1;
    if (srcKind > static_cast<uint32_t>(SourceEndpoint::deckOut)) return -1;
    if (dstKind > static_cast<uint32_t>(DestEndpoint::main)) return -1;

    // Endpoint-specific range checks. An out-of-range endpoint is REFUSED
    // rather than clamped: clamping would silently patch a cable somewhere the
    // user did not ask for, which is worse than the edit failing.
    const auto sk = static_cast<SourceEndpoint>(srcKind);
    const auto dk = static_cast<DestEndpoint>(dstKind);
    switch (sk) {
        case SourceEndpoint::channelOut:
            if (srcIndex >= kMaxChannels) return -1;
            break;
        case SourceEndpoint::channelSend:
            if (srcIndex >= kMaxChannels || srcSub >= kNumSends) return -1;
            break;
        case SourceEndpoint::deviceInput: break; // resolved against inCount at render
        case SourceEndpoint::fxReturn:
            if (srcIndex >= kNumSends) return -1;
            break;
        case SourceEndpoint::deckOut:
            // Range-checked against the DECK space, not the channel space: they
            // are different sizes (3 vs 8), and clamping one into the other is
            // how a cable lands on a deck nobody named.
            if (srcIndex >= kMaxDeckOuts) return -1;
            break;
    }
    switch (dk) {
        case DestEndpoint::channelIn:
            if (dstIndex >= kMaxChannels) return -1;
            break;
        case DestEndpoint::sendBus:
            if (dstIndex >= kNumSends) return -1;
            break;
        case DestEndpoint::main: break;
    }

    // A channel feeding itself is a cycle of length one, which the graph walk
    // below would not report.
    const bool channelSourced =
        sk == SourceEndpoint::channelOut || sk == SourceEndpoint::channelSend;
    if (channelSourced && dk == DestEndpoint::channelIn) {
        if (srcIndex == dstIndex) return -1;
        // THE GUARD. Without explicit feedback consent, a route that closes a
        // loop is refused rather than silently turned into a delay — the render
        // order could not express it, and quietly making it one-block-late is
        // how a patch acquires latency nobody asked for.
        if (feedback == 0 && reaches(dstIndex, srcIndex)) return -1;
    }

    for (uint32_t r = 0; r < kMaxRoutes; ++r) {
        Route& rt = routes_[r];
        if (rt.active.load(std::memory_order_acquire) != 0) continue;
        rt.srcKind.store(srcKind, std::memory_order_relaxed);
        rt.srcIndex.store(srcIndex, std::memory_order_relaxed);
        rt.srcSub.store(srcSub, std::memory_order_relaxed);
        rt.dstKind.store(dstKind, std::memory_order_relaxed);
        rt.dstIndex.store(dstIndex, std::memory_order_relaxed);
        rt.feedback.store(feedback != 0 ? 1u : 0u, std::memory_order_relaxed);
        rt.gain.store(gain, std::memory_order_relaxed);
        rt.isDefault.store(markDefault ? 1u : 0u, std::memory_order_relaxed);
        // Seed the ramp at ZERO so a newly patched cable fades IN over the 10 ms
        // constant. Patching a live signal is a crossfade, not a switch. The
        // boot wiring is the exception — it was never not-there, so it starts at
        // its target rather than swelling up at startup.
        rt.smGain.store(instant ? gain : 0.0, std::memory_order_relaxed);
        // EVERY field above is written BEFORE this store. The release here pairs
        // with the render's acquire load of `active`, which is what publishes
        // them safely; anything written after would be a plain data race against
        // a render that has already picked the route up.
        rt.active.store(1u, std::memory_order_release);
        rebuildOrder();
        return static_cast<int32_t>(r);
    }
    return -1; // no free slot
}

int32_t ChannelBank::removeRoute(uint32_t id) {
    if (id >= kMaxRoutes) return 0;
    Route& rt = routes_[id];
    if (rt.active.load(std::memory_order_acquire) == 0) return 0;
    // Marked for release: the render ramps the gain DOWN and drops the route
    // only once it reaches zero, so unpatching is a fade rather than a cut.
    rt.active.store(2u, std::memory_order_release);
    rebuildOrder(); // it no longer constrains the order
    return 1;
}

void ChannelBank::setRouteGain(uint32_t id, double gain) {
    if (id >= kMaxRoutes || !std::isfinite(gain) || gain < 0.0) return;
    routes_[id].gain.store(gain, std::memory_order_relaxed);
}

double ChannelBank::routeGain(uint32_t id) const {
    return id >= kMaxRoutes ? 0.0 : routes_[id].gain.load(std::memory_order_relaxed);
}

uint32_t ChannelBank::routeActive(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : (routes_[id].active.load(std::memory_order_acquire) == 1u ? 1u : 0u);
}

uint32_t ChannelBank::routeSourceKind(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : routes_[id].srcKind.load(std::memory_order_relaxed);
}
uint32_t ChannelBank::routeSourceIndex(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : routes_[id].srcIndex.load(std::memory_order_relaxed);
}
uint32_t ChannelBank::routeSourceSub(uint32_t id) const {
    return id >= kMaxRoutes ? kNoIndex : routes_[id].srcSub.load(std::memory_order_relaxed);
}
uint32_t ChannelBank::routeDestKind(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : routes_[id].dstKind.load(std::memory_order_relaxed);
}
uint32_t ChannelBank::routeDestIndex(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : routes_[id].dstIndex.load(std::memory_order_relaxed);
}
uint32_t ChannelBank::routeFeedback(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : routes_[id].feedback.load(std::memory_order_relaxed);
}
uint32_t ChannelBank::routeIsDefault(uint32_t id) const {
    return id >= kMaxRoutes ? 0u : routes_[id].isDefault.load(std::memory_order_relaxed);
}

void ChannelBank::renderOrder(uint32_t* out) const {
    if (out == nullptr) return;
    const uint64_t p = orderPacked_.load(std::memory_order_acquire);
    for (uint32_t i = 0; i < kMaxChannels; ++i) out[i] = unpackOrder(p, i);
}

void ChannelBank::rebuildOrder() {
    // Kahn over active non-feedback routes. Channels with no edges keep their
    // index order, so an unrouted session renders exactly as it did before
    // routing existed — the order is a refinement, not a reshuffle.
    uint32_t indeg[kMaxChannels] = {};
    for (uint32_t r = 0; r < kMaxRoutes; ++r) {
        const Route& rt = routes_[r];
        if (rt.active.load(std::memory_order_acquire) != 1u) continue;
        if (rt.feedback.load(std::memory_order_relaxed) != 0) continue;
        // Only a CHANNEL→CHANNEL edge constrains the order. A device input or
        // an FX return is already present when the block starts, and a send bus
        // or main is a terminus nothing reads back — neither orders anything.
        if (rt.dependsOn() == kNoIndex) continue;
        const uint32_t d = rt.feeds();
        if (d < kMaxChannels) ++indeg[d];
    }

    uint32_t out[kMaxChannels];
    uint32_t n = 0;
    bool done[kMaxChannels] = {};
    for (uint32_t pass = 0; pass < kMaxChannels; ++pass) {
        // Lowest ready index first: deterministic, so the same patch always
        // yields the same order and a test can assert on it.
        uint32_t pick = kMaxChannels;
        for (uint32_t c = 0; c < kMaxChannels; ++c)
            if (!done[c] && indeg[c] == 0) { pick = c; break; }
        if (pick == kMaxChannels) break; // only cycles left (cannot happen: refused at edit time)
        done[pick] = true;
        out[n++] = pick;
        for (uint32_t r = 0; r < kMaxRoutes; ++r) {
            const Route& rt = routes_[r];
            if (rt.active.load(std::memory_order_acquire) != 1u) continue;
            if (rt.feedback.load(std::memory_order_relaxed) != 0) continue;
            if (rt.dependsOn() != pick) continue;
            const uint32_t d = rt.feeds();
            if (d < kMaxChannels && indeg[d] > 0) --indeg[d];
        }
    }
    // Anything left (only possible if a cycle slipped in) is appended in index
    // order rather than dropped: a wrong order is a wrong delay, but a MISSING
    // channel is silence, and silence is the worse failure.
    for (uint32_t c = 0; c < kMaxChannels; ++c)
        if (!done[c]) out[n++] = c;

    // ONE store: the render can only ever see the whole old order or the whole
    // new one, never a half-and-half that names a channel twice.
    orderPacked_.store(packOrder(out), std::memory_order_release);
}

/* --- control surface ------------------------------------------------------ */

int32_t ChannelBank::setSource(uint32_t ch, uint32_t kind, uint32_t index) {
    if (ch >= kMaxChannels) return 0;
    if (kind > static_cast<uint32_t>(ChannelSourceKind::gridDeck)) return 0;
    if (kind == static_cast<uint32_t>(ChannelSourceKind::tape) && index >= TapeBank::count())
        return 0;
    channels_[ch].srcIndex.store(index, std::memory_order_relaxed);
    channels_[ch].srcKind.store(kind, std::memory_order_release);
    return 1;
}

uint32_t ChannelBank::sourceKind(uint32_t ch) const {
    return ch >= kMaxChannels ? 0u : channels_[ch].srcKind.load(std::memory_order_acquire);
}

uint32_t ChannelBank::sourceIndex(uint32_t ch) const {
    return ch >= kMaxChannels ? 0u : channels_[ch].srcIndex.load(std::memory_order_relaxed);
}

void ChannelBank::setLevel(uint32_t ch, double level) {
    if (ch >= kMaxChannels || !std::isfinite(level) || level < 0.0) return;
    channels_[ch].level.store(level, std::memory_order_relaxed);
}

double ChannelBank::level(uint32_t ch) const {
    return ch >= kMaxChannels ? 0.0 : channels_[ch].level.load(std::memory_order_relaxed);
}

void ChannelBank::setSend(uint32_t ch, uint32_t send, double level) {
    if (ch >= kMaxChannels || send >= kNumSends || !std::isfinite(level) || level < 0.0) return;
    channels_[ch].send[send].store(level, std::memory_order_relaxed);
}

double ChannelBank::sendLevel(uint32_t ch, uint32_t send) const {
    if (ch >= kMaxChannels || send >= kNumSends) return 0.0;
    return channels_[ch].send[send].load(std::memory_order_relaxed);
}

void ChannelBank::setMute(uint32_t ch, uint32_t muted) {
    if (ch >= kMaxChannels) return;
    channels_[ch].mute.store(muted != 0 ? 1u : 0u, std::memory_order_relaxed);
}

uint32_t ChannelBank::muted(uint32_t ch) const {
    return ch >= kMaxChannels ? 0u : channels_[ch].mute.load(std::memory_order_relaxed);
}

void ChannelBank::setMonitor(uint32_t ch, uint32_t on) {
    if (ch >= kMaxChannels) return;
    channels_[ch].monitor.store(on != 0 ? 1u : 0u, std::memory_order_relaxed);
}

void ChannelBank::setDrive(uint32_t ch, uint32_t curve, double amount) {
    if (ch >= kMaxChannels) return;
    // The two params are validated INDEPENDENTLY — a typo'd curve must not also
    // discard a good amount. Unknown curve keeps the old one (a wrong curve is
    // DSP the user never chose); a non-finite amount keeps the old one too.
    if (curve <= 3u)
        channels_[ch].driveCurve.store(curve, std::memory_order_relaxed);
    if (std::isfinite(amount))
        channels_[ch].driveAmount.store(std::clamp(amount, 1.0, 32.0),
                                        std::memory_order_relaxed);
}

uint32_t ChannelBank::driveCurve(uint32_t ch) const {
    return ch >= kMaxChannels ? 0u : channels_[ch].driveCurve.load(std::memory_order_relaxed);
}

double ChannelBank::driveAmount(uint32_t ch) const {
    return ch >= kMaxChannels ? 1.0 : channels_[ch].driveAmount.load(std::memory_order_relaxed);
}

uint32_t ChannelBank::monitorOn(uint32_t ch) const {
    return ch >= kMaxChannels ? 0u : channels_[ch].monitor.load(std::memory_order_relaxed);
}

double ChannelBank::consumePeakL(uint32_t ch) {
    if (ch >= kMaxChannels) return 0.0;
    return channels_[ch].peakL.exchange(0.0, std::memory_order_relaxed);
}

double ChannelBank::consumePeakR(uint32_t ch) {
    if (ch >= kMaxChannels) return 0.0;
    return channels_[ch].peakR.exchange(0.0, std::memory_order_relaxed);
}

int32_t ChannelBank::channelForTape(uint32_t tape) const {
    for (uint32_t c = 0; c < kMaxChannels; ++c)
        if (channels_[c].srcKind.load(std::memory_order_acquire) ==
                static_cast<uint32_t>(ChannelSourceKind::tape) &&
            channels_[c].srcIndex.load(std::memory_order_relaxed) == tape)
            return static_cast<int32_t>(c);
    return -1;
}

const float* ChannelBank::outL(uint32_t ch) const {
    return ch >= kMaxChannels ? nullptr : outL_[ch].data();
}

const float* ChannelBank::outR(uint32_t ch) const {
    return ch >= kMaxChannels ? nullptr : outR_[ch].data();
}

/* --- render --------------------------------------------------------------- */

void ChannelBank::mixInto(float* const* lanes, uint32_t laneCount, uint32_t frames,
                          const TapeBank& tapes, double sampleRate, const LaneMap& map,
                          const float* const* inBus, uint32_t inCount,
                          const float* const* deckOut, uint32_t deckOutCount) {
    const double fs = sampleRate > 0.0 ? sampleRate : 48000.0;
    const double alpha = 1.0 - std::exp(-1.0 / (kRampSeconds * fs));

    const auto lane = [&](uint32_t idx) -> float* {
        return (lanes != nullptr && idx < laneCount) ? lanes[idx] : nullptr;
    };
    float* mainL = lane(map.mainL);
    float* mainR = lane(map.mainR);

    // This block's output becomes next block's "previous" for feedback edges.
    // Swapped BEFORE anything is written, so a feedback route reads the block
    // that actually happened rather than a half-updated one.
    for (uint32_t c = 0; c < kMaxChannels; ++c) {
        std::copy_n(outL_[c].data(), frames, prevL_[c].data());
        std::copy_n(outR_[c].data(), frames, prevR_[c].data());
        std::fill_n(inL_[c].data(), frames, 0.0f);
        std::fill_n(inR_[c].data(), frames, 0.0f);

        // THE MONITOR GATE for this block, materialised once per channel.
        // Advanced HERE and not inside pour() because a channel can be fed by
        // more than one device-input cable, and gliding a shared scalar per
        // route would run the ramp once per cable — two inputs would fade in at
        // twice the speed of one. See Channel::monitor.
        Channel& mc = channels_[c];
        const double tgtMon = mc.monitor.load(std::memory_order_relaxed) != 0 ? 1.0 : 0.0;
        float* mg = mon_[c].data();
        for (uint32_t i = 0; i < frames; ++i) {
            glide(mc.smMonitor, tgtMon, alpha);
            mg[i] = static_cast<float>(mc.smMonitor);
        }
    }

    /** Pour one route's source into its destination. ONE dispatch for every
        endpoint pair, so a new endpoint kind cannot be handled in one place and
        forgotten in another. `usePrev` selects the previous block, which is
        what makes a feedback edge a feedback edge. */
    const auto pour = [&](Route& rt, bool usePrev) {
        const uint32_t act = rt.active.load(std::memory_order_acquire);
        if (act == 0) return;
        const auto sk = static_cast<SourceEndpoint>(rt.srcKind.load(std::memory_order_relaxed));
        const auto dk = static_cast<DestEndpoint>(rt.dstKind.load(std::memory_order_relaxed));
        const uint32_t si = rt.srcIndex.load(std::memory_order_relaxed);
        const uint32_t ss = rt.srcSub.load(std::memory_order_relaxed);
        const uint32_t di = rt.dstIndex.load(std::memory_order_relaxed);

        // Resolve the source to a stereo pair plus an extra scalar (the send
        // level, for a send tap — which is what makes a send "post-fader at the
        // channel's send level" without duplicating the channel's mixing).
        const float* sL = nullptr;
        const float* sR = nullptr;
        double extra = 1.0;
        switch (sk) {
            case SourceEndpoint::channelOut:
                if (si >= kMaxChannels) return;
                sL = usePrev ? prevL_[si].data() : outL_[si].data();
                sR = usePrev ? prevR_[si].data() : outR_[si].data();
                break;
            case SourceEndpoint::channelSend:
                if (si >= kMaxChannels || ss >= kNumSends) return;
                sL = usePrev ? prevL_[si].data() : outL_[si].data();
                sR = usePrev ? prevR_[si].data() : outR_[si].data();
                extra = channels_[si].smSend[ss] < 0.0
                            ? channels_[si].send[ss].load(std::memory_order_relaxed)
                            : channels_[si].smSend[ss];
                break;
            case SourceEndpoint::deviceInput: {
                if (inBus == nullptr || si >= inCount || inBus[si] == nullptr) return;
                sL = inBus[si];
                sR = (ss < inCount && inBus[ss] != nullptr) ? inBus[ss] : inBus[si];
                break;
            }
            case SourceEndpoint::fxReturn: {
                if (si >= kNumSends) return;
                const uint32_t base = map.returnWet[si];
                if (base == kNoIndex) return;
                sL = lane(base);
                sR = lane(base + 1u);
                if (sL == nullptr || sR == nullptr) return;
                break;
            }
            case SourceEndpoint::deckOut: {
                // The core's dry per-deck output for THIS block (P3.5-E3). Never
                // `usePrev`: the deck was rendered before this bank ran, so it is
                // an external source like a device input — a feedback edge from
                // one cannot exist, because nothing downstream can reach a deck.
                if (deckOut == nullptr || si >= kMaxDeckOuts) return;
                const uint32_t l = si * 2u, r = l + 1u;
                if (r >= deckOutCount) return;
                sL = deckOut[l];
                sR = deckOut[r] != nullptr ? deckOut[r] : deckOut[l];
                if (sL == nullptr) return; // a host without deck taps: silence, not a crash
                break;
            }
        }

        // Resolve the destination.
        float* dLf = nullptr;
        float* dRf = nullptr;
        bool mono = false;
        // The destination strip's MONITOR curve, when this cable is that
        // strip's device input. Null for every other cable: MON is the strip's
        // own listening switch, not a second mute — a signal arriving from
        // another strip, an FX return or a send tap is not this strip's
        // monitoring and must be unaffected.
        const float* gate = nullptr;
        switch (dk) {
            case DestEndpoint::channelIn:
                if (di >= kMaxChannels) return;
                dLf = inL_[di].data();
                dRf = inR_[di].data();
                if (sk == SourceEndpoint::deviceInput) gate = mon_[di].data();
                break;
            case DestEndpoint::sendBus:
                if (di >= kNumSends) return;
                dLf = lane(map.send[di]);
                dRf = nullptr;
                mono = true; // the core's send buses are single lanes
                if (dLf == nullptr) return;
                break;
            case DestEndpoint::main:
                dLf = mainL;
                dRf = mainR;
                if (dLf == nullptr && dRf == nullptr) return;
                break;
        }

        const double tgt = act == 2u ? 0.0 : rt.gain.load(std::memory_order_relaxed);
        // Glide a LOCAL and write back once. One atomic load and one store per
        // route per block instead of two per SAMPLE — the atomicity is there to
        // make slot reuse well-defined (see Route::smGain), not to be read
        // sample-by-sample.
        double sm = rt.smGain.load(std::memory_order_relaxed);
        for (uint32_t i = 0; i < frames; ++i) {
            glide(sm, tgt, alpha);
            const double g = sm * extra * (gate != nullptr ? gate[i] : 1.0);
            if (mono) {
                dLf[i] += static_cast<float>(0.5 * (sL[i] + sR[i]) * g);
            } else {
                if (dLf != nullptr) dLf[i] += static_cast<float>(sL[i] * g);
                if (dRf != nullptr) dRf[i] += static_cast<float>(sR[i] * g);
            }
        }
        rt.smGain.store(sm, std::memory_order_relaxed);
        if (act == 2u && sm <= 0.0) rt.active.store(0u, std::memory_order_release);
    };

    // FEEDBACK edges and EXTERNAL sources are poured up front. Feedback edges
    // read the PREVIOUS block, so they do not care about the render order at
    // all — which is precisely what makes them the only edge allowed to close a
    // loop. External sources (a device input, an FX return wet) are simply
    // already present when the block starts.
    for (uint32_t r = 0; r < kMaxRoutes; ++r) {
        Route& rt = routes_[r];
        if (rt.active.load(std::memory_order_acquire) == 0) continue;
        const bool fb = rt.feedback.load(std::memory_order_relaxed) != 0;
        const bool external = rt.dependsOn() == kNoIndex;
        if (!fb && !external) continue; // an ordered edge; poured in the walk below
        pour(rt, fb);
    }

    // Now the ordered walk. Because the order puts every channel after
    // everything feeding it, a forward route can be gathered from the source's
    // CURRENT block — zero added latency, which is the entire point of sorting.
    // Read ONCE, before the walk: re-reading per slot would reintroduce exactly
    // the tearing the single atomic exists to prevent.
    const uint64_t order = orderPacked_.load(std::memory_order_acquire);
    for (uint32_t oi = 0; oi < kMaxChannels; ++oi) {
        const uint32_t c = unpackOrder(order, oi) % kMaxChannels;
        Channel& ch = channels_[c];
        float* dl = outL_[c].data();
        float* dr = outR_[c].data();

        const auto kind = static_cast<ChannelSourceKind>(ch.srcKind.load(std::memory_order_acquire));
        const uint32_t index = ch.srcIndex.load(std::memory_order_relaxed);

        // The channel's ELEMENT. A grid-deck channel contributes nothing here:
        // the core already summed that deck, and this channel's level/sends
        // were projected onto the core's own per-deck controls. Mixing it again
        // would be the double-gain bug this design exists to avoid.
        const float* elemL = nullptr;
        const float* elemR = nullptr;
        if (kind == ChannelSourceKind::tape) {
            elemL = tapes.outL(index);
            elemR = tapes.outR(index);
        }

        const double tgtLevel = ch.level.load(std::memory_order_relaxed);
        const double tgtMute = ch.mute.load(std::memory_order_relaxed) != 0 ? 0.0 : 1.0;
        double tgtSend[kNumSends];
        for (uint32_t s = 0; s < kNumSends; ++s)
            tgtSend[s] = ch.send[s].load(std::memory_order_relaxed);

        // Per-strip DRV (P3-X2), the core's own pre-sum deck stage mirrored one
        // tier over: engaged strictly above the 1.0 floor (bypass is a branch,
        // not a unity multiply — the bit-exact identity path survives), history
        // reset on ENGAGE so stale ADAA state cannot spike, params refreshed
        // per block. Decoupled topology with volume 1.0 and a 0 dBFS ceiling:
        // the channel's LEVEL is the clean output gain and it stays where it
        // is, applied AFTER the drive below — character constant while fading.
        const double driveAmt = ch.driveAmount.load(std::memory_order_relaxed);
        scoopyloops::NativeMasterDrive* drv = drive_[c].get();
        const bool driveEngaged = driveAmt > 1.0 && drv != nullptr;
        if (driveEngaged) {
            if (!driveActive_[c]) drv->reset();
            drv->setParameters(
                static_cast<scoopyloops::MasterDriveCurve>(
                    ch.driveCurve.load(std::memory_order_relaxed)),
                /*volume*/ 1.0f,
                /*threshold*/ 0.7f, /*softness*/ 0.4f,
                static_cast<float>(driveAmt),
                /*ceiling*/ 1.0f, /*oversample*/ 0, /*decoupled*/ true);
        }
        driveActive_[c] = driveEngaged;

        float* sendLane[kNumSends];
        for (uint32_t s = 0; s < kNumSends; ++s) sendLane[s] = lane(map.send[s]);

        const float* routedL = inL_[c].data();
        const float* routedR = inR_[c].data();

        // Block-local peak accumulators. Kept as locals and published ONCE
        // below rather than touched atomically per sample — the meter needs a
        // peak per 30 Hz frame, not per sample, and a per-sample RMW on a
        // shared cache line inside the hot loop would be the expensive way to
        // learn the same number.
        double pkL = 0.0;
        double pkR = 0.0;

        for (uint32_t i = 0; i < frames; ++i) {
            glide(ch.smLevel, tgtLevel, alpha);
            glide(ch.smMute, tgtMute, alpha);
            const double g = ch.smLevel * ch.smMute;
            // A strip hears its ELEMENT plus everything patched INTO it. That
            // sum is what "a strip can host a tape and take a live input" means
            // in the mixer, and it is why an input element needs no separate
            // code path — it is just a route with no element beside it.
            double inputL = (elemL != nullptr ? static_cast<double>(elemL[i]) : 0.0) +
                            static_cast<double>(routedL[i]);
            double inputR = (elemR != nullptr ? static_cast<double>(elemR[i]) : 0.0) +
                            static_cast<double>(routedR[i]);
            // The DRV tap point — POST-element (element + routed), PRE-level.
            // Only inside this branch does the sum narrow to float (the DSP's
            // sample type); the disengaged path keeps its double arithmetic
            // untouched, so bypass stays bit-exact rather than merely close.
            if (driveEngaged) {
                float fl = static_cast<float>(inputL);
                float fr = static_cast<float>(inputR);
                drv->processSample(fl, fr);
                inputL = static_cast<double>(fl);
                inputR = static_cast<double>(fr);
            }
            // Bounded HERE, where feedback loops close — see kChannelCeiling.
            const float l = boundSample(inputL * g);
            const float r = boundSample(inputR * g);
            // The channel's own output — this is the record tap. Post-level,
            // post-mute: exactly what this strip contributes to the mix, which
            // is what ROUTING-MATRIX settled the tap point to be.
            dl[i] = l;
            dr[i] = r;
            // Metered off the SAME bounded samples the record tap takes, so the
            // meter shows what the strip actually contributed — including the
            // fact that a muted strip contributes nothing and reads 0.
            const double al = std::abs(static_cast<double>(l));
            const double ar = std::abs(static_cast<double>(r));
            if (al > pkL) pkL = al;
            if (ar > pkR) pkR = ar;
            // The send LEVELS are glided here (the channel owns them), but
            // where each send GOES is a route — decision 5, "the channel owns
            // the level, the routing document owns the destination". So send 3
            // can feed another strip's input instead of an effect, without the
            // channel knowing or caring.
            for (uint32_t s = 0; s < kNumSends; ++s) glide(ch.smSend[s], tgtSend[s], alpha);
        }

        // Publish the block's peak: a CAS fetch-max, so a reader that reset to
        // 0 partway through cannot have its reset undone by a store computed
        // before it. See Channel::peakL.
        fetchMax(ch.peakL, pkL);
        fetchMax(ch.peakR, pkR);

        // ROUTES OUT of this channel — its output and its four send taps —
        // poured now that this channel's block is final. The render order
        // guarantees every channel destination is still ahead of us, which is
        // what buys the zero latency: the downstream strip reads this block,
        // not the last one. Main and the send buses are termini, so they can be
        // poured here too.
        for (uint32_t r = 0; r < kMaxRoutes; ++r) {
            Route& rt = routes_[r];
            if (rt.active.load(std::memory_order_acquire) == 0) continue;
            if (rt.feedback.load(std::memory_order_relaxed) != 0) continue;
            if (rt.dependsOn() != c) continue;
            pour(rt, false);
        }
    }
}

} // namespace sl
