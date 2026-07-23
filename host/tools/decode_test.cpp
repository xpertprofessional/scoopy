// Deck decode path (P1-07): write a known WAV at 44.1k, decode + SINC_BEST
// resample to a 48k engine (D-WZ-DECKSRC-01), load into a deck, and verify the
// engine plays it back — headless, no device.
#include "Decoder.h"

#include "wz_engine.h"

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

    // Load into a deck and render through a unity strip: the engine plays it.
    wz_engine* e = wz_engine_create(48000.0, 256, 5);
    CHECK(e != nullptr);
    std::vector<const float*> planar = {audio.data[0].data(), audio.data[1].data()};
    CHECK(wz_deck_load(e, 0, audio.channels, ef,
                       const_cast<const float* const*>(planar.data()), 48000.0) == 1);
    CHECK(wz_deck_frames(e, 0) == ef);

    wz_world_begin(e);
    wz_world_channel_begin(e, "deck-strip");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2); // deck
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);

    wz_deck_trigger(e, 0, 0); // loop
    std::vector<float> l(256), r(256), cl(256), cr(256);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    double peak = 0.0;
    for (int b = 0; b < 100; ++b) { // ~0.53 s: crosses the loop wrap
        wz_engine_render(e, outs, 4, 256);
        for (int i = 0; i < 256; ++i) peak = std::max(peak, std::abs(static_cast<double>(l[i])));
    }
    // 0.5 amp × cos(π/4) pan × unity fader ≈ 0.3536 — the sine peak reaches it.
    CHECK(peak > 0.34 && peak < 0.37);
    for (int i = 0; i < 256; ++i) CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));

    // HotFrame now carries 1 channel + 1 deck block.
    CHECK(wz_engine_hotframe_length(e) == 8 + 7 + 7);
    std::vector<double> hot(8 + 14, 0.0);
    CHECK(wz_engine_hotframe(e, hot.data(), 8 + 14) == 8 + 14);
    CHECK(hot[8 + 7 + 0] == 1.0); // deck state: looping
    CHECK(hot[8 + 7 + 4] == 1.0); // rate 1.0 until P4

    wz_engine_destroy(e);
    dir.deleteRecursively();
    std::printf("decode_test OK\n");
    return 0;
}
