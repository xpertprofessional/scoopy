// Host audio IO: owns the DUPLEX device (JUCE AudioDeviceManager, input +
// output in one callback) and drives wz_engine_render from it — the engine core
// never touches device APIs.
//
// D-WZ-RATE-01 (docs/DECISIONS.md): the engine graph runs at the OUTPUT DEVICE
// rate. Hardware inputs arrive in this same callback → same clock → zero SRC on
// the live path. open(rate) refuses with a human-readable error when the device
// cannot run at `rate` (drivers silently coerce, which would repitch), so the
// monitor/main path stays bit-exact to the device.
//
// The input side is opened now (2 in) so the same-clock capture path exists from
// P0; the engine does not yet consume it (source rings + channels are P1/P2).
#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <functional>

struct wz_engine;

namespace wizard::host {

class AudioIO final : public juce::AudioIODeviceCallback {
public:
    explicit AudioIO(wz_engine* engineToUse);
    ~AudioIO() override;

    // (Re)opens the default duplex device at `sampleRate` and attaches the
    // render callback. Empty string on success, else the error. Message thread
    // only.
    juce::String open(double sampleRate);
    void close();
    double openedSampleRate() const { return openedRate; }

    // Runs `fn` with the render callback detached (engine mutations are not
    // RT-safe against a live render). Message thread only.
    void whileSuspended(const std::function<void()>& fn);

    // Device introspection for the UI's sources browser (message thread only).
    // Input names are compacted to ACTIVE channels, so index i == the engine's
    // srcChan i in a deviceInput SourceRef.
    juce::String deviceName() const;
    juce::String inputDeviceName() const;
    // Available devices for the picker (current device type). Message thread.
    juce::StringArray availableInputDevices() const;
    juce::StringArray availableOutputDevices() const;
    // Switch input and/or output device (empty = leave that side unchanged),
    // re-opening at `sampleRate`. Empty string on success, else the error.
    // The engine world + decks survive (this does not recreate the engine);
    // only the device changes. Message thread only.
    juce::String setDevices(const juce::String& inName, const juce::String& outName,
                            double sampleRate);
    int activeInputChannelCount() const;
    int activeOutputChannelCount() const;
    juce::StringArray activeInputChannelNames() const;

    void audioDeviceIOCallbackWithContext(const float* const* input,
                                          int numInputChannels,
                                          float* const* output,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& context) override;
    void audioDeviceAboutToStart(juce::AudioIODevice*) override {}
    void audioDeviceStopped() override {}

private:
    void attach();
    void detach();

    wz_engine* engine;
    juce::AudioDeviceManager deviceManager;
    double openedRate = 0.0;
    bool attached = false;
    bool initialised = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioIO)
};

} // namespace wizard::host
