#pragma once

#include <atomic>
#include <array>
#include <cstdint>
#include <thread>

namespace scoopyloops {

class NativeMidiHost;

/// Sample-accurate MIDI note/CC/pitch-bend output. The sibling of NativeMidiClockOut: where the
/// clock emits 24-PPQN ticks, this emits the sequencer's note-on / note-off / pitch-bend messages
/// for `.midiOut` tracks that target external hardware (no hosted instrument plugin). Events are
/// produced from the native render callback (RT-safe, lock-free ring push) with a host time derived
/// from the block's host time + the in-block frame offset of the step boundary — so notes are
/// phase-locked to the audio sample clock, exactly like the clock, and to each other. A dedicated
/// high-priority sender thread waits to each event's host time (mach_wait_until) and sends via
/// NativeMidiHost.
///
/// This replaces the legacy main-thread poll (BeatSequencer.pumpNativeMidiOut →
/// MIDIOutputEngine.processMIDIStep) which is UI-domain, jittery and can miss steps under load.
/// Notes share the same NativeMidiHost output endpoint as the clock, so clock + notes leave on one
/// coherent destination.
class NativeMidiNoteOut final {
public:
    explicit NativeMidiNoteOut(NativeMidiHost& host);
    ~NativeMidiNoteOut();

    NativeMidiNoteOut(const NativeMidiNoteOut&) = delete;
    NativeMidiNoteOut& operator=(const NativeMidiNoteOut&) = delete;

    /// Enable/disable generation. Starts/stops the sender thread. Safe to call from any thread.
    void setEnabled(bool enabled);
    bool isEnabled() const noexcept { return enabled_.load(std::memory_order_acquire); }

    /// RT-safe. Push a 1–3 byte MIDI message to be sent at (blockHostTime + frameOffset). Called from
    /// the audio render callback. `numBytes` must be 1, 2 or 3. No-op when disabled.
    void pushMessage(std::uint64_t blockHostTime,
                     double sampleRate,
                     std::uint32_t frameOffset,
                     std::uint8_t status,
                     std::uint8_t data1,
                     std::uint8_t data2,
                     int numBytes) noexcept;

private:
    struct Event {
        std::uint8_t bytes[3] { 0, 0, 0 };
        std::uint8_t length = 0;
        std::uint64_t hostTime = 0; // mach_absolute_time deadline
    };

    static constexpr std::size_t kRingSize = 4096; // power of two
    static constexpr std::size_t kRingMask = kRingSize - 1;

    void startSenderThread();
    void stopSenderThread();
    void senderLoop();

    bool pushEvent(const Event& e) noexcept; // producer (audio thread)

    NativeMidiHost& host_;

    std::atomic<bool> enabled_ { false };
    std::atomic<bool> running_ { false };
    std::thread sender_;

    // Lock-free SPSC ring (single audio-thread producer, single sender-thread consumer).
    std::array<Event, kRingSize> ring_ {};
    std::atomic<std::size_t> head_ { 0 }; // consumer reads
    std::atomic<std::size_t> tail_ { 0 }; // producer writes
    std::atomic<std::uint64_t> droppedEvents_ { 0 };

    // mach timebase (nanoseconds → mach units), cached.
    std::uint32_t timebaseNumer_ = 1;
    std::uint32_t timebaseDenom_ = 1;
};

} // namespace scoopyloops
