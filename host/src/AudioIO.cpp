#include "AudioIO.h"

#include "wz_engine.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace wizard::host {

AudioIO::AudioIO(wz_engine* engineToUse) : engine(engineToUse) {}

AudioIO::~AudioIO() { close(); }

juce::String AudioIO::open(double sampleRate) {
    if (sampleRate <= 0.0) return "invalid sample rate";
    if (attached && std::abs(openedRate - sampleRate) < 0.5) return {};

    detach();
    if (!initialised) {
        // Duplex: 2 in, 2 out. Input on the same device = same clock as output
        // (D-WZ-RATE-01), so hardware inputs bypass ASRC entirely.
        const auto err = deviceManager.initialiseWithDefaultDevices(2, 2);
        if (err.isNotEmpty()) return err;
        initialised = true;
    }

    auto setup = deviceManager.getAudioDeviceSetup();
    setup.sampleRate = sampleRate;
    const auto err = deviceManager.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty()) return err;

    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr) return "no audio device";

    // Refuse rather than let the driver coerce (which would repitch the monitor
    // path). D-WZ-RATE-01: the engine runs at the device rate, no SRC on output.
    if (std::abs(device->getCurrentSampleRate() - sampleRate) > 0.5) {
        close();
        return "device does not support " + juce::String(sampleRate, 0) + " Hz";
    }

    wz_engine_set_sample_rate(engine, sampleRate);
    openedRate = sampleRate;
    attach();
    return {};
}

void AudioIO::close() {
    detach();
    deviceManager.closeAudioDevice();
    openedRate = 0.0;
}

void AudioIO::whileSuspended(const std::function<void()>& fn) {
    const bool wasAttached = attached;
    detach();
    fn();
    if (wasAttached) attach();
}

void AudioIO::attach() {
    if (!attached) {
        deviceManager.addAudioCallback(this);
        attached = true;
    }
}

void AudioIO::detach() {
    if (attached) {
        deviceManager.removeAudioCallback(this); // blocks until render drains
        attached = false;
    }
}

void AudioIO::audioDeviceIOCallbackWithContext(
    const float* const* input, int numInputChannels,
    float* const* output, int numOutputChannels, int numSamples,
    const juce::AudioIODeviceCallbackContext&) {
    juce::ignoreUnused(input, numInputChannels); // engine input path is P2 (source rings)
    if (numOutputChannels <= 0 || numSamples <= 0) return;

    // The engine renders straight into the device's output channel buffers as
    // its bus buffers (bus 0/1 = main L/R). The device block can exceed the
    // engine's max render block, so chunk it.
    const auto maxBlock = static_cast<int>(wz_engine_max_block_frames(engine));
    if (maxBlock <= 0) {
        for (int c = 0; c < numOutputChannels; ++c)
            if (output[c] != nullptr) juce::FloatVectorOperations::clear(output[c], numSamples);
        return;
    }

    for (int offset = 0; offset < numSamples;) {
        const int chunk = std::min(numSamples - offset, maxBlock);
        // Offset each channel pointer into the current chunk.
        std::array<float*, 32> chans{};
        const int n = std::min(numOutputChannels, static_cast<int>(chans.size()));
        for (int c = 0; c < n; ++c)
            chans[static_cast<size_t>(c)] = output[c] != nullptr ? output[c] + offset : nullptr;
        wz_engine_render(engine, chans.data(), static_cast<uint32_t>(n),
                         static_cast<uint32_t>(chunk));
        offset += chunk;
    }
}

} // namespace wizard::host
