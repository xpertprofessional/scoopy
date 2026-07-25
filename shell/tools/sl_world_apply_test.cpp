// The Option-B play path, native half: a name-keyed World -> v3 snapshot ->
// SOUND. Headless (no WebView, no device).
//
// Proves the generic applier turns a flat World payload into a committed engine
// world that renders the expected audio, resolves params by engine name, treats
// an unknown name as forward-compatible (ignored, never misread), and refuses a
// holey world (no sample / no steps) rather than committing silence that looks
// like a broken engine.
#include "SlWorldApply.h"
#include "sl_engine.h"

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

using namespace wizard::sl;

namespace {
bool wasApplied(const juce::var& r) { return (bool) r.getProperty("applied", false); }
juce::String errorOf(const juce::var& r) { return r.getProperty("error", juce::var()).toString(); }

double renderPeak(sl_engine* e, int blocks) {
    std::vector<float> l(512, 0.0f), r(512, 0.0f);
    float* buses[2] = {l.data(), r.data()};
    double peak = 0.0;
    for (int b = 0; b < blocks; ++b) {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        sl_render(e, buses, 2, 512);
        for (float v : l) peak = std::fmax(peak, std::fabs((double) v));
    }
    return peak;
}
} // namespace

int main() {
    sl_engine* e = sl_engine_create(48000.0, 512, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    // Register a 220 Hz tone via the JSON sample path.
    {
        auto* left = new juce::Array<juce::var>();
        for (int i = 0; i < 4800; ++i)
            left->add(0.5 * std::sin(2.0 * 3.14159265358979 * 220.0 * i / 48000.0));
        auto* s = new juce::DynamicObject();
        s->setProperty("id", "tone");
        s->setProperty("left", juce::var(*left));
        s->setProperty("sampleRate", 48000.0);
        CHECK(registerSample(e, juce::var(s)));
        delete left;
    }
    // Register guard rails.
    CHECK(!registerSample(e, juce::JSON::parse(R"({"id":"x"})")));      // no left
    CHECK(!registerSample(e, juce::JSON::parse(R"({"left":[0.1,0.2]})")));// no id
    CHECK(!registerSample(nullptr, juce::JSON::parse(R"({"id":"x","left":[0.1]})")));

    // A name-keyed World: one track, all 8 steps, volume set by ENGINE NAME,
    // plus an UNMAPPED field that must be ignored (not misread) and a per-step
    // array.
    const char* worldJson = R"({
      "deck": 0, "bpm": 120, "isPlaying": true, "startStep": 0,
      "tracks": [
        { "sampleId": "tone", "steps": [1,1,1,1,1,1,1,1],
          "volume": 1.0, "unmappedFutureField": 999.0,
          "pitchOffsets": [0,0,0,0,0,0,0,0] }
      ]
    })";
    const auto r = applyWorld(e, juce::JSON::parse(worldJson));
    CHECK(wasApplied(r));
    CHECK(errorOf(r).isEmpty());

    // THE POINT: the published world plays.
    const double peak = renderPeak(e, 100);
    CHECK(peak > 0.0001);

    // An empty-tracks world commits nothing audible but is not an error shape:
    // publishing "stop everything" is legitimate. (isPlaying false, no tracks.)
    const auto silent = applyWorld(e, juce::JSON::parse(
        R"({"deck":0,"bpm":120,"isPlaying":false,"startStep":0,"tracks":[]})"));
    CHECK(wasApplied(silent));
    CHECK(renderPeak(e, 40) < 0.0001); // the tone stopped

    // Refusals — reported, not silently committed as holey worlds.
    CHECK(!wasApplied(applyWorld(e, juce::JSON::parse(
        R"({"deck":0,"bpm":120,"isPlaying":true,"startStep":0,
            "tracks":[{"steps":[1,0]}]})"))));            // no sampleId
    CHECK(!wasApplied(applyWorld(e, juce::JSON::parse(
        R"({"deck":0,"bpm":120,"isPlaying":true,"startStep":0,
            "tracks":[{"sampleId":"tone"}]})"))));                    // no steps
    CHECK(!wasApplied(applyWorld(e, juce::JSON::parse(
        R"({"deck":0,"tracks":"nope"})"))));                          // tracks not array
    CHECK(errorOf(applyWorld(e, juce::JSON::parse(
        R"({"deck":1,"bpm":120,"isPlaying":true,"startStep":0,"tracks":[]})")))
        .contains("deck"));                                          // deck>0 refused honestly
    CHECK(!wasApplied(applyWorld(nullptr, juce::JSON::parse(R"({"tracks":[]})"))));

    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("sl_world_apply_test OK (peak %.4f)\n", peak);
    return 0;
}
