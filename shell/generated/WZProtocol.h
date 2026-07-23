// GENERATED — do not edit. Source: web/protocol/schema.ts
// Regenerate with: cd web && npm run protocol:generate
#pragma once
#include <cstdint>

namespace wz::protocol {

inline constexpr std::int32_t kSchemaVersion = 6;

// ParamWrite atomics. JS resolves ids BY NAME at boot (never hardcodes
// integers); this enum is for the C++ side only.
enum class ParamId : std::uint32_t {
    mainGain = 0,
    gain = 1,
    pan = 2,
    mute = 3,
    solo = 4,
};
inline constexpr std::uint32_t kParamIdCount = 5;
inline constexpr const char* kParamIdNames[] = {
    "mainGain",
    "gain",
    "pan",
    "mute",
    "solo",
};

// HotFrame Float64 index map: scalars, then per-CHANNEL blocks, then
// per-DECK blocks (docs/specs/routing.md §8). Offsets are derived from
// these strides on both sides — never hand-computed.
namespace hotframe {
inline constexpr std::uint32_t k_schemaVersion = 0;
inline constexpr std::uint32_t k_engineTimeSamples = 1;
inline constexpr std::uint32_t k_cpuLoad = 2;
inline constexpr std::uint32_t k_feedbackAlarm = 3;
inline constexpr std::uint32_t k_mainPeakL = 4;
inline constexpr std::uint32_t k_mainPeakR = 5;
inline constexpr std::uint32_t k_monitorPeakL = 6;
inline constexpr std::uint32_t k_monitorPeakR = 7;
inline constexpr std::uint32_t kScalarCount = 8;
// kFrameLength is the SCALAR section only; the full frame is
// kScalarCount + nChannels*channel_block::kStride + nDecks*deck_block::kStride.
inline constexpr std::uint32_t kFrameLength = 8;
namespace channel_block {
inline constexpr std::uint32_t k_peakL = 0;
inline constexpr std::uint32_t k_peakR = 1;
inline constexpr std::uint32_t k_rmsL = 2;
inline constexpr std::uint32_t k_rmsR = 3;
inline constexpr std::uint32_t k_srcRingFill = 4;
inline constexpr std::uint32_t k_srcDriftPpm = 5;
inline constexpr std::uint32_t k_srcDropouts = 6;
inline constexpr std::uint32_t kStride = 7;
} // namespace channel_block
namespace deck_block {
inline constexpr std::uint32_t k_state = 0;
inline constexpr std::uint32_t k_playhead = 1;
inline constexpr std::uint32_t k_loopStart = 2;
inline constexpr std::uint32_t k_loopEnd = 3;
inline constexpr std::uint32_t k_rate = 4;
inline constexpr std::uint32_t k_recordLengthSamples = 5;
inline constexpr std::uint32_t k_recordDrainFill = 6;
inline constexpr std::uint32_t kStride = 7;
} // namespace deck_block
} // namespace hotframe

// Command method names (JSON-RPC style).
inline constexpr const char* kMethodNames[] = {
    "ping",
    "getCapabilities",
    "getDeviceInfo",
    "publishWorld",
    "deckLoadFile",
    "deckTrigger",
    "deckSetLoop",
};
inline constexpr std::uint32_t kMethodCount = 7;

} // namespace wz::protocol
