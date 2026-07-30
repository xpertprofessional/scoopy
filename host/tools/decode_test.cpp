// Decode path (P1-07): write a known WAV at 44.1k, then decode + SINC_BEST
// resample it to the 48k engine rate (D-WZ-DECKSRC-01) — headless, no device.
//
// ⚠️ COVERAGE THIS FILE USED TO CARRY AND NO LONGER DOES (H2a). It ended by
// loading the decoded audio into a `wz_engine` deck and asserting the engine
// PLAYED it — peak level through a unity strip, and the deck's HotFrame block.
// That engine is retired, and the surviving one has no load path to point this
// at yet: giving audio to a tape IS P8-5 (`tapeLoadTake` becomes REAL), whose
// gate is already written as "save a map with a looper take, reopen, hear it
// play". So the played-back claim is not dropped, it is P8-5's to make. What
// remains here is the half P8-5 will depend on: the bytes come back correct.
#include "Decoder.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <cmath>
#include <cstdio>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr double kPi = 3.14159265358979323846;
}

int main() {
    const auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("wizard_decode_test");
    dir.deleteRecursively();
    CHECK(dir.createDirectory().wasOk());
    const auto wav = dir.getChildFile("tone44.wav");

    // 0.5 s of a 441 Hz sine at 44.1k, stereo (R at half level so channels are
    // distinguishable after the resample).
    constexpr double kSrcRate = 44100.0;
    constexpr int kSrcFrames = 22050;
    {
        juce::WavAudioFormat fmt;
        std::unique_ptr<juce::AudioFormatWriter> writer(fmt.createWriterFor(
            new juce::FileOutputStream(wav), kSrcRate, 2, 24, {}, 0));
        CHECK(writer != nullptr);
        juce::AudioBuffer<float> buf(2, kSrcFrames);
        for (int i = 0; i < kSrcFrames; ++i) {
            const auto s = static_cast<float>(0.5 * std::sin(2.0 * kPi * 441.0 * i / kSrcRate));
            buf.setSample(0, i, s);
            buf.setSample(1, i, s * 0.5f);
        }
        CHECK(writer->writeFromAudioSampleBuffer(buf, 0, kSrcFrames));
    }

    // Decode + resample to the 48k engine rate.
    const auto audio = wizard::decode::loadForDeck(wav, 48000.0);
    CHECK(audio.ok);
    CHECK(audio.channels == 2);
    CHECK(std::abs(audio.sourceRate - kSrcRate) < 0.5);
    CHECK(audio.sourceFrames == kSrcFrames);
    // 22050 @44.1k → ~24000 @48k (SINC_BEST may trim a few boundary frames).
    const auto ef = audio.engineFrames();
    CHECK(ef > 23900 && ef <= 24010);
    for (const auto& ch : audio.data)
        for (const auto s : ch) CHECK(std::isfinite(s));

    // The resample is CORRECT, not merely finite. A SINC_BEST conversion of a
    // 441 Hz sine must still peak at the source amplitude (0.5 on L, 0.25 on R,
    // where the channels were deliberately made distinguishable) — a decoder
    // that silently returned zeros, or swapped the channels, would satisfy
    // every check above and fail here.
    double peakL = 0.0, peakR = 0.0;
    for (const auto s : audio.data[0]) peakL = std::max(peakL, std::abs((double) s));
    for (const auto s : audio.data[1]) peakR = std::max(peakR, std::abs((double) s));
    CHECK(peakL > 0.49 && peakL < 0.51);
    CHECK(peakR > 0.24 && peakR < 0.26);

    dir.deleteRecursively();
    std::printf("decode_test OK\n");
    return 0;
}
