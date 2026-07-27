#pragma once

#include <atomic>
#include <array>
#include <cstdint>
#include <thread>

namespace scoopyloops {

class NativeMidiHost;

/// Sample-accurate MIDI clock-out generator. Fed once per audio block from the native render
/// callback (`feedBlock`, RT-safe) with the block's host time, sample rate, transport state and
/// audible BPM. It places 24-PPQN clock ticks (0xF8) at sample-derived host times — so the clock
/// is phase-locked to the audio sample clock and cannot drift relative to what's heard — plus
/// START (0xFA) / STOP (0xFC) on transport edges. The clock FREE-RUNS: ticks flow continuously
/// whenever enabled, including while the transport is stopped (so a slave can pre-lock the tempo
/// before playback starts); the tick grid re-phases to the transport start on the play edge so the
/// downbeat stays tightly aligned. Events are pushed to a lock-free SPSC ring and
/// emitted by a dedicated high-priority sender thread that waits to each event's host time
/// (mach_wait_until) before sending via NativeMidiHost. This replaces the legacy DispatchSourceTimer
/// clock (UI-domain, jittery, drifts vs audio, restarts on tempo change).
class NativeMidiClockOut final {
public:
    explicit NativeMidiClockOut(NativeMidiHost& host);
    ~NativeMidiClockOut();

    NativeMidiClockOut(const NativeMidiClockOut&) = delete;
    NativeMidiClockOut& operator=(const NativeMidiClockOut&) = delete;

    /// Enable/disable generation. Starts/stops the sender thread. Safe to call from any thread.
    void setEnabled(bool enabled);
    bool isEnabled() const noexcept { return enabled_.load(std::memory_order_acquire); }

    /// Called once per audio block from the render callback. RT-safe (lock-free ring push only).
    /// `blockHostTime` is mach_absolute_time() for the start of this block; `bpm` is the audible
    /// tempo (already including master speed / sync).
    void feedBlock(std::uint64_t blockHostTime,
                   double sampleRate,
                   std::uint32_t numSamples,
                   bool isPlaying,
                   double bpm) noexcept;

private:
    struct Event {
        std::uint8_t status;       // 0xF8 clock, 0xFA start, 0xFC stop
        std::uint64_t hostTime;    // mach_absolute_time deadline
    };

    static constexpr std::size_t kRingSize = 2048; // power of two
    static constexpr std::size_t kRingMask = kRingSize - 1;

    void startSenderThread();
    void stopSenderThread();
    void senderLoop();

    bool pushEvent(std::uint8_t status, std::uint64_t hostTime) noexcept; // producer (audio thread)

    NativeMidiHost& host_;

    std::atomic<bool> enabled_ { false };
    std::atomic<bool> running_ { false };
    std::thread sender_;

    // Lock-free SPSC ring (single audio-thread producer, single sender-thread consumer).
    std::array<Event, kRingSize> ring_ {};
    std::atomic<std::size_t> head_ { 0 }; // consumer reads
    std::atomic<std::size_t> tail_ { 0 }; // producer writes
    std::atomic<std::uint64_t> droppedEvents_ { 0 };

    // Producer-only transport/clock state (touched solely on the audio thread).
    bool wasPlaying_ = false;
    double blockFrame_ = 0.0;     // absolute frames processed since transport start
    double nextTickFrame_ = 0.0;  // absolute frame of the next 24-PPQN tick

    // mach timebase (nanoseconds → mach units), cached.
    std::uint32_t timebaseNumer_ = 1;
    std::uint32_t timebaseDenom_ = 1;
};

} // namespace scoopyloops
