#include "LaneMap.h"

namespace wizard::plugin {

void LaneMap::prepare(uint32_t engineBlock) {
    scratchBlock = engineBlock;
    scratch.assign((size_t) laneCount * engineBlock, 0.0f);
}

float* const* LaneMap::build(juce::AudioProcessor& proc, juce::AudioBuffer<float>& buffer,
                             int chunkOffset) noexcept {
    // Default every lane to its scratch strip; mapping below overrides.
    for (uint32_t lane = 0; lane < laneCount; ++lane)
        ptrs[lane] = scratch.data() + (size_t) lane * scratchBlock;

    for (int bus = 0; bus < kNumOutputBuses && bus < proc.getBusCount(false); ++bus) {
        const auto* b = proc.getBus(false, bus);
        if (b == nullptr || !b->isEnabled()) continue;
        auto view = proc.getBusBuffer(buffer, false, bus);
        const auto& spec = kOutputBuses[bus];
        // A mono-lane bus takes ONE engine lane into channel 0; finish()
        // duplicates it into channel 1 once the engine has written it.
        const int want = spec.monoLane ? 1 : 2;
        for (int ch = 0; ch < want && ch < view.getNumChannels(); ++ch)
            ptrs[(uint32_t) spec.firstLane + (uint32_t) ch] =
                view.getWritePointer(ch) + chunkOffset;
    }
    return ptrs.data();
}

void LaneMap::finish(juce::AudioProcessor& proc, juce::AudioBuffer<float>& buffer,
                     int chunkOffset, int frames) noexcept {
    for (int bus = 0; bus < kNumOutputBuses && bus < proc.getBusCount(false); ++bus) {
        const auto& spec = kOutputBuses[bus];
        if (!spec.monoLane) continue;
        const auto* b = proc.getBus(false, bus);
        if (b == nullptr || !b->isEnabled()) continue;
        auto view = proc.getBusBuffer(buffer, false, bus);
        if (view.getNumChannels() < 2) continue; // genuinely mono host layout — nothing to mirror
        std::memcpy(view.getWritePointer(1) + chunkOffset,
                    view.getReadPointer(0) + chunkOffset,
                    (size_t) frames * sizeof(float));
    }
}

} // namespace wizard::plugin
