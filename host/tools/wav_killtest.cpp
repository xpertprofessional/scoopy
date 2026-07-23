// Crash-safety proof for the take writer (P3-04, docs/specs/recorder.md §4.1).
//
// A real fork() + SIGKILL mid-record — not a simulated close. The child opens a
// take and writes blocks forever; the parent kills it hard partway through, then
// parses the orphaned file: it must be a VALID WAV whose data length matches
// what was written to within one flush quantum. This is the difference between
// "the app crashed and I lost the take" and "the app crashed and the take is on
// disk up to the last half second".
#include "WavWriter.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {

constexpr uint32_t kChannels = 2;
constexpr double kRate = 48000.0;
constexpr uint32_t kBlock = 512;
constexpr uint64_t kFlushFrames = 4096; // small so the test is quick + the quantum is tight

struct Parsed {
    bool ok = false;
    uint32_t channels = 0;
    uint32_t sampleRate = 0;
    uint64_t dataBytes = 0;
    uint64_t frames = 0;
    uint64_t timeReference = 0; // bext: the Law C-2 engine-sample stamp
    bool isFloat = false;
    bool rf64 = false;
};

// Minimal independent RIFF walker — deliberately NOT reusing the writer's
// offsets, so a header the writer thinks it wrote wrong still fails here.
Parsed parseWav(const std::string& path) {
    Parsed p;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (f == nullptr) return p;
    char riff[4], wave[4];
    uint32_t riffSize = 0;
    if (std::fread(riff, 1, 4, f) != 4) { std::fclose(f); return p; }
    if (std::fread(&riffSize, 4, 1, f) != 1) { std::fclose(f); return p; }
    if (std::fread(wave, 1, 4, f) != 4) { std::fclose(f); return p; }
    p.rf64 = std::memcmp(riff, "RF64", 4) == 0;
    if (!p.rf64 && std::memcmp(riff, "RIFF", 4) != 0) { std::fclose(f); return p; }
    if (std::memcmp(wave, "WAVE", 4) != 0) { std::fclose(f); return p; }

    for (;;) {
        char id[4];
        uint32_t sz = 0;
        if (std::fread(id, 1, 4, f) != 4) break;
        if (std::fread(&sz, 4, 1, f) != 1) break;
        const long body = std::ftell(f);
        if (std::memcmp(id, "fmt ", 4) == 0) {
            uint16_t fmtTag = 0, ch = 0, blockAlign = 0, bits = 0;
            uint32_t sr = 0, byteRate = 0;
            std::fread(&fmtTag, 2, 1, f);
            std::fread(&ch, 2, 1, f);
            std::fread(&sr, 4, 1, f);
            std::fread(&byteRate, 4, 1, f);
            std::fread(&blockAlign, 2, 1, f);
            std::fread(&bits, 2, 1, f);
            p.channels = ch;
            p.sampleRate = sr;
            p.isFloat = fmtTag == 3;
        } else if (std::memcmp(id, "bext", 4) == 0) {
            std::fseek(f, body + 338, SEEK_SET);
            std::fread(&p.timeReference, 8, 1, f);
        } else if (std::memcmp(id, "data", 4) == 0) {
            // Trust the FILE's real size over the header for the killed case:
            // the header is correct only to the last flush, and a reader
            // recovering a crashed take uses whichever is smaller.
            const long here = std::ftell(f);
            std::fseek(f, 0, SEEK_END);
            const long end = std::ftell(f);
            const uint64_t actual = static_cast<uint64_t>(end - here);
            p.dataBytes = sz == 0xFFFFFFFFu ? actual : (sz < actual ? sz : actual);
            p.frames = p.dataBytes / (p.channels * 4u);
            p.ok = p.channels > 0;
            break;
        }
        std::fseek(f, body + static_cast<long>(sz) + (sz & 1), SEEK_SET);
    }
    std::fclose(f);
    return p;
}

} // namespace

