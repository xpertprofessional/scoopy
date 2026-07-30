// The uniform strip CHANNEL — STRIP-MODEL.md's "identical for every strip,
// whatever it hosts": level · 4 FX sends · output · record-arm.
//
// THE LOAD-BEARING FINDING, and why this is a projection rather than a mixer.
//
// A grid deck ALREADY HAS a channel, inside scoopy's core: `crossfaderGain` and
// `deckGain` are its level, `setDeckMasterSend(deck, n, level)` are its four
// sends, `deckMasterDrive_[deck]` is its drive. A tape has NONE of that — the
// transplant gave it a buffer and a playhead, and until now it summed into main
// at unity with no fader at all.
//
// So "one uniform channel" cannot mean "one new gain stage in front of
// everything": putting one in front of a grid deck would multiply a gain the
// core already applied, which is a double-gain bug that sounds like nothing at
// all until someone moves a fader and the wrong amount happens. It means ONE
// SURFACE with TWO BACKINGS:
//
//   tape source      → this tier owns the whole channel and does the work here
//   grid-deck source → the channel PROJECTS onto the core's existing per-deck
//                      controls (live setters, no republish), so there is
//                      exactly one gain stage and the core stays the authority
//
// That is the merge's stated posture — "the merge adds a channel + plane around
// them, it does not reduce either" — made literal: identical ABI for every
// strip, backed by whichever engine actually owns that source.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

// P3-X2: the per-strip DRV stage reuses the core's own drive DSP — the
// stretcher's reuse pattern, one tier over. Forward-declared (like sl_tape.h's
// NativeBusStretcher) so this header stays free of the core's headers.
namespace scoopyloops { struct NativeMasterDrive; }

namespace sl {

class TapeBank;

inline constexpr uint32_t kMaxChannels = 8;
inline constexpr uint32_t kNumSends = 4;
// Room for the default wiring (one output route per channel + one per send,
// installed at configure) plus a generous amount of user patching on top.
inline constexpr uint32_t kMaxRoutes = 128;
inline constexpr uint32_t kNoIndex = 0xFFFFFFFFu;

/** What a channel is carrying. `none` is a real, useful state — a strip starts
    EMPTY and grows elements on demand (STRIP-MODEL), so a channel with no
    source is the normal resting state of a fresh strip, not an error. */
enum class ChannelSourceKind : uint32_t {
    none = 0,
    tape = 1,     // a merged-tier tape: this tier owns the gain stage
    gridDeck = 2, // a scoopy session: the core owns the gain stage, we project
};

/** Where the output lanes live, supplied by the caller.

    Passed in rather than looked up so this translation unit stays free of the
    core's headers — the same property that made the tape transplant a lift
    instead of an extraction, and worth keeping deliberately.

    Note each send is ONE lane, not a stereo pair: the core's send buses are
    mono (AudioLane::send1..send4 are four consecutive single lanes), so a
    stereo channel folds to mono on its way into a send. Assuming pairs here
    would have written channel 1's right side into channel 2's send bus. */
struct LaneMap {
    uint32_t mainL = 0;
    uint32_t mainR = 1;
    uint32_t send[4] = {2, 3, 4, 5};
    // The FX return WET lanes, as stereo pairs — the source side of a
    // return→strip patch, which is the resampling/feedback want ROUTING-MATRIX
    // calls first-class. Filled by the caller from the core's lane enum.
    uint32_t returnWet[4] = {kNoIndex, kNoIndex, kNoIndex, kNoIndex};
};

/** What a cable is plugged INTO at the source end. */
enum class SourceEndpoint : uint32_t {
    channelOut = 0,  // index = channel. Its post-level, post-mute output.
    channelSend = 1, // index = channel, sub = send 0..3. Output × that send's level.
    deviceInput = 2, // index = input channel (L), sub = input channel (R) or kNoIndex.
    fxReturn = 3,    // index = return 0..3. The core's wet lane for that return.
};

/** ...and at the destination end. */
enum class DestEndpoint : uint32_t {
    channelIn = 0, // index = channel. Sums into what that strip hears.
    sendBus = 1,   // index = 0..3. The FX send bus.
    main = 2,      // the main output pair.
};

/** One patch cable: `src` channel's output into `dst` channel's input, at
    `gain`.

    THE SCHEDULING DECISION (ROUTING-MATRIX.md, amended 2026-07-25) lives in the
    `feedback` flag, and it is the whole reason this is not just a list:

      feedback = 0 — TAP BY ORDER. The render visits channels in dependency
        order, so `dst` reads `src`'s CURRENT block. Zero added latency. A route
        that would close a cycle is REFUSED at edit time.

      feedback = 1 — TAP BY DELAY. `dst` reads `src`'s PREVIOUS block, so the
        cycle is broken by the block boundary. Costs exactly one block
        (~10.7 ms at 512/48k) and is the only edge allowed to close a loop.

    The rejected alternative was to make every route one-block-delayed, which
    needs no scheduler at all. It was rejected because with strip→strip chaining
    — an explicit want — per-hop delay ACCUMULATES, and two parallel paths of
    different depth then comb-filter: not an error, nothing warns, it just
    sounds hollow. That is the failure `docs/specs/pd-modular-routing.md` §1.3
    calls the one that will actually burn a user. */
struct Route {
    std::atomic<uint32_t> active{0}; // 0 free · 1 live · 2 ramping out
    std::atomic<uint32_t> srcKind{0};
    std::atomic<uint32_t> srcIndex{0};
    std::atomic<uint32_t> srcSub{kNoIndex};
    std::atomic<uint32_t> dstKind{0};
    std::atomic<uint32_t> dstIndex{0};
    std::atomic<uint32_t> feedback{0};
    std::atomic<double> gain{1.0};
    std::atomic<uint32_t> isDefault{0}; // installed by configure, not by a user

