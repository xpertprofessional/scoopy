// GENERATED — do not edit. Source: web/protocol/schema.ts
// Regenerate with: cd web && npm run protocol:generate
#pragma once
#include <cstdint>

namespace wz::protocol {

inline constexpr std::int32_t kSchemaVersion = 2;

// ParamWrite atomics. JS resolves ids BY NAME at boot (never hardcodes
// integers); this enum is for the C++ side only.
enum class ParamId : std::uint32_t {
    mainGain = 0,
};
inline constexpr std::uint32_t kParamIdCount = 1;
inline constexpr const char* kParamIdNames[] = {
    "mainGain",
};

// HotFrame Float64 index map.
namespace hotframe {
inline constexpr std::uint32_t k_schemaVersion = 0;
inline constexpr std::uint32_t k_engineTimeSamples = 1;
inline constexpr std::uint32_t k_cpuLoad = 2;
inline constexpr std::uint32_t k_feedbackAlarm = 3;
inline constexpr std::uint32_t k_mainPeakL = 4;
inline constexpr std::uint32_t k_mainPeakR = 5;
inline constexpr std::uint32_t k_monitorPeakL = 6;
inline constexpr std::uint32_t k_monitorPeakR = 7;
inline constexpr std::uint32_t kFrameLength = 8;
} // namespace hotframe

// Command method names (JSON-RPC style).
inline constexpr const char* kMethodNames[] = {
    "ping",
    "getCapabilities",
    "setTestTone",
};
inline constexpr std::uint32_t kMethodCount = 3;

} // namespace wz::protocol