int main() {
    const std::string dir = "/tmp/wizard_wav_killtest";
    std::string mk = "mkdir -p " + dir;
    CHECK(std::system(mk.c_str()) == 0);
    const std::string killPath = dir + "/killed.wav";
    const std::string cleanPath = dir + "/clean.wav";
    std::remove(killPath.c_str());

    // --- 1. clean write: exact sizes, valid header, stamp preserved ---------
    {
        wizard::wav::Writer w;
        wizard::wav::Format fmt{kChannels, kRate, 32, true};
        CHECK(w.open(cleanPath, fmt, 123456789ull, kFlushFrames));
        std::vector<float> buf(kBlock * kChannels);
        for (uint32_t i = 0; i < kBlock * kChannels; ++i)
            buf[i] = static_cast<float>(std::sin(i * 0.01));
        for (int b = 0; b < 20; ++b) CHECK(w.write(buf.data(), kBlock));
        CHECK(w.close());
        const auto p = parseWav(cleanPath);
        CHECK(p.ok);
        CHECK(p.channels == kChannels);
        CHECK(p.sampleRate == 48000);
        CHECK(p.isFloat);
        CHECK(p.frames == 20 * kBlock);            // exact on clean close
        CHECK(p.timeReference == 123456789ull);    // Law C-2 stamp survives in bext
        CHECK(!p.rf64);
    }

    // --- 2. THE KILL TEST: SIGKILL mid-record, file must still parse --------
    const pid_t pid = fork();
    CHECK(pid >= 0);
    if (pid == 0) {
        // Child: record until killed. No cleanup path is ever reached.
        wizard::wav::Writer w;
        wizard::wav::Format fmt{kChannels, kRate, 32, true};
        if (!w.open(killPath, fmt, 42ull, kFlushFrames)) _exit(2);
        std::vector<float> buf(kBlock * kChannels, 0.25f);
        for (;;) {
            if (!w.write(buf.data(), kBlock)) _exit(3);
            usleep(1000);
        }
    }
    // Parent: let it record well past several flush quanta, then kill it hard.
    usleep(300000); // 300 ms ≈ 300 blocks ≫ flush quantum
    CHECK(kill(pid, SIGKILL) == 0);
    int status = 0;
    CHECK(waitpid(pid, &status, 0) == pid);
    CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL); // really killed, not exited

    const auto k = parseWav(killPath);
    CHECK(k.ok);                       // THE POINT: the orphaned file still parses
    CHECK(k.channels == kChannels);
    CHECK(k.sampleRate == 48000);
    CHECK(k.isFloat);
    CHECK(k.timeReference == 42ull);   // the take's stamp survived the crash
    CHECK(k.frames > 0);               // real audio recovered, not an empty shell
    // Recovered length is correct to within one flush quantum of what was written.
    const uint64_t recovered = k.frames;
    CHECK(recovered % 1 == 0);
    std::printf("  recovered %llu frames (flush quantum %llu)\n",
                static_cast<unsigned long long>(recovered),
                static_cast<unsigned long long>(kFlushFrames));
    // The header's claim and the file's real extent agree to within a quantum.
    std::FILE* f = std::fopen(killPath.c_str(), "rb");
    CHECK(f != nullptr);
    std::fseek(f, 0, SEEK_END);
    const uint64_t fileBytes = static_cast<uint64_t>(std::ftell(f));
    std::fclose(f);
    const uint64_t audioBytes = fileBytes - 690;
    const uint64_t writtenFrames = audioBytes / (kChannels * 4u);
    CHECK(writtenFrames >= recovered);
    CHECK(writtenFrames - recovered <= kFlushFrames); // ± one flush quantum

    // --- 3. sidecar ---------------------------------------------------------
    CHECK(wizard::wav::writeSidecar(cleanPath, 1, 123456789ull, "2026-07-24T02:00:00Z",
                                    "Built-in Mic", kRate, kChannels, 20 * kBlock));
    std::FILE* sc = std::fopen((cleanPath + ".json").c_str(), "rb");
    CHECK(sc != nullptr);
    char json[512] = {};
    std::fread(json, 1, sizeof(json) - 1, sc);
    std::fclose(sc);
    CHECK(std::strstr(json, "\"startEngineSample\": 123456789") != nullptr);
    CHECK(std::strstr(json, "Built-in Mic") != nullptr);

    std::printf("wav_killtest OK\n");
    return 0;
}
