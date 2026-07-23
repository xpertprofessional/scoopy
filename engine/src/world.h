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
    // Render-side smoother state (gain/pan one-pole, mute ramp position) is
    // owned by the render thread and lives here so it travels with the strip.
    double smGainL = 0.0, smGainR = 0.0; // P1-04
    double muteRamp = 1.0;               // P1-04 (1 = open)
};

struct World {
    // unique_ptr because ChannelParams holds atomics (non-copyable/movable).
    std::vector<std::unique_ptr<ChannelState>> channels;
    uint64_t revision = 0;
};

} // namespace wz
