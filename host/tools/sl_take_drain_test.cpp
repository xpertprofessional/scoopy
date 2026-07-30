// The merged engine's takes, end to end: tape → drain thread → on-disk WAV —
// and the LAW C-2 STAMP CHAIN, verified in the FILE BYTES rather than in memory.
//
// Why this fixture exists. Law C-2's promise is that two takes recorded at
// different moments can be realigned by pure subtraction: drop both files at
// 0:00 in a DAW and the session reproduces. That promise passes through four
// hands — engine stamp → drain → WavWriter's bext TimeReference → sidecar — and
// it has been dropped in transit before (docs/archive/pd-global-record-as-strip.md
// §4 found every take shipping TimeReference = 0, which made align a no-op).
// The engine's stamp is proven by sl_tape_record_test and the writer by
// wav_killtest; NOTHING covered the hand-off, which is precisely where the value
// went missing. So this test reads the 8 bytes back out of both files and
// asserts their difference is the real gap.
#include "RecordService.h"
#include "SlTakeDrainSource.h"

#include "sl_engine.h"

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

/** The bext TimeReference: 8 bytes at file offset 80 + 338 (WavWriter.cpp). Read
    from the file so this test cannot pass on an in-memory value that never
    reached the disk — that is the whole failure mode being guarded. */
bool readTimeReference(const std::string& path, uint64_t& out) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) return false;
    bool ok = std::fseek(f, 80 + 338, SEEK_SET) == 0 && std::fread(&out, 8, 1, f) == 1;
    std::fclose(f);
    return ok;
}

/** Float32 payload of a WAV written by wz_wav (audio starts at 690). */
std::vector<float> readWavAudio(const std::string& path, uint64_t& frames, uint32_t ch) {
    std::vector<float> out;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) { frames = 0; return out; }
    std::fseek(f, 0, SEEK_END);
    const long end = std::ftell(f);
    if (end <= 690) { std::fclose(f); frames = 0; return out; }
    out.resize(static_cast<size_t>(end - 690) / sizeof(float));
    std::fseek(f, 690, SEEK_SET);
    const size_t got = std::fread(out.data(), sizeof(float), out.size(), f);
    out.resize(got);
    std::fclose(f);
    frames = got / ch;
    return out;
}
} // namespace

