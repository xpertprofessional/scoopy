#include "AudioIO.h"


#include <algorithm>
#include <array>
#include <cmath>

namespace wizard::host {

AudioIO::AudioIO(RenderSink& sinkToUse) : sink(sinkToUse) {}

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

    // The engine half of D-WZ-RATE-01. If it refuses, the device is unusable at
    // this rate: attaching anyway would run the callback against an engine
    // clocked for something else.
    if (!sink.setSampleRate(sampleRate)) {
        close();
        return "engine could not run at " + juce::String(sampleRate, 0) + " Hz";
    }
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
    if (!sink.setSampleRate(sampleRate))
        return "engine could not run at " + juce::String(sampleRate, 0) + " Hz";
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
    // The engine renders straight into the device's output channel buffers as
    // its bus buffers (bus 0/1 = main L/R, 2/3 = monitor). Inputs ride the SAME
    // callback — same clock, no rings, no ASRC (D-WZ-RATE-01): deviceInput
    // strips read them inside the sink's renderIo.
    //
    // The body lives in renderChunked so the chunking, pointer offsetting and
    // unconfigured-engine handling are testable without a device or a display
    // (render_sink_test) — everything that used to be untestable about this
    // callback was the part with the arithmetic in it.
    renderChunked(sink, input, numInputChannels, output, numOutputChannels, numSamples);
}

} // namespace wizard::host
