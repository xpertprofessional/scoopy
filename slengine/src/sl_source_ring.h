// Per-source SPSC lock-free ring — the merged tier's copy of wizard's
// engine/src/source_ring.h (P2-02), carried under sl names per SL-ABI-V3 §5/§6
// ("wz_ machinery arrives with sl_ names").
//
// One writer (a host capture thread or the render's drain write), one reader
// (the render thread / a host drain thread). Written interleaved; every write
// carries {host_time_ns, source_rate} so an ASRC can estimate the true source
// clock from timestamp deltas and the ring fill from head−tail. No locks, no
// allocation on the write path.
//
// Overrun policy: capture is a producer we cannot back-pressure — if the reader
// falls behind and the ring fills, the OLDEST unread frames are dropped (tail
// advanced) and counted, so the live signal stays current rather than lagging
// further every block. Underrun (reader outruns writer) yields silence + a
// count.
//
// One deliberate divergence from the donor: write() REFUSES an uninitialised
// ring (capacityFrames == 0) instead of computing `x % 0`. In the donor that
// modulo was dead at -O3 (channels == 0 made the inner loop empty) but is a
// SIGFPE in a Debug build — the overdub drain of a loaded, never-recorded deck
// reached it. Guarding here makes the hazard structurally impossible.
#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

namespace sl {

struct SourceRing {
    std::string key;         // binds a strip's SourceRef to this ring
    uint32_t channels = 0;
    uint64_t capacityFrames = 0; // power-of-two not required; plain modulo
    std::vector<float> buf;      // capacityFrames × channels, interleaved

    // SPSC indices in FRAMES (monotonic; modulo by capacity on access). head =
    // next write position, tail = next read position. head−tail = fill.
    std::atomic<uint64_t> head{0};
    std::atomic<uint64_t> tail{0};

    // Telemetry (relaxed; read by the UI timer thread for HotFrame).
    std::atomic<uint64_t> framesWritten{0};
    std::atomic<uint64_t> overruns{0};  // dropped-oldest events
    std::atomic<uint64_t> underruns{0}; // read-past-write events

    // Seqlock-published clock sample: the host time + source rate at the most
    // recent write, plus the frame count then. A reader gets a torn-free triple.
    std::atomic<uint32_t> clockSeq{0};
    uint64_t lastHostNs = 0;
    double lastRate = 0.0;
    uint64_t framesAtLastWrite = 0;

    void init(const char* k, uint32_t ch, uint64_t cap) {
        key = k != nullptr ? k : "";
        channels = ch;
        capacityFrames = cap;
        buf.assign(static_cast<size_t>(cap) * ch, 0.0f);
        head.store(0, std::memory_order_relaxed);
        tail.store(0, std::memory_order_relaxed);
        framesWritten.store(0, std::memory_order_relaxed);
        overruns.store(0, std::memory_order_relaxed);
        underruns.store(0, std::memory_order_relaxed);
        clockSeq.store(0, std::memory_order_relaxed);
        lastHostNs = 0;
        lastRate = 0.0;
        framesAtLastWrite = 0;
    }

    void publishClock(uint64_t hostNs, double rate, uint64_t framesNow) {
        clockSeq.fetch_add(1, std::memory_order_release); // odd = writing
        lastHostNs = hostNs;
        lastRate = rate;
        framesAtLastWrite = framesNow;
        clockSeq.fetch_add(1, std::memory_order_release); // even = stable
    }

    void readClock(uint64_t& hostNs, double& rate, uint64_t& framesNow) const {
        for (;;) {
            const uint32_t s0 = clockSeq.load(std::memory_order_acquire);
            if (s0 & 1u) continue;
            hostNs = lastHostNs;
            rate = lastRate;
            framesNow = framesAtLastWrite;
            if (clockSeq.load(std::memory_order_acquire) == s0) return;
        }
    }

    // Writer. Interleaved `frames`×channels. RT-safe. An uninitialised ring
    // refuses the write (see header comment) — the caller's bug is dropped
    // audio, never a fault.
    void write(const float* interleaved, uint32_t frames, double rate, uint64_t hostNs) {
        if (frames == 0 || capacityFrames == 0 || channels == 0) return;
        const uint64_t cap = capacityFrames;
        uint64_t h = head.load(std::memory_order_relaxed);
        const uint64_t t = tail.load(std::memory_order_acquire);
        const uint64_t fill = h - t;
        // Drop-oldest if this block would overflow: advance tail past the
        // oldest frames so the newest always land (capture stays current).
        if (fill + frames > cap) {
            const uint64_t need = fill + frames - cap;
            tail.store(t + need, std::memory_order_release);
            overruns.fetch_add(1, std::memory_order_relaxed);
        }
        for (uint32_t i = 0; i < frames; ++i) {
            const uint64_t slot = (h + i) % cap;
            for (uint32_t ch = 0; ch < channels; ++ch)
                buf[static_cast<size_t>(slot) * channels + ch] =
                    interleaved[static_cast<size_t>(i) * channels + ch];
        }
        head.store(h + frames, std::memory_order_release);
        const uint64_t fw = framesWritten.load(std::memory_order_relaxed) + frames;
        framesWritten.store(fw, std::memory_order_relaxed);
        publishClock(hostNs, rate, fw);
    }

    // Reader. Reads up to `frames`; short reads zero the tail and count an
    // underrun. Returns frames actually available. RT-safe.
    uint32_t read(float* outInterleaved, uint32_t frames) {
        const uint64_t cap = capacityFrames;
        const uint64_t t = tail.load(std::memory_order_relaxed);
        const uint64_t h = head.load(std::memory_order_acquire);
        const uint64_t avail = h - t;
        const uint32_t n = avail < frames ? static_cast<uint32_t>(avail) : frames;
        for (uint32_t i = 0; i < n; ++i) {
            const uint64_t slot = (t + i) % cap;
            for (uint32_t ch = 0; ch < channels; ++ch)
                outInterleaved[static_cast<size_t>(i) * channels + ch] =
                    buf[static_cast<size_t>(slot) * channels + ch];
        }
        for (uint32_t i = n; i < frames; ++i)
            for (uint32_t ch = 0; ch < channels; ++ch)
                outInterleaved[static_cast<size_t>(i) * channels + ch] = 0.0f;
        tail.store(t + n, std::memory_order_release);
        if (n < frames) underruns.fetch_add(1, std::memory_order_relaxed);
        return n;
    }

    uint64_t fillFrames() const {
        return head.load(std::memory_order_acquire) - tail.load(std::memory_order_acquire);
    }
    // Monotonic totals — no sawtooth, for measuring consumption/feed RATES.
    uint64_t consumedTotal() const { return tail.load(std::memory_order_acquire); }
    uint64_t writtenTotal() const { return framesWritten.load(std::memory_order_relaxed); }
};

} // namespace sl