int main() {
    const std::string dir = "/tmp/wizard_sl_takes_test";
    CHECK(std::system(("rm -rf " + dir).c_str()) == 0);

    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    wizard::record::SlTakeDrainSource src(e);
    wizard::record::Service svc;
    CHECK(svc.start(src, dir));
    // The service sized itself from the engine, not from a hardcoded 8.
    CHECK(src.slotCount() == sl_tape_count());

    std::vector<float> zero(kQ, 0.0f), in(kQ), l(kQ), r(kQ);
    const float* ins[3] = {zero.data(), zero.data(), in.data()};
    float* outs[2] = {l.data(), r.data()};
    auto render = [&] { sl_render_io(e, ins, 3, outs, 2, kQ); };

    // Let the clock ADVANCE before arming. Recording from sample 0 is the one
    // case where a severed stamp is indistinguishable from a correct one — which
    // is exactly how takes shipped stamped 0 without a test noticing.
    for (int b = 0; b < 10; ++b) render();

    // --- take A: tape 0, mono, from input channel 2 -------------------------
    CHECK(sl_tape_set_record_source(e, 0, 0 /* deviceInput */, 2, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    // The width is known synchronously (record_start resets the tape on the
    // control thread), so there is no need to render before opening the file —
    // and rendering here would capture one block of whatever the input buffer
    // last held, putting silence at the head of the take.
    CHECK(sl_tape_channels(e, 0) == 1);
    // open() can only write a PROVISIONAL zero: the engine does not know the
    // true start until its first render block after arming.
    CHECK(svc.beginTake(0, sl_tape_channels(e, 0), kRate, 0, "Tape A"));

    uint32_t ramp = 0;
    constexpr int kBlocksA = 60;
    for (int b = 0; b < kBlocksA; ++b) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = static_cast<float>(ramp++);
        render();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const uint64_t stampA = sl_tape_record_stop(e, 0);
    render(); // let the render observe the stop
    CHECK(svc.endTake(0, stampA));

    // --- a measured gap, then take B: tape 1, stereo ------------------------
    constexpr int kGapBlocks = 37; // deliberately not a round number
    for (int b = 0; b < kGapBlocks; ++b) render();

    CHECK(sl_tape_set_record_source(e, 1, 0, 2, 3) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 1);
    render();
    CHECK(sl_tape_channels(e, 1) == 2);
    CHECK(svc.beginTake(1, sl_tape_channels(e, 1), kRate, 0, "Tape B"));
    for (int b = 0; b < 20; ++b) {
        render();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const uint64_t stampB = sl_tape_record_stop(e, 1);
    render();
    CHECK(svc.endTake(1, stampB));

    // --- the engine's own stamps differ by exactly the real gap -------------
    // Between the two arm pickups the engine rendered: take A's kBlocksA capture
    // blocks, the block that observed A's stop, and the gap. B's arm is picked
    // up by the very next render, which is where its stamp is written.
    const uint64_t expectedGap =
        static_cast<uint64_t>(kBlocksA + 1 + kGapBlocks) * kQ;
    CHECK(stampB - stampA == expectedGap);
    CHECK(stampA > 0); // armed well after boot, as a real session does

    // --- the take list carries the REAL stamps, not the provisional zeros ---
    const auto takes = svc.takes();
    CHECK(takes.size() == 2);
    CHECK(takes[0].sourceDesc == "Tape A");
    CHECK(takes[0].channels == 1);
    CHECK(takes[0].startEngineSample == stampA);
    CHECK(takes[1].sourceDesc == "Tape B");
    CHECK(takes[1].channels == 2);
    CHECK(takes[1].startEngineSample == stampB);
    CHECK(svc.droppedFrames(0) == 0);
    CHECK(svc.droppedFrames(1) == 0);

    // --- THE ASSERTION THIS FIXTURE EXISTS FOR ------------------------------
    // The stamps survived all the way into the bext chunk of both FILES, and
    // their difference is the real gap. A severed chain leaves both at 0, whose
    // difference is also 0 — so the delta, not the presence, is what is checked.
    uint64_t fileA = 0, fileB = 0;
    CHECK(readTimeReference(takes[0].path, fileA));
    CHECK(readTimeReference(takes[1].path, fileB));
    CHECK(fileA == stampA);
    CHECK(fileB == stampB);
    CHECK(fileB - fileA == expectedGap);
    std::printf("  bext TimeReference delta = %llu samples (expected %llu)\n",
                static_cast<unsigned long long>(fileB - fileA),
                static_cast<unsigned long long>(expectedGap));

    // --- and the sidecars agree with the files ------------------------------
    for (const auto& t : takes) {
        std::FILE* sc = std::fopen((t.path + ".json").c_str(), "rb");
        CHECK(sc != nullptr);
        char json[512] = {};
        std::fread(json, 1, sizeof(json) - 1, sc);
        std::fclose(sc);
        char needle[96];
        std::snprintf(needle, sizeof(needle), "\"startEngineSample\": %llu",
                      static_cast<unsigned long long>(t.startEngineSample));
        CHECK(std::strstr(json, needle) != nullptr);
        CHECK(std::strstr(json, t.sourceDesc.c_str()) != nullptr);
    }

    // --- take A's audio is the captured ramp, in order ----------------------
    uint64_t framesA = 0;
    const auto audioA = readWavAudio(takes[0].path, framesA, 1);
    CHECK(framesA > 0);
    for (uint64_t i = 0; i < framesA; ++i)
        CHECK(audioA[static_cast<size_t>(i)] == static_cast<float>(i));
    CHECK(framesA >= sl_tape_frames(e, 0) / 2); // the drain kept up

    svc.stop();
    sl_engine_destroy(e);
    std::printf("sl_take_drain_test OK\n");
    return 0;
}
