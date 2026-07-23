#include "Decoder.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <samplerate.h>

#include <cmath>

namespace wizard::decode {

namespace {

// Per-channel SINC_BEST resample (planar in/out). Channels are resampled
// independently as mono streams — identical quality to interleaved operation,
// no interleave/deinterleave round-trip.
std::vector<float> resampleChannel(const std::vector<float>& in, double ratio,
                                   juce::String& error) {
    const auto outCap = static_cast<long>(std::ceil(static_cast<double>(in.size()) * ratio)) + 16;
    std::vector<float> out(static_cast<size_t>(outCap), 0.0f);

    SRC_DATA d{};
    d.data_in = in.data();
    d.data_out = out.data();
    d.input_frames = static_cast<long>(in.size());
    d.output_frames = outCap;
    d.src_ratio = ratio;

    const int err = src_simple(&d, SRC_SINC_BEST_QUALITY, 1);
    if (err != 0) {
        error = juce::String("resample failed: ") + src_strerror(err);
        return {};
    }
    out.resize(static_cast<size_t>(d.output_frames_gen));
    return out;
}

} // namespace

DeckAudio loadForDeck(const juce::File& file, double engineRate) {
    DeckAudio result;
    if (engineRate <= 0.0) {
        result.error = "engine rate not available (no device open?)";
        return result;
    }

    juce::AudioFormatManager formats;
    formats.registerBasicFormats(); // WAV/AIFF/FLAC/Ogg (+CoreAudio on macOS)
    std::unique_ptr<juce::AudioFormatReader> reader(formats.createReaderFor(file));
    if (reader == nullptr) {
        result.error = "unsupported or unreadable file: " + file.getFileName();
        return result;
    }

    const auto channels = static_cast<uint32_t>(reader->numChannels);
    const auto frames = static_cast<uint64_t>(reader->lengthInSamples);
    if (channels == 0 || frames == 0) {
        result.error = "file has no audio";
        return result;
    }

    juce::AudioBuffer<float> buf(static_cast<int>(channels), static_cast<int>(frames));
    if (!reader->read(&buf, 0, static_cast<int>(frames), 0, true, channels >= 2)) {
        result.error = "decode failed";
        return result;
    }

    result.channels = channels;
    result.sourceRate = reader->sampleRate;
    result.sourceFrames = frames;

    const bool needsSrc = std::abs(reader->sampleRate - engineRate) > 0.5;
    const double ratio = engineRate / reader->sampleRate;
    result.data.reserve(channels);
    for (uint32_t c = 0; c < channels; ++c) {
        std::vector<float> chan(buf.getReadPointer(static_cast<int>(c)),
                                buf.getReadPointer(static_cast<int>(c)) + frames);
        if (needsSrc) {
            // D-WZ-DECKSRC-01: one-time SINC_BEST conversion at load; playback
            // is then a straight read with zero SRC on the live path.
            chan = resampleChannel(chan, ratio, result.error);
            if (chan.empty()) return result;
        }
        result.data.push_back(std::move(chan));
    }
    // Equal-length guarantee across channels (resampler output lengths match
    // for identical inputs, but clamp defensively).
    size_t minLen = result.data[0].size();
    for (const auto& ch : result.data) minLen = std::min(minLen, ch.size());
    for (auto& ch : result.data) ch.resize(minLen);

    result.ok = true;
    return result;
}

} // namespace wizard::decode