    /** The ramp position. ATOMIC, even though the render owns it in spirit.
        `clearRoutes()` frees every slot immediately (a document load wipes the
        patch), so a slot can be re-filled by the control thread while the
        render is still inside pour() gliding this very field — the acquire /
        release handshake on `active` cannot help, because clearRoutes
        deliberately breaks it. A plain double there is a data race, and
        ThreadSanitizer reports it on exactly that path.

        Relaxed ordering is enough: nothing is published THROUGH this value, and
        the worst interleaving leaves a freshly-patched cable one block off its
        intended ramp position, which then glides to the right place anyway.
        It costs nothing per sample — pour() loads it once, glides a LOCAL, and
        stores once (see the comment there). */
    std::atomic<double> smGain{-1.0}; // negative = seed from target

    /** The channel this route DEPENDS ON, or kNoIndex. Only channel-sourced
        routes constrain the render order — a device input or an FX return is
        already there when the block starts, so it orders nothing. */
    uint32_t dependsOn() const {
        const auto k = static_cast<SourceEndpoint>(srcKind.load(std::memory_order_relaxed));
        if (k == SourceEndpoint::channelOut || k == SourceEndpoint::channelSend)
            return srcIndex.load(std::memory_order_relaxed);
        return kNoIndex;
    }
    /** The channel this route FEEDS, or kNoIndex (a send bus or main is a
        terminus — nothing downstream reads it, so it ends the dependency). */
    uint32_t feeds() const {
        if (static_cast<DestEndpoint>(dstKind.load(std::memory_order_relaxed)) ==
            DestEndpoint::channelIn)
            return dstIndex.load(std::memory_order_relaxed);
        return kNoIndex;
    }
};

/** One strip's channel. Levels are control-thread writes read once per block by
    the render, then glided — never stepped, per D-WZ-RAMP-01. */
struct Channel {
    std::atomic<uint32_t> srcKind{static_cast<uint32_t>(ChannelSourceKind::none)};
    std::atomic<uint32_t> srcIndex{0};

    std::atomic<double> level{1.0};
    std::atomic<double> send[kNumSends];
    std::atomic<uint32_t> mute{0};

    /** Per-strip DRV (P3-X2) — STRIP-MODEL: "reaches every strip, not just full
        decks". Curve 0 soft / 1 tanh / 2 hard / 3 fold (MasterDriveCurve);
        amount is the always-on input gain into a fixed 0 dBFS ceiling, floored
        at 1.0 = OFF (the deck stage's own convention: bypassed at DRV == 1.0
        for a bit-identical pass-through).

        Applied at the STRIP-MODEL tap point — post-element (element + routed
        input), PRE-level — so character stays constant while fading, exactly
        like the core's per-deck stage runs pre-crossfader.

        ⚠️ A GRID-DECK channel's drive is NOT this field: the core already owns
        that deck's drive (deckMasterDrive_, fed by the session document's
        masterClipper block — the no-double-gain rule, same as level/sends).
        This stage still shapes whatever is ROUTED INTO a grid strip's channel,
        which is the only audio this tier carries for it. */
    std::atomic<uint32_t> driveCurve{0};
    std::atomic<double> driveAmount{1.0};

