// Engine lane order → plugin bus channel pointers.
//
// `sl_render_io` copies min(bus_count, 26) lanes in the FIXED order of the
// core's AudioLane enum (NativeAudioEngineCore.hpp) — so multi-out is nothing
// but a pointer permutation built per block: mapped lanes point into the
// host's bus buffers, unmapped lanes into per-instance scratch. Zero engine
// change, exactly as SL-ABI-V3 intended ("a multi-out device gets the lanes
// the host maps" — this is the host, doing the mapping the app never did).
//
// The bus layout is declared once here and consumed by both the processor's
// BusesProperties and this map, so they cannot drift apart.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <cstdint>
#include <vector>

namespace wizard::plugin {

/** The core's lane order. MUST match AudioLane in NativeAudioEngineCore.hpp —
    a drift here routes the wrong signal to a named output, silently. */
enum Lane : uint32_t {
    laneMainL = 0, laneMainR,
    laneSend1, laneSend2, laneSend3, laneSend4, // MONO lanes
    laneCueL, laneCueR,
    laneDeckL, laneDeckR,          // summed DJ deck bus (legacy pair)
    laneDeckA_L, laneDeckA_R,      // per-deck post-stretch stereo — OUR deck (0)
    laneDeckB_L, laneDeckB_R,
    laneDeckC_L, laneDeckC_R,
    laneReturn1L, laneReturn1R, laneReturn2L, laneReturn2R,
    laneReturn3L, laneReturn3R, laneReturn4L, laneReturn4R,
    laneMicDryL, laneMicDryR,
    laneCount // 26
};

/** One plugin output bus: its name, the lanes that feed it, and whether the
    ENGINE side is a stereo pair or a single mono lane. `monoLane` buses are
    still presented to the host as stereo — see kOutputBuses. */
struct BusSpec {
    const char* name;
    bool monoLane; // engine has ONE lane for this bus; duplicate it L=R
    Lane firstLane; // stereo lanes take firstLane / firstLane+1
};

/** Output bus order as declared to the host.
 *
 * ⚠️ EVERY BUS IS STEREO TO THE HOST, including the four sends, whose engine
 * lanes are mono. The sends were declared mono first (it is what the engine
 * actually has) and LOGIC WOULD NOT INSTANTIATE THE MULTI-OUTPUT VARIANT AT
 * ALL — the plugin window came up entirely empty, with no error anywhere,
 * because a multi-output AU instrument is expected to be a main pair plus
 * stereo auxes and a mono aux is outside what the host will lay out.
 *
 * So the mono lane is duplicated into both channels at the end of the block
 * (LaneMap::finish). The alternative — being "honest" about mono and shipping
 * a plugin whose multi-out mode does not load — is not honesty anyone can use.
 * Reported by the user in Logic, 2026-08-01.
 */
inline constexpr BusSpec kOutputBuses[] = {
    {"Main", false, laneMainL},
    {"Deck", false, laneDeckA_L},
    {"Cue", false, laneCueL},
    {"Send 1", true, laneSend1},
    {"Send 2", true, laneSend2},
    {"Send 3", true, laneSend3},
    {"Send 4", true, laneSend4},
    {"Return 1", false, laneReturn1L},
    {"Return 2", false, laneReturn2L},
    {"Return 3", false, laneReturn3L},
    {"Return 4", false, laneReturn4L},
};
inline constexpr int kNumOutputBuses = (int) std::size(kOutputBuses);

class LaneMap {
public:
    /** Allocate the scratch the unmapped lanes render into. `engineBlock` is
        the engine's max render block — the chunk loop offsets MAPPED pointers
        through the host buffer but reuses scratch per chunk, so scratch only
        ever needs one engine block. Message thread (prepareToPlay). */
    void prepare(uint32_t engineBlock);

    /** Build the 26-lane pointer array for one CHUNK. Mapped lanes point at
        the enabled buses' channels offset by `chunkOffset`; disabled buses and
        unmapped lanes point at scratch. RT-safe, no allocation. */
    float* const* build(juce::AudioProcessor& proc, juce::AudioBuffer<float>& buffer,
                        int chunkOffset) noexcept;

    /** Call AFTER the render: copies each mono-lane bus's left channel into its
        right, so a send presented to the host as stereo is not silent on one
        side. Separate from build() because the engine writes between them. */
    void finish(juce::AudioProcessor& proc, juce::AudioBuffer<float>& buffer,
                int chunkOffset, int frames) noexcept;

private:
    std::array<float*, laneCount> ptrs{};
    std::vector<float> scratch; // laneCount × engineBlock, contiguous
    uint32_t scratchBlock = 0;
};

} // namespace wizard::plugin
