// The note lane's bookkeeping (S9). Headless and device-free: `NoteBook` is
// pure, so every rule is checked by moving a number forward rather than by
// plugging in a synth and listening for something that should have stopped.
//
// A hanging note is the one MIDI bug a user cannot undo from inside our UI —
// it survives the app that caused it. That is why this is tested at all.
#include "MidiNoteOut.h"

#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

using namespace wizard::host;

int main() {
    // ── Gates expire when due, and NOT before ───────────────────────────────
    {
        NoteBook b;
        bool re = false;
        CHECK(b.hold(0, 60, 100.0, re));
        CHECK(!re);
        CHECK(b.isHeld(0, 60));
        CHECK(b.expire(99.9).isEmpty()); // not yet — an early release is a clipped note
        CHECK(b.heldCount() == 1);
        const auto due = b.expire(100.0); // inclusive: due AT the deadline
        CHECK(due.size() == 1);
        CHECK(due[0].channel == 0 && due[0].note == 60);
        CHECK(!b.isHeld(0, 60));
        CHECK(b.heldCount() == 0);
    }

    // ── RULE 1: a retrigger REUSES the slot and reports itself ──────────────
    // Taking a second slot would be the bug: only one of the two would ever be
    // released, and the other is a note held forever.
    {
        NoteBook b;
        bool re = false;
        CHECK(b.hold(0, 60, 100.0, re));
        CHECK(!re);
        CHECK(b.hold(0, 60, 200.0, re));
        CHECK(re);                    // the caller must send note-off first
        CHECK(b.heldCount() == 1);    // ONE slot, not two
        CHECK(b.expire(150.0).isEmpty()); // and the gate EXTENDED to 200
        CHECK(b.isHeld(0, 60));
        CHECK(b.expire(200.0).size() == 1);
    }

    // ── Channel and note are both part of identity ──────────────────────────
    {
        NoteBook b;
        bool re = false;
        b.hold(0, 60, 100.0, re);
        b.hold(1, 60, 100.0, re);
        CHECK(!re);                 // same note, different channel = different voice
        b.hold(0, 61, 100.0, re);
        CHECK(!re);
        CHECK(b.heldCount() == 3);
        CHECK(b.isHeld(1, 60) && b.isHeld(0, 61));
        CHECK(!b.isHeld(1, 61));
    }

    // ── Only what is DUE is released ────────────────────────────────────────
    {
        NoteBook b;
        bool re = false;
        b.hold(0, 60, 50.0, re);
        b.hold(0, 62, 150.0, re);
        b.hold(0, 64, 250.0, re);
        const auto first = b.expire(150.0);
        CHECK(first.size() == 2); // 60 and 62; 64 is not due
        CHECK(b.heldCount() == 1);
        CHECK(b.isHeld(0, 64));
    }

    // ── FULL drops the newcomer; it never evicts a held voice ───────────────
    // A dropped note is silence. An evicted one is a note nobody will release.
    {
        NoteBook b;
        bool re = false;
        for (int i = 0; i < NoteBook::kMaxHeld; ++i) CHECK(b.hold(0, 40 + i, 1000.0, re));
        CHECK(b.heldCount() == NoteBook::kMaxHeld);
        CHECK(!b.hold(0, 100, 1000.0, re)); // refused
        CHECK(b.heldCount() == NoteBook::kMaxHeld);
        for (int i = 0; i < NoteBook::kMaxHeld; ++i) CHECK(b.isHeld(0, 40 + i)); // all survive
        // …but a RETRIGGER of an already-held note still works when full: it
        // needs no new slot, and refusing it would drop notes mid-chord.
        CHECK(b.hold(0, 40, 2000.0, re));
        CHECK(re);
    }

    // ── RULE 2: NOTHING HANGS ───────────────────────────────────────────────
    {
        NoteBook b;
        bool re = false;
        b.hold(0, 60, 1e9, re); // a gate that would outlive the session
        b.hold(3, 72, 1e9, re);
        const auto all = b.releaseAll();
        CHECK(all.size() == 2);
        CHECK(b.heldCount() == 0);
        CHECK(b.releaseAll().isEmpty()); // idempotent — a second panic is safe
    }

    // ── The lane refuses honestly with no destination ───────────────────────
    {
        MidiNoteOut lane;
        CHECK(!lane.isOpen());
        CHECK(lane.open("")); // "none" is a valid selection
        CHECK(!lane.isOpen());
        lane.play(0, 60, 100, 250.0);
        // Nothing was sent, so nothing may be recorded as held — a book that
        // fills while the lane is closed would fire note-offs at a device that
        // never heard the note-ons.
        CHECK(lane.heldCount() == 0);
        CHECK(!lane.open("no-such-device-identifier"));
        lane.allNotesOff(); // safe with nothing open and nothing held
    }

    std::printf("midi_note_test OK\n");
    return 0;
}