    /** THE MONITOR SWITCH — whether this strip's DEVICE INPUT reaches the
        channel. Default 0, and that default is the fix for a real bug.

        THE COLLISION IT RESOLVES. STRIP-MODEL's closing argument is that
        recording is always "capture this strip's channel bus" — one tap, one
        code path, every source. But a live input is modelled as a route INTO the
        channel, so monitoring and recording shared one path: silencing the input
        to stop a feedback loop also made REC capture silence, and `mute` (which
        is the channel OUTPUT) silenced the tape along with it. Record-without-
        hearing was impossible by construction, and a strip arrived with a mic
        permanently patched and no way to turn it off.

        So the tap is SPLIT. The input still reaches REC directly (a `deviceInput`
        record source is captured before anything renders — TapeBank phase 2),
        while this gate decides whether it also reaches the channel:

            input ──┬─▶ REC                     always captured
                    └─▶ [monitor] ─▶ channel ─▶ main

        It gates ONLY `deviceInput → channelIn` pours. A cable from another
        strip, an FX return or a send tap is not this strip's monitoring and is
        untouched — otherwise MON would be a second mute with a different name.
        The cable itself keeps its gain and stays visible in the ledger: the
        monitor is a property of the STRIP, not of the patch.

        Costs the purity of "one tap" for input strips specifically, and buys the
        normal studio case plus a way to kill feedback that does not kill the
        take. D-WZ-MON-01/02 are honoured by the ENGINE (sl_engine.cpp's render):
        record-start opens it, the Law C-3 handoff closes it in the SAME block,
        overdub keeps it open. Doing that close on the message thread off a
        record-stop reply would land a frame or two late and flam the input over
        the loop at the exact moment the ear is listening for the loop. */
    std::atomic<uint32_t> monitor{0};

    /** Peak magnitude of this channel's OUTPUT since the last read — the strip
        meter's source, and the only thing the plane's UI reads at frame rate
        that the document does not already know.

        CONSUME-AND-RESET, mirroring the core's own consumeOutputPeak, so the
        30 Hz frame reports "peak since the previous frame" rather than a decayed
        or instantaneous value. Written once per BLOCK by the render (a local max
        over the sample loop, then one CAS), not once per sample, so the atomic
        traffic does not scale with the block size.

        The CAS matters and a plain store would be wrong: the reader exchanges
        this to 0, so a render that loaded before the reset and stored after it
        would resurrect a peak the UI had already consumed — a meter that
        latches high and never falls. compare_exchange re-reads on failure, so
        the reset always wins the race it is supposed to win. */
    std::atomic<double> peakL{0.0};
    std::atomic<double> peakR{0.0};

    // Render-owned smoothed state; negative = "seed from target on first block"
    // so a channel does not fade in from silence the first time it is heard.
    double smLevel = -1.0;
    double smSend[kNumSends] = {-1.0, -1.0, -1.0, -1.0};
    double smMute = -1.0;
    double smMonitor = -1.0;

    Channel() {
        for (auto& s : send) s.store(0.0, std::memory_order_relaxed);
    }
};

/** The bank of channels, plus the per-channel output scratch that IS the record
    tap (STRIP-MODEL: "recording is always capture this strip's channel bus —
    one tap, one code path, every source"). */
class ChannelBank {
public:
    void configure(double sampleRate, uint32_t maxBlockFrames);

    static constexpr uint32_t count() { return kMaxChannels; }

    // --- control surface (message thread), all range-checked ----------------
    int32_t setSource(uint32_t ch, uint32_t kind, uint32_t index);
    uint32_t sourceKind(uint32_t ch) const;
    uint32_t sourceIndex(uint32_t ch) const;
    void setLevel(uint32_t ch, double level);
    double level(uint32_t ch) const;
    void setSend(uint32_t ch, uint32_t send, double level);
    double sendLevel(uint32_t ch, uint32_t send) const;
    void setMute(uint32_t ch, uint32_t muted);
    uint32_t muted(uint32_t ch) const;
    /** The monitor switch (see Channel::monitor). Ramped like every other gain,
        so flipping it mid-performance is a 10 ms fade rather than a click. */
    void setMonitor(uint32_t ch, uint32_t on);
    uint32_t monitorOn(uint32_t ch) const;
    /** Per-strip DRV (see Channel::driveCurve/driveAmount). An unknown curve id
        keeps the old curve — a wrong curve would pick DSP the user never chose
        (the deck-scope guard's own reasoning); amount is clamped to [1, 32],
        the MasterRow's range, 1 = off. */
    void setDrive(uint32_t ch, uint32_t curve, double amount);
    uint32_t driveCurve(uint32_t ch) const;
    double driveAmount(uint32_t ch) const;

