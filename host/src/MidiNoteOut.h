#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <array>
#include <mutex>

namespace wizard::host {

/**
 * MIDI NOTE OUT — the lane, and the bookkeeping that keeps notes from hanging (S9).
 *
 * ⚠️ THIS IS THE OUTPUT LANE ONLY. Nothing generates notes yet: that needs the
 * five per-track world fields (`midiOutEnabled`, `midiRootNote`,
 * `midiGatePercent`, `midiVelocities`, `midiChannel`) to reach the engine
 * through a table that is GENERATED from a pinned source — the edit that
 * generator's own header calls *"the single most dangerous edit in this merge"*.
 * So the lane is built and proved first, and the generator work lands against
 * something already known to work rather than both being unknown at once.
 *
 * THE TWO RULES THAT MATTER, both taken from the donor's `serviceMidiVoice`:
 *
 *   1. A NOTE-OFF ALWAYS PRECEDES THE NOTE-ON THAT REPLACES IT. Retriggering a
 *      held note without releasing it first leaves the receiving synth holding
 *      a voice forever — the note plays, the pattern moves on, and the sound
 *      never stops. The donor services expiries *before* new hits for exactly
 *      this reason, and says so in its comment.
 *   2. NOTHING HANGS. Stopping, closing, changing device, or dropping this
 *      object releases every held note. A hanging note survives the app that
 *      caused it, which makes it the one MIDI bug a user cannot undo from
 *      inside our UI.
 *
 * The donor counts gates down in SAMPLE FRAMES because it lives in the audio
 * core. This lane is host-side and counts in MILLISECONDS — honest about being
 * timer-resolution rather than pretending to sample accuracy it cannot have.
 */

/** Which notes are held and until when. PURE — no device, no clock, no JUCE
    timer — so every rule above is testable by moving a number forward. */
class NoteBook {
public:
    /** The donor's `kMaxMidiHeldNotes`. A bounded table rather than a growing
        container: this is serviced on a timer beside an audio thread, and an
        allocation there is the other classic way MIDI goes wrong. */
    static constexpr int kMaxHeld = 16;

    struct Held {
        int channel = -1; ///< 0-15; -1 = empty slot
        int note = -1;    ///< 0-127
        double untilMs = 0.0;
    };

    /** Release info for one note. */
    struct Release {
        int channel;
        int note;
    };

    /** Is this exact (channel, note) currently held? */
    bool isHeld(int channel, int note) const;

    /** Hold it until `untilMs`. If it is ALREADY held this returns true in
        `retriggered`, and the caller MUST send a note-off first (rule 1).
        Returns false when the table is full — the caller drops the note rather
        than evicting someone else's, because a dropped note is silence and an
        evicted one is a hang. */
    bool hold(int channel, int note, double untilMs, bool& retriggered);

    /** Everything due at or before `nowMs`, removed from the book. */
    juce::Array<Release> expire(double nowMs);

    /** Everything, removed. For stop / close / panic. */
    juce::Array<Release> releaseAll();

    int heldCount() const;

private:
    std::array<Held, kMaxHeld> slots{};
};

/** The lane itself: a destination plus the book, serviced on a timer. */
class MidiNoteOut {
public:
    MidiNoteOut();
    ~MidiNoteOut();

    /** Empty identifier closes. Releases every held note first — changing
        device with notes down is one of the ways they hang. */
    bool open(const juce::String& identifier);
    void close();
    /** Guarded like everything else that reads shared state — see `lock`. */
    bool isOpen() const;
    juce::String openedIdentifier() const;

    /** Note-on now, note-off after `gateMs`. Sends the release of a retrigger
        before the new hit, per rule 1. */
    void play(int channel, int note, int velocity, double gateMs);

    /** Release everything, now. */
    void allNotesOff();

    int heldCount() const;

private:
    class Servicer;
    /** ⚠️ `book` AND the device are touched from TWO threads: the caller's
     *  (play / allNotesOff / close) and the servicer's timer. Without this the
     *  two mutate the slot table concurrently — undefined behaviour whose
     *  cheapest symptom is a note released twice and whose worst is one never
     *  released at all, which is precisely the hang rule 2 exists to prevent.
     *
     *  A MUTEX IS LEGITIMATE HERE, and it is worth saying why: this lane is
     *  host-side and runs on a timer, NOT on the audio thread. The donor's
     *  equivalent lives in the audio core and must be lock-free; this one has
     *  no such constraint, and a lock-free scheme bought nothing but a harder
     *  proof. If this ever moves onto the render thread, that changes. */
    mutable std::mutex lock;
    NoteBook book;
    std::unique_ptr<juce::MidiOutput> out;
    std::unique_ptr<Servicer> servicer;
    juce::String openedId;

    void sendOff(int channel, int note);
    void service();
    friend class Servicer;
};

} // namespace wizard::host
