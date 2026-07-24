#include "RenderSink.h"

#include <algorithm>
#include <array>

namespace wizard::host {

void renderChunked(RenderSink& sink,
                   const float* const* input, int numInputChannels,
                   float* const* output, int numOutputChannels,
                   int numSamples) noexcept {
    if (numOutputChannels <= 0 || numSamples <= 0 || output == nullptr) return;

    const auto maxBlock = static_cast<int>(sink.maxBlockFrames());
    if (maxBlock <= 0) {
        // Silence, not passthrough: the device buffer holds whatever was there
        // last, and letting that out is a fault that sounds like a glitch
        // rather than like the engine being unconfigured.
        for (int c = 0; c < numOutputChannels; ++c)
            if (output[c] != nullptr) std::fill_n(output[c], numSamples, 0.0f);
        return;
    }

    const int nIn = std::min(numInputChannels, kMaxCallbackChannels);
    const int nOut = std::min(numOutputChannels, kMaxCallbackChannels);

    // Channels past the ceiling are cleared once here rather than left to the
    // engine: it is never told they exist, so nothing else would write them.
    for (int c = nOut; c < numOutputChannels; ++c)
        if (output[c] != nullptr) std::fill_n(output[c], numSamples, 0.0f);

    for (int offset = 0; offset < numSamples;) {
        const int chunk = std::min(numSamples - offset, maxBlock);

        std::array<const float*, kMaxCallbackChannels> ins{};
        std::array<float*, kMaxCallbackChannels> outs{};
        for (int c = 0; c < nIn; ++c)
            ins[static_cast<size_t>(c)] =
                (input != nullptr && input[c] != nullptr) ? input[c] + offset : nullptr;
        for (int c = 0; c < nOut; ++c)
            outs[static_cast<size_t>(c)] = output[c] != nullptr ? output[c] + offset : nullptr;

        sink.renderIo(ins.data(), static_cast<uint32_t>(nIn),
                      outs.data(), static_cast<uint32_t>(nOut),
                      static_cast<uint32_t>(chunk));
        offset += chunk;
    }
}

} // namespace wizard::host