    /** Read AND RESET this channel's output peak (see Channel::peakL). 0 for an
        out-of-range channel.

        ⚠️ A GRID-DECK channel reads 0, and that is not a bug at this tier: the
        core already summed that deck and this bank deliberately mixes nothing
        for it (the projection, not a second mixer). A grid strip's meter must
        therefore be fed from the core's own per-deck telemetry, not from here.
        Written down because the natural assumption — "every channel has a
        meter" — is true of the SURFACE and false of the BACKING. */
    double consumePeakL(uint32_t ch);
    double consumePeakR(uint32_t ch);

    /** Which channel, if any, carries `tape` — so a tape's record tap can find
        its own channel bus. -1 if no channel is bound to it. */
    int32_t channelForTape(uint32_t tape) const;

    // --- routing (control thread) -------------------------------------------

    /** Patch `src`'s output into `dst`'s input. Returns a route id, or -1.
        REFUSED when: either channel is out of range; src == dst; no free slot;
        or — the load-bearing case — the route would close a cycle and
        `feedback` is 0. A caller that genuinely wants the loop asks for it
        explicitly by passing feedback = 1, which is then honoured with a
        one-block delay. Refusing silently-created cycles while allowing
        consented ones is exactly the G2 guard pd-modular-routing §5 asks for. */
    int32_t addRoute(uint32_t srcKind, uint32_t srcIndex, uint32_t srcSub,
                     uint32_t dstKind, uint32_t dstIndex, double gain, uint32_t feedback);
    /** The common case, kept as a one-liner: channel output → channel input. */
    int32_t addRoute(uint32_t src, uint32_t dst, double gain, uint32_t feedback);
    /** Drop every route including the defaults — what a document load calls
        before installing its own wiring, so a loaded patch is exactly what was
        saved rather than the saved patch layered on top of the defaults. */
    void clearRoutes();
    /** Re-install the default wiring: every channel out → main, and every
        send → its matching FX bus. This is what a fresh engine boots with, so
        a strip is audible and its sends reach their effects without ceremony —
        a mixer whose channel 1 is wired to jack 1. */
    void installDefaultRoutes();
    uint32_t routeCountActive() const;
    /** Remove a route. Its gain is NOT ramped out here — the render ramps it
        down and only then drops it, so unpatching a live cable is a crossfade
        rather than a click. Returns 1 if the id was live. */
    int32_t removeRoute(uint32_t id);
    void setRouteGain(uint32_t id, double gain);
    double routeGain(uint32_t id) const;
    uint32_t routeActive(uint32_t id) const;
    // Introspection. A patchbay you can only write to is not a patchbay: the
    // matrix has to draw the cables that exist, and a document has to be able
    // to save what it finds rather than only what it remembers issuing.
    uint32_t routeSourceKind(uint32_t id) const;
    uint32_t routeSourceIndex(uint32_t id) const;
    uint32_t routeSourceSub(uint32_t id) const;
    uint32_t routeDestKind(uint32_t id) const;
    uint32_t routeDestIndex(uint32_t id) const;
    uint32_t routeFeedback(uint32_t id) const;
    uint32_t routeIsDefault(uint32_t id) const;
    static constexpr uint32_t routeCapacity() { return kMaxRoutes; }
    /** True if `dst` is reachable from `src` over non-feedback routes — the
        cycle test, exposed so a document layer can pre-flight an edit and
        explain the refusal rather than just failing. */
    bool reaches(uint32_t src, uint32_t dst) const;
    /** The render order: channels sorted so every channel comes after everything
        feeding it. `out` receives count() entries. */
    void renderOrder(uint32_t* out) const;

    // --- render (audio thread) ----------------------------------------------
    /** Mix every TAPE-sourced channel into the output lanes: level and mute
        glided on the 10 ms constant, dry into main, and into each send lane at
        that send's level. Grid-deck channels contribute NOTHING here — the core
        already summed them, and their channel controls were projected onto it.

        Each channel's post-level output is also kept in its own scratch, which
        is what a `channelBus` record source captures. */
    void mixInto(float* const* lanes, uint32_t laneCount, uint32_t frames,
                 const TapeBank& tapes, double sampleRate, const LaneMap& map,
                 const float* const* inBus, uint32_t inCount);

