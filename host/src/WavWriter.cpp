#include "WavWriter.h"

#include <cstring>

namespace wizard::wav {

namespace {

constexpr uint64_t kWavSizeLimit = 0xFFFFFFFFull; // 4 GB − 1: past this, RF64
// Header layout (offsets are fixed by construction, so patching is a seek+write):
//   0  "RIFF"      4  riffSize(u32)     8  "WAVE"
//  12  "JUNK"     16  junkSize=28       20  ..28 bytes reserved for ds64..
//  48  "fmt "     52  fmtSize=16        56  ..16 bytes..
//  72  "bext"     76  bextSize=602      80  ..602 bytes..
//  682 "data"    686  dataSize(u32)    690  <audio>
// The JUNK chunk is the RF64 escape hatch: if the file outgrows 4 GB we
// overwrite RIFF→RF64 and JUNK→ds64 in place, with no data movement.
constexpr uint64_t kRiffSizePos = 4;
constexpr uint64_t kJunkPos = 12;
constexpr uint64_t kDs64SizesPos = 20; // riffSize64, dataSize64, sampleCount64
constexpr uint64_t kDataSizePos = 686;
constexpr uint64_t kAudioPos = 690;
constexpr uint32_t kBextSize = 602;

void put32(std::FILE* f, uint32_t v) { std::fwrite(&v, 4, 1, f); }
void put16(std::FILE* f, uint16_t v) { std::fwrite(&v, 2, 1, f); }
void tag(std::FILE* f, const char* t) { std::fwrite(t, 1, 4, f); }

bool patchAt(std::FILE* f, uint64_t pos, const void* data, size_t n) {
    const long cur = std::ftell(f);
    if (std::fseek(f, static_cast<long>(pos), SEEK_SET) != 0) return false;
    const bool ok = std::fwrite(data, 1, n, f) == n;
    std::fseek(f, cur, SEEK_SET);
    return ok;
}

} // namespace

Writer::~Writer() { close(); }

bool Writer::open(const std::string& path, const Format& fmt, uint64_t startEngineSample,
                  uint64_t flushIntervalFrames) {
    close();
    fmt_ = fmt;
    frames_ = 0;
    framesAtLastFlush_ = 0;
    rf64_ = false;
    flushInterval_ = flushIntervalFrames > 0 ? flushIntervalFrames : 1;
    if (fmt_.channels == 0 || fmt_.sampleRate <= 0.0) return false;

    file_ = std::fopen(path.c_str(), "wb+");
    if (file_ == nullptr) return false;

    const uint32_t bytesPerFrame = fmt_.channels * (fmt_.bitsPerSample / 8);

    tag(file_, "RIFF");
    put32(file_, 0); // riffSize — provisional, patched on every flush
    tag(file_, "WAVE");

    // JUNK placeholder (becomes ds64 if we cross 4 GB).
    tag(file_, "JUNK");
    put32(file_, 28);
    for (int i = 0; i < 28; ++i) std::fputc(0, file_);

    tag(file_, "fmt ");
    put32(file_, 16);
    put16(file_, static_cast<uint16_t>(fmt_.floatFormat ? 3 : 1)); // 3 = IEEE float
    put16(file_, static_cast<uint16_t>(fmt_.channels));
    put32(file_, static_cast<uint32_t>(fmt_.sampleRate + 0.5));
    put32(file_, static_cast<uint32_t>(fmt_.sampleRate + 0.5) * bytesPerFrame);
    put16(file_, static_cast<uint16_t>(bytesPerFrame));
    put16(file_, static_cast<uint16_t>(fmt_.bitsPerSample));

    // BWF bext: the take's engine-sample stamp rides in TimeReference, so a
    // take carries its Law C-2 anchor even outside our sidecar/session.
    tag(file_, "bext");
    put32(file_, kBextSize);
    char bext[kBextSize];
    std::memset(bext, 0, sizeof(bext));
    std::snprintf(bext, 256, "Wizard take"); // Description[256]
    std::memcpy(bext + 256, "Wizard", 6);    // Originator[32]
    // TimeReference (u64) at offset 338 = the engine-sample start (Law C-2).
    std::memcpy(bext + 338, &startEngineSample, 8);
    const uint16_t bextVersion = 1;
    std::memcpy(bext + 346, &bextVersion, 2);
    std::fwrite(bext, 1, sizeof(bext), file_);

    tag(file_, "data");
    put32(file_, 0); // dataSize — provisional, patched on every flush
    dataChunkPos_ = kDataSizePos;
    return std::ftell(file_) == static_cast<long>(kAudioPos) && patchSizes();
}

bool Writer::write(const float* interleaved, uint32_t frames) {
    if (file_ == nullptr || interleaved == nullptr || frames == 0) return file_ != nullptr;
    const size_t n = static_cast<size_t>(frames) * fmt_.channels;
    if (std::fwrite(interleaved, sizeof(float), n, file_) != n) return false;
    frames_ += frames;
    // Periodic flush + size patch: this is what makes a SIGKILL survivable.
    if (frames_ - framesAtLastFlush_ >= flushInterval_) {
        framesAtLastFlush_ = frames_;
        if (!patchSizes()) return false;
        std::fflush(file_);
    }
    return true;
}

bool Writer::patchSizes() {
    if (file_ == nullptr) return false;
    const uint32_t bytesPerFrame = fmt_.channels * (fmt_.bitsPerSample / 8);
    const uint64_t dataBytes = frames_ * bytesPerFrame;
    const uint64_t riffBytes = kAudioPos - 8 + dataBytes;

    if (dataBytes > kWavSizeLimit || riffBytes > kWavSizeLimit) {
        // Promote to RF64 in place: RIFF→RF64, JUNK→ds64, 32-bit sizes = -1.
        rf64_ = true;
        if (!patchAt(file_, 0, "RF64", 4)) return false;
        if (!patchAt(file_, kJunkPos, "ds64", 4)) return false;
        const uint32_t neg1 = 0xFFFFFFFFu;
        if (!patchAt(file_, kRiffSizePos, &neg1, 4)) return false;
        if (!patchAt(file_, dataChunkPos_, &neg1, 4)) return false;
        const uint64_t sampleCount = frames_;
        if (!patchAt(file_, kDs64SizesPos, &riffBytes, 8)) return false;
        if (!patchAt(file_, kDs64SizesPos + 8, &dataBytes, 8)) return false;
        if (!patchAt(file_, kDs64SizesPos + 16, &sampleCount, 8)) return false;
        return true;
    }
    const uint32_t riff32 = static_cast<uint32_t>(riffBytes);
    const uint32_t data32 = static_cast<uint32_t>(dataBytes);
    return patchAt(file_, kRiffSizePos, &riff32, 4) &&
           patchAt(file_, dataChunkPos_, &data32, 4);
}

bool Writer::close() {
    if (file_ == nullptr) return true;
    const bool ok = patchSizes();
    std::fflush(file_);
    std::fclose(file_);
    file_ = nullptr;
    return ok;
}

bool writeSidecar(const std::string& wavPath, uint32_t deckId, uint64_t startEngineSample,
                  const std::string& wallClockIso, const std::string& sourceDesc,
                  double sampleRate, uint32_t channels, uint64_t frames) {
    const std::string path = wavPath + ".json";
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (f == nullptr) return false;
    // Hand-rolled JSON (dependency-free). sourceDesc is the only free-text field;
    // escape the characters that would break the document.
    std::string desc;
    for (const char c : sourceDesc) {
        if (c == '"' || c == '\\') desc += '\\';
        if (c == '\n') { desc += "\\n"; continue; }
        desc += c;
    }
    std::fprintf(f,
                 "{\n  \"deckId\": %u,\n  \"startEngineSample\": %llu,\n"
                 "  \"wallClock\": \"%s\",\n  \"sourceDesc\": \"%s\",\n"
                 "  \"sampleRate\": %.6f,\n  \"channels\": %u,\n  \"frames\": %llu\n}\n",
                 deckId, static_cast<unsigned long long>(startEngineSample),
                 wallClockIso.c_str(), desc.c_str(), sampleRate, channels,
                 static_cast<unsigned long long>(frames));
    std::fclose(f);
    return true;
}

} // namespace wizard::wav
