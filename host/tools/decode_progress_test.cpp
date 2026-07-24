// P1-11: a deck load must run off the message thread, so loadForDeck grew a
// progress + cancellation control. This proves the CONTRACT that the async
// wiring in the shell relies on: progress is monotonic and ends at 1.0, and a
// cancel is honoured before the expensive resample rather than after it.
#include "Decoder.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <atomic>
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

juce::File writeTone(const juce::File& dir, double rate, int frames) {
    const auto wav = dir.getChildFile("tone.wav");
    juce::WavAudioFormat fmt;
    std::unique_ptr<juce::AudioFormatWriter> writer(
        fmt.createWriterFor(new juce::FileOutputStream(wav), rate, 2, 24, {}, 0));
    juce::AudioBuffer<float> buf(2, frames);
    for (int i = 0; i < frames; ++i) {
        const auto s = static_cast<float>(0.4 * std::sin(2.0 * kPi * 330.0 * i / rate));
        buf.setSample(0, i, s);
        buf.setSample(1, i, s * 0.5f);
    }
    writer->writeFromAudioSampleBuffer(buf, 0, frames);
    return wav;
}
} // namespace

int main() {
    const auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("wizard_decode_progress_test");
    dir.deleteRecursively();
    CHECK(dir.createDirectory().wasOk());

    // 44.1k source into a 48k engine → the SINC_BEST path (the one that freezes
    // the UI today) actually runs.
    const auto wav = writeTone(dir, 44100.0, 22050);

    // --- progress is monotonic, starts low, ends at exactly 1.0 --------------
    {
        std::vector<float> ticks;
        wizard::decode::LoadControl ctl;
        ctl.onProgress = [&](float p) { ticks.push_back(p); };
        const auto audio = wizard::decode::loadForDeck(wav, 48000.0, ctl);
        CHECK(audio.ok);
        CHECK(!ticks.empty());
        for (size_t i = 1; i < ticks.size(); ++i)
            CHECK(ticks[i] >= ticks[i - 1]); // never goes backwards
        CHECK(ticks.front() >= 0.0f && ticks.front() < 0.30f); // a real "starting" signal
        CHECK(std::abs(ticks.back() - 1.0f) < 1e-6f);          // and a definite "done"
    }

    // --- a cancel is honoured, and BEFORE the resample runs ------------------
    {
        int calls = 0;
        wizard::decode::LoadControl ctl;
        // Cancel from the second poll onward: the first poll (post-decode) may
        // pass, but the per-channel resample checks must then abort.
        ctl.isCancelled = [&] { return ++calls > 1; };
        float lastProgress = -1.0f;
        ctl.onProgress = [&](float p) { lastProgress = p; };
        const auto audio = wizard::decode::loadForDeck(wav, 48000.0, ctl);
        CHECK(!audio.ok);
        CHECK(audio.error == "cancelled");
        // It stopped early: it never reported completion.
        CHECK(lastProgress < 1.0f);
        // And it produced no channel data to swap in.
        CHECK(audio.data.empty());
    }

    // --- cancelling immediately aborts before any decode work ----------------
    {
        wizard::decode::LoadControl ctl;
        ctl.isCancelled = [] { return true; };
        const auto audio = wizard::decode::loadForDeck(wav, 48000.0, ctl);
        CHECK(!audio.ok);
        CHECK(audio.error == "cancelled");
    }

    // --- a no-op control still loads (the common path) -----------------------
    {
        const auto audio = wizard::decode::loadForDeck(wav, 48000.0, {});
        CHECK(audio.ok);
        CHECK(audio.channels == 2);
    }

    dir.deleteRecursively();
    std::printf("decode_progress_test OK\n");
    return 0;
}
