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

juce::String AudioIO::deviceName() const {
    auto* device = deviceManager.getCurrentAudioDevice();
    return device != nullptr ? device->getName() : juce::String();
}

juce::StringArray AudioIO::availableInputDevices() const {
    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        return type->getDeviceNames(true);
    return {};
}

juce::StringArray AudioIO::availableOutputDevices() const {
    if (auto* type = deviceManager.getCurrentDeviceTypeObject())
        return type->getDeviceNames(false);
    return {};
}

juce::String AudioIO::setDevices(const juce::String& inName, const juce::String& outName,
                                 double sampleRate) {
    if (sampleRate <= 0.0) return "invalid sample rate";
    if (!initialised) return open(sampleRate); // nothing open yet
    detach();
    auto setup = deviceManager.getAudioDeviceSetup();
    if (inName.isNotEmpty()) setup.inputDeviceName = inName;
    if (outName.isNotEmpty()) setup.outputDeviceName = outName;
    setup.sampleRate = sampleRate;
    setup.useDefaultInputChannels = true;
    setup.useDefaultOutputChannels = true;
    const auto err = deviceManager.setAudioDeviceSetup(setup, true);
    if (err.isNotEmpty()) return err;
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr) return "no audio device";
    if (std::abs(device->getCurrentSampleRate() - sampleRate) > 0.5)
        return "device does not support " + juce::String(sampleRate, 0) + " Hz";
    wz_engine_set_sample_rate(engine, sampleRate);
    openedRate = sampleRate;
    attach();
    return {};
}

juce::String AudioIO::inputDeviceName() const {
    // macOS pairs separate input/output devices behind one callback; the
    // combined device's getName() reports the OUTPUT side, which read as "it
    // views the output?" in the sources rail (P1-G1 field finding). Report the
    // input side by its own name.
    return deviceManager.getAudioDeviceSetup().inputDeviceName;
}

int AudioIO::activeInputChannelCount() const {
    auto* device = deviceManager.getCurrentAudioDevice();
    return device != nullptr ? device->getActiveInputChannels().countNumberOfSetBits() : 0;
}

int AudioIO::activeOutputChannelCount() const {
    auto* device = deviceManager.getCurrentAudioDevice();
    return device != nullptr ? device->getActiveOutputChannels().countNumberOfSetBits() : 0;
}

juce::StringArray AudioIO::activeInputChannelNames() const {
    auto* device = deviceManager.getCurrentAudioDevice();
    if (device == nullptr) return {};
    // The engine sees inputs by their position in the CALLBACK's array, which
    // carries only ACTIVE channels — so names are compacted the same way, and
    // index i here is exactly srcChan i in a deviceInput SourceRef.
    const auto all = device->getInputChannelNames();
    const auto active = device->getActiveInputChannels();
    juce::StringArray names;
    for (int i = 0; i < all.size(); ++i)
        if (active[i]) names.add(all[i]);
    return names;
}

void AudioIO::audioDeviceIOCallbackWithContext(
    const float* const* input, int numInputChannels,
    float* const* output, int numOutputChannels, int numSamples,
    const juce::AudioIODeviceCallbackContext&) {
    if (numOutputChannels <= 0 || numSamples <= 0) return;

    // The engine renders straight into the device's output channel buffers as
    // its bus buffers (bus 0/1 = main L/R, 2/3 = monitor). Inputs ride the SAME
    // callback — same clock, no rings, no ASRC (D-WZ-RATE-01): deviceInput
    // strips read them inside wz_engine_render_io. The device block can exceed
    // the engine's max render block, so chunk both sides together.
    const auto maxBlock = static_cast<int>(wz_engine_max_block_frames(engine));
    if (maxBlock <= 0) {
        for (int c = 0; c < numOutputChannels; ++c)
            if (output[c] != nullptr) juce::FloatVectorOperations::clear(output[c], numSamples);
        return;
    }

    for (int offset = 0; offset < numSamples;) {
        const int chunk = std::min(numSamples - offset, maxBlock);
        // Offset each channel pointer into the current chunk.
        std::array<const float*, 32> ins{};
        std::array<float*, 32> outs{};
        const int nIn = std::min(numInputChannels, static_cast<int>(ins.size()));
        const int nOut = std::min(numOutputChannels, static_cast<int>(outs.size()));
        for (int c = 0; c < nIn; ++c)
            ins[static_cast<size_t>(c)] = input[c] != nullptr ? input[c] + offset : nullptr;
        for (int c = 0; c < nOut; ++c)
            outs[static_cast<size_t>(c)] = output[c] != nullptr ? output[c] + offset : nullptr;
        wz_engine_render_io(engine, ins.data(), static_cast<uint32_t>(nIn),
                            outs.data(), static_cast<uint32_t>(nOut),
                            static_cast<uint32_t>(chunk));
        offset += chunk;
    }
}

} // namespace wizard::host
