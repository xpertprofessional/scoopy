// Per-source asynchronous sample-rate conversion (P2-03, ARCHITECTURE §2).
//
// Pulls a source ring (an independently-clocked capture stream) onto the engine
// clock. libsamplerate SINC_BEST streaming (D-WZ-ASRC-01), ratio steered by a PI
// controller on (a) the timestamp-derived true source rate and (b) ring-fill
// deviation from target (D-WZ-CLOCK-01: 1.5× quantum). The true source rate is
// discovered from the ring's published {host_time_ns, framesWritten} — NOT from
// the format's reported rate, which hides drift (a device nominally 48000 really
// runs at 48000.3; only the timestamps reveal it).
//
// This is the fix for feasibility §7's number-one failure mode ("my multitrack
// recording is out of sync at the end"): without ASRC a 0.3 Hz drift accrues
// ~1080 samples/hour (~22 ms); the controller holds ring fill — and thus
// alignment — within a millisecond indefinitely.
#pragma once

#include "source_ring.h"

#include <samplerate.h>

#include <cstdint>
#include <vector>

namespace wz {

class SourceAsrc {
public:
    SourceAsrc() = default;
    ~SourceAsrc();
    SourceAsrc(const SourceAsrc&) = delete;
    SourceAsrc& operator=(const SourceAsrc&) = delete;

    // engineRate = output rate; nominalRate = the source's FORMAT-reported rate
    // (what the strip thinks); quantum = engine block, sets target fill.
    bool init(SourceRing* ring, double engineRate, double nominalRate, uint32_t quantum);

    // Produce `frames` engine-rate interleaved output from the ring, running the
    // PI controller. No allocation on this path. Returns frames produced (< frames
    // only on a starved ring — the caller zero-pads / counts it via the ring).
    uint32_t process(float* out, uint32_t frames);

    double driftPpm() const { return driftPpm_; }
    double currentRatio() const { return ratio_; }
    // Test seam (the drift fixture's negative control): off pins the ratio at the
    // NAIVE engineRate/nominalRate — i.e. "trust the reported rate, no drift
    // correction" — so the fixture can prove the controller is what fixes it.
    void setControllerEnabled(bool on) { controllerOn_ = on; }

private:
    static long supplyCb(void* cbData, float** data);
    long supply(float** data);

    SourceRing* ring_ = nullptr;
    SRC_STATE* src_ = nullptr;
    uint32_t channels_ = 0;
    double engineRate_ = 0.0;
    double nominalRate_ = 0.0;
    double targetFill_ = 0.0;
    double ratio_ = 1.0;
    double integral_ = 0.0;
    double driftPpm_ = 0.0;
    bool controllerOn_ = true;

    bool haveBaseline_ = false;
    uint64_t baseHostNs_ = 0;
    uint64_t baseFrames_ = 0;

    std::vector<float> inScratch_; // input chunk pulled from the ring per callback
    uint32_t supplyChunk_ = 0;
};

} // namespace wz
