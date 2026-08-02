#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

namespace wizard::host {

/**
 * MIDI CLOCK OUT — 24 PPQN, START/STOP, to one destination (S9).
 *
 * WHY THIS AND NOT NOTES FIRST. Note output needs per-track fields
 * (`midiOutEnabled`, `midiRootNote`, `midiGatePercent`, `midiVelocities`,
 * `midiChannel`) to reach the engine, and that table is GENERATED from a pinned
 * source whose own header calls hand-porting it *"the single most dangerous edit
 * in this merge"* — a wrong line writes a field into the wrong parameter
 * silently. Clock needs none of it: tempo and transport are things the app
 * already knows. The donor splits them the same way, into `NativeMidiClockOut`
 * separate from `NativeMidiNoteOut`.
 *
 * WHO OWNS THE TEMPO. Not this class, and not the shell. TS owns the document
 * (the house law), so the tempo and the transport edges are PUSHED down here
 * through the `midiClock` command. A clock that read the tempo from somewhere
 * else would be a second authority, and the two would disagree exactly when a
 * ramp is in flight.
 *
 * ⚠️ TIMER-BASED, AND HONEST ABOUT IT. The donor's native path places ticks at
 * sample-derived host times; this one runs a high-resolution timer, which is
 * what the donor's own legacy path does and what it falls back to when the
 * engine is not rendering. Good enough to drive an external sequencer, and
 * measurably not sample-accurate — recorded here rather than discovered later.
 */
class MidiClockOut {
public:
    // BOTH out-of-line, and that is a requirement rather than a style: `Ticker`
    // is an incomplete type here, so any TU that constructs or destroys a
    // MidiClockOut would otherwise have to instantiate unique_ptr<Ticker>'s
    // deleter and fail. Keeping the implementation in the .cpp is what lets the
    // ticker stay a private detail.
    MidiClockOut();
    ~MidiClockOut();

    /** Point at a destination by JUCE identifier; empty closes it. Returns
        false if the device could not be opened, so the caller can refuse
        honestly instead of pretending to send. */
    bool open(const juce::String& identifier);
    void close();
    bool isOpen() const { return out != nullptr; }
    /** WHICH destination is open. The class remembers its own, so a caller
        deciding whether to re-open does not have to keep a shadow copy that
        could disagree with reality. */
    const juce::String& openedIdentifier() const { return openedId; }

    /** 0xFA START (from the top) or 0xFB CONTINUE, then ticks at `bpm`. */
    void start(double bpm, bool continueRatherThanRestart = false);
    /** 0xFC STOP. Ticking stops; the destination stays open. */
    void stop();
    /** Change tempo while running. No-op when stopped — a stopped clock has no
        tick rate to change, and starting one here would make a tempo edit
        launch the transport. */
    void setTempo(double bpm);

    bool running() const { return isRunning; }
    double tempo() const { return currentBpm; }

    /** THE ONE PIECE OF MATHS, pure and exposed for its test: milliseconds
        between 24-PPQN ticks at `bpm`. Clamped, because the interval is a
        DIVISOR — a 0 bpm arriving from a UI that has not finished loading must
        not become an infinite or zero-length interval spinning a thread. */
    static double tickIntervalMs(double bpm);

private:
    class Ticker;
    std::unique_ptr<juce::MidiOutput> out;
    std::unique_ptr<Ticker> ticker;
    juce::String openedId;
    double currentBpm = 120.0;
    bool isRunning = false;
};

} // namespace wizard::host
