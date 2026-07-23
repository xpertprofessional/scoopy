// Engine-internal world model (docs/specs/routing.md, ARCHITECTURE §2).
// A World is an immutable-topology snapshot: channels + their source bindings.
// Per-channel PARAMS are atomics inside the snapshot — RT-writable without
// touching topology. Built on the control thread, installed by one atomic
// pointer swap (RCU); retired snapshots are freed on a later commit once the
// render thread has moved past them.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace wz {

// Matches web/protocol/schema.ts SourceKindSchema order — the boundary carries
// the numeric value, both sides derive names from the schema.
enum class SourceKind : int32_t {
    none = 0,
    deviceInput = 1,
    deck = 2,
    appTap = 3,
    systemMixExcept = 4,
    virtualDeviceInput = 5,
    busTap = 6,
};

struct ChannelParams {
    std::atomic<double> gain{0.75}; // fader position (unity detent, D-WZ-FADER-01)
    std::atomic<double> pan{0.0};
    std::atomic<double> mute{0.0}; // 0/1 — ramped in the render path (D-WZ-RAMP-01)
    std::atomic<double> solo{0.0};
};

struct ChannelState {
    std::string key; // stable document identity
    SourceKind srcKind = SourceKind::none;
    int32_t srcChan0 = -1; // deviceInput: device input channel L (or mono)
    int32_t srcChan1 = -1; // deviceInput: device input channel R (-1 = mono)
    int32_t deckIndex = -1; // srcKind==deck: which deck unit feeds this strip
    bool toMonitor = false; // cue assign (main is always fed)
    ChannelParams params;
    // Render-side smoother state — owned by the render thread; lives here so
    // it travels with the strip. Fresh worlds start strips at their targets
    // (no fade-in on publish; a publish is a document swap, not a gesture).
    double smGainL = -1.0, smGainR = -1.0; // -1 = seed from target on first block
    double muteRamp = -1.0;                // ramp position 0..1 (1 = open); -1 = seed
    double soloRamp = 1.0;                 // main-bus-only duck (in-place solo)
    // Per-strip meters (post-fader/mute, pre-solo), published per block for
    // HotFrame. Written on the render thread, read on the UI timer thread.
    std::atomic<double> mPeakL{0.0}, mPeakR{0.0};
    std::atomic<double> mRmsL{0.0}, mRmsR{0.0};
};

struct World {
    // unique_ptr because ChannelParams holds atomics (non-copyable/movable).
    std::vector<std::unique_ptr<ChannelState>> channels;
    // How many deck HotFrame blocks publish (1-8, a world property). The deck
    // UNITS live in the engine and survive commits.
    uint32_t deckCount = 0;
    uint64_t revision = 0;
};

} // namespace wz