    /** A channel's post-everything output for this block (the record tap), or
        nullptr if the channel index is out of range. */
    const float* outL(uint32_t ch) const;
    const float* outR(uint32_t ch) const;

private:
    /** Recompute the render order over the currently-active non-feedback
        routes (Kahn). Control thread; the render reads the published copy. */
    void rebuildOrder();

    /** The one place a route slot is filled in.

        `instant` starts the gain ramp AT its target instead of at zero (the
        boot wiring should not fade in), and `markDefault` tags it as boot
        wiring. Both are parameters rather than something the caller pokes in
        afterwards, because every field must be written BEFORE `active` is
        published: `active.store(release)` paired with the render's
        `active.load(acquire)` is what hands the slot over safely. Writing
        `smGain` after that store is a plain data race against the render
        already gliding it — which is what installDefaultRoutes used to do, and
        ThreadSanitizer duly reported it on the document-load path. */
    int32_t addRouteInternal(uint32_t srcKind, uint32_t srcIndex, uint32_t srcSub,
                             uint32_t dstKind, uint32_t dstIndex, double gain,
                             uint32_t feedback, bool instant, bool markDefault);

    Channel channels_[kMaxChannels];
    /** The DRV DSP, one instance per channel — NativeMasterDrive is stateful
        (ADAA history per side), so sharing one would smear one strip's chord
        slope into another's. Heap-held behind the forward declaration, the
        sl_tape.h stretcher pattern; created at configure(). */
    std::unique_ptr<scoopyloops::NativeMasterDrive> drive_[kMaxChannels];
    /** Was channel c's drive engaged last block? Render-owned. Engage resets
        the ADAA/oversampler history so stale state cannot spike (the core's
        deckMasterDriveActive_ discipline, mirrored). */
    bool driveActive_[kMaxChannels] = {};
    std::vector<float> outL_[kMaxChannels];
    std::vector<float> outR_[kMaxChannels];
    // The PREVIOUS block of each channel's output, kept only so a feedback edge
    // has something well-defined to read. This is the one buffer the whole
    // "delay is opt-in" design costs.
    std::vector<float> prevL_[kMaxChannels];
    std::vector<float> prevR_[kMaxChannels];
    // Per-channel summed routed input for this block, gathered before the
    // channel is processed (which is what the render order guarantees).
    std::vector<float> inL_[kMaxChannels];
    std::vector<float> inR_[kMaxChannels];
    /** The monitor gate's per-sample gain for this block, one curve per channel.
        Materialised ONCE at the top of the block rather than glided inside
        pour(): a channel can be fed by more than one device-input cable, and
        gliding a shared scalar per route would advance the ramp once per cable —
        so two inputs would fade in at twice the speed of one, which is a
        difference you can hear and nothing would explain. */
    std::vector<float> mon_[kMaxChannels];

    Route routes_[kMaxRoutes];

    /** The published render order, PACKED INTO ONE ATOMIC — 8 channels × 4 bits.
        Written by rebuildOrder on the control thread, read once per block by
        the render.

        It has to be a single atomic, not an array of eight. A stale order is
        harmless (it is still a valid permutation, just not the newest one), and
        an earlier version of this code reasoned from that to "no seqlock
        needed" — but that argument only covers staleness. Eight separate
        stores can be read half-old and half-new, and a TORN order is not a
        permutation at all: it can name one channel twice and omit another. The
        duplicate renders twice and sums into main twice (double level, and its
        routes poured twice); the omitted one keeps last block's output and
        never pours its routes at all. Intermittent, patch-dependent, and
        exactly the kind of fault nobody can reproduce on request.
        One 32-bit payload in a 64-bit atomic makes tearing impossible. */
    std::atomic<uint64_t> orderPacked_{0};

    static constexpr uint64_t packOrder(const uint32_t* order) {
        uint64_t p = 0;
        for (uint32_t i = 0; i < kMaxChannels; ++i)
            p |= static_cast<uint64_t>(order[i] & 0xFu) << (4u * i);
        return p;
    }
    static constexpr uint32_t unpackOrder(uint64_t p, uint32_t slot) {
        return static_cast<uint32_t>((p >> (4u * slot)) & 0xFu);
    }
};

} // namespace sl
