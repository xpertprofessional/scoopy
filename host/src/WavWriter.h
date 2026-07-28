// Crash-safe BWF/RF64 writer (P3-04, D-WZ-CORE-02).
//
// DEPENDENCY-FREE portable C++ — no JUCE, no platform headers — so a future
// WASM/companion build can reuse it verbatim. The engine never touches files;
// this is fed from the host's RecordService drain thread.
//
// CRASH SAFETY (the wav_killtest contract): a WAV's RIFF/data sizes normally
// can't be known until close, so a killed process leaves a header claiming 0
// bytes and every tool refuses the file. Instead we:
//   1. write the header up-front with PROVISIONAL sizes,
//   2. flush audio + REWRITE the two size fields every `flushIntervalFrames`,
//   3. patch exact sizes on clean close.
// A SIGKILL at any moment therefore leaves a parseable file whose length is
// correct to within one flush quantum. Past the 4 GB WAV limit the file is
// written as RF64 (ds64 chunk carries 64-bit sizes).
//
// BWF: a `bext` chunk carries the take's origination time + the engine-sample
// timestamp (Law C-2's anchor travels inside the audio file itself).
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

namespace wizard::wav {

struct Format {
    uint32_t channels = 2;
    double sampleRate = 48000.0;
    // Float32 is the engine's native buffer format (D-WZ-DSP-01) — takes are
    // written without any quantization, so a take is bit-exact to what the
    // deck holds. (Int24 delivery is an export concern, Parlante's job.)
    uint32_t bitsPerSample = 32;
    bool floatFormat = true;
};

class Writer {
public:
    Writer() = default;
    ~Writer();
    Writer(const Writer&) = delete;
    Writer& operator=(const Writer&) = delete;

    // Opens `path` and writes the provisional header. `startEngineSample` is the
    // take's Law C-2 stamp, embedded in the bext chunk. Returns false on IO
    // failure (an unwritable path must fail loudly, not silently drop a take).
    bool open(const std::string& path, const Format& fmt, uint64_t startEngineSample,
              uint64_t flushIntervalFrames = 24000); // ~0.5 s at 48k

    // Appends interleaved float32 frames. Rewrites the size fields whenever
    // `flushIntervalFrames` have accumulated since the last flush.
    bool write(const float* interleaved, uint32_t frames);

    /** Correct the take's Law C-2 stamp before close.
        The engine only learns the true start at the first render block AFTER
        arming, so `open` necessarily writes a provisional 0. Left uncorrected,
        every take carries TimeReference = 0 and align becomes a no-op — the
        stamp is the whole basis of multitrack (Law C-2). The field sits at a
        fixed offset, so this patches it in place exactly as the size fields are
        patched. */
    void setStartEngineSample(uint64_t startEngineSample);

    // Patches exact sizes and closes. Safe to call twice.
    bool close();

    uint64_t framesWritten() const { return frames_; }
    bool isOpen() const { return file_ != nullptr; }
    /** True once the data chunk passed the 4 GB WAV limit (file is RF64). */
    bool isRf64() const { return rf64_; }

private:
    bool patchSizes();

    std::FILE* file_ = nullptr;
    Format fmt_;
    uint64_t frames_ = 0;
    uint64_t framesAtLastFlush_ = 0;
    uint64_t flushInterval_ = 24000;
    uint64_t dataChunkPos_ = 0; // file offset of the data chunk's size field
    bool rf64_ = false;
};

/** Sidecar metadata written next to the take (`<take>.json`): the fields
    CONCEPT §3 names — deckId, startEngineSample, wallClock, sourceDesc,
    sampleRate, channels. Plain hand-rolled JSON (no dependency).
    `bpmAtStart` (P3-2b-1, MAP-SCHEMA "dual stamps"): the MASTER tempo when
    capture began — the datum a tape needs to state its own bpm later. 0 =
    unknown (a host with no tempo authority), and the field is then OMITTED so
    older sidecars and tempo-less ones are the same shape. */
bool writeSidecar(const std::string& wavPath, uint32_t deckId, uint64_t startEngineSample,
                  const std::string& wallClockIso, const std::string& sourceDesc,
                  double sampleRate, uint32_t channels, uint64_t frames,
                  double bpmAtStart = 0.0);

} // namespace wizard::wav
