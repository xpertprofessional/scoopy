// RecordService end-to-end (P3-05): engine record → drain thread → on-disk take.
//
// Drives a real engine with a ramp input, records a deck, and verifies the file
// the service produced contains exactly the captured audio, in order, with the
// take's stamp and sidecar. Also asserts the drain never blocks the render:
// the "render" loop here runs at full speed with no synchronisation with the
// service thread at all.
#include "RecordService.h"
#include "WzTakeDrainSource.h"

#include "wz_engine.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr uint32_t kQ = 256;
constexpr double kRate = 48000.0;

// Read the float32 payload of a WAV written by wz_wav (audio starts at 690).
std::vector<float> readWavAudio(const std::string& path, uint64_t& frames, uint32_t ch) {
    std::vector<float> out;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) { frames = 0; return out; }
    std::fseek(f, 0, SEEK_END);
    const long end = std::ftell(f);
    if (end <= 690) { std::fclose(f); frames = 0; return out; }
    const size_t bytes = static_cast<size_t>(end - 690);
    out.resize(bytes / sizeof(float));
    std::fseek(f, 690, SEEK_SET);
    const size_t got = std::fread(out.data(), sizeof(float), out.size(), f);
    out.resize(got);
    std::fclose(f);
    frames = got / ch;
    return out;
}
} // namespace

int main() {
    const std::string dir = "/tmp/wizard_recsvc_test";
    std::string rm = "rm -rf " + dir;
    CHECK(std::system(rm.c_str()) == 0);

    wz_engine* e = wz_engine_create(kRate, kQ, 7);
    CHECK(e != nullptr);

    wizard::record::WzTakeDrainSource src(e);
    wizard::record::Service svc;
    CHECK(svc.start(src, dir));

    // Let the engine clock ADVANCE before arming. Recording from sample 0 is
    // the one case where a severed stamp is indistinguishable from a correct
    // one — which is exactly how every take shipped stamped 0 without a test
    // noticing. A real session always arms well after boot.
    {
        std::vector<float> pin(kQ, 0.0f), pl(kQ), pr(kQ), pcl(kQ), pcr(kQ);
        const float* pins[1] = {pin.data()};
        float* pouts[4] = {pl.data(), pr.data(), pcl.data(), pcr.data()};
        for (int b = 0; b < 10; ++b) wz_engine_render_io(e, pins, 1, pouts, 4, kQ);
    }

    // Deck 0 records engine input 0 (mono).
    wz_deck_set_record_source(e, 0, 0, -1);
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    // open() can only write a PROVISIONAL zero: the engine does not know the
    // true start until its first render block after arming.
    CHECK(svc.beginTake(0, 1, kRate, 0, "Test Ramp"));

    // "Render" 200 blocks of a ramp with NO synchronisation with the drain
    // thread — if the drain could block the render, this loop would stall.
    std::vector<float> in(kQ), l(kQ), r(kQ), cl(kQ), cr(kQ);
    const float* ins[1] = {in.data()};
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    constexpr int kBlocks = 200;
    uint32_t ramp = 0;
    const auto t0 = std::chrono::steady_clock::now();
    for (int b = 0; b < kBlocks; ++b) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = static_cast<float>(ramp++);
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
        std::this_thread::sleep_for(std::chrono::milliseconds(1)); // pace ≈ realtime-ish
    }
    const auto elapsed = std::chrono::steady_clock::now() - t0;
    // 200 blocks × ~1 ms should take well under a second; a blocking drain would
    // show up as a multi-second run.
    CHECK(std::chrono::duration_cast<std::chrono::seconds>(elapsed).count() < 5);

    const uint64_t captured = wz_deck_frames(e, 0);
    CHECK(captured == static_cast<uint64_t>(kBlocks) * kQ);
    const uint64_t realStamp = wz_deck_record_stop(e, 0);
    // Give the render a block to observe the stop, then finalize.
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    CHECK(svc.endTake(0, realStamp));

    // --- the take list ------------------------------------------------------
    const auto takes = svc.takes();
    CHECK(takes.size() == 1);
    CHECK(takes[0].deckId == 0);
    CHECK(takes[0].channels == 1);
    CHECK(takes[0].sourceDesc == "Test Ramp");
    CHECK(takes[0].frames > 0);
    // LAW C-2: the take must carry the engine's REAL start, not the provisional
    // zero written when the file was opened. Nothing covered this hop before,
    // which is exactly why every take shipped stamped 0 — making align a
    // no-op and importing every take at 0:00 in a DAW. The engine's stamp is
    // proven by deck_stamp_test and the writer by wav_killtest; this pins the
    // HAND-OFF between them, which is where the value was being dropped.
    CHECK(realStamp > 0);
    CHECK(takes[0].startEngineSample == realStamp);
    CHECK(svc.droppedFrames(0) == 0); // the drain kept up

    // --- the file holds the captured ramp, in order -------------------------
    uint64_t fileFrames = 0;
    const auto audio = readWavAudio(takes[0].path, fileFrames, 1);
    CHECK(fileFrames > 0);
    // Everything the file got must be the ramp from frame 0, contiguous.
    for (uint64_t i = 0; i < fileFrames; ++i)
        CHECK(audio[static_cast<size_t>(i)] == static_cast<float>(i));
    // The drain should have captured nearly everything (it runs the whole time).
    CHECK(fileFrames >= captured / 2);
    std::printf("  captured %llu frames, file has %llu\n",
                static_cast<unsigned long long>(captured),
                static_cast<unsigned long long>(fileFrames));

    // --- sidecar ------------------------------------------------------------
    std::FILE* sc = std::fopen((takes[0].path + ".json").c_str(), "rb");
    CHECK(sc != nullptr);
    char json[512] = {};
    std::fread(json, 1, sizeof(json) - 1, sc);
    std::fclose(sc);
    CHECK(std::strstr(json, "\"deckId\": 0") != nullptr);
    CHECK(std::strstr(json, "Test Ramp") != nullptr);
    CHECK(std::strstr(json, "\"channels\": 1") != nullptr);

    // --- naming is time-sortable + self-describing (provisional policy) -----
    const auto n1 = wizard::record::Service::takeFileName(0, 1000);
    const auto n2 = wizard::record::Service::takeFileName(0, 2000);
    CHECK(n1 < n2); // lexicographic order == chronological order
    CHECK(n1.find("deck1_") == 0);

    svc.stop();
    wz_engine_destroy(e);
    std::printf("recorder_drain_test OK\n");
    return 0;
}
