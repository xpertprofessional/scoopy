// The MIDI surface's configuration half (S9). Headless: it enumerates whatever
// this machine has — which on a CI box is nothing — so every assertion below is
// about the RULES, not about a particular synth being plugged in.
#include "MidiHost.h"

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
    // ── Ids are STABLE and never collide with "none" ─────────────────────────
    // The whole reason ids are hashed rather than indexed: a selection made
    // today must still name the same device tomorrow, and after another synth
    // is plugged in ahead of it.
    CHECK(MidiHost::idFor("IAC Driver Bus 1") == MidiHost::idFor("IAC Driver Bus 1"));
    CHECK(MidiHost::idFor("a") != MidiHost::idFor("b"));
    CHECK(MidiHost::idFor("IAC Driver Bus 1") > 0); // positive: it indexes nothing
    CHECK(MidiHost::idFor("") == 0);                // empty identifier is "none"
    // 0 is reserved by the protocol for "none"; a real endpoint must never be 0.
    for (const char* s : {"a", "b", "c", "IAC", "Scarlett 18i20", "\xef\xbb\xbf"})
        CHECK(MidiHost::idFor(s) != 0);

    MidiHost h;
    h.refresh(); // whatever this machine has, including nothing

    // ── Roles are independent, and three are sources while one is a destination
    CHECK(h.selected(MidiHost::Role::cc) == 0); // nothing chosen yet
    h.select(MidiHost::Role::cc, 4242);
    CHECK(h.selected(MidiHost::Role::cc) == 4242);
    // Setting one must not move the others — the donor keeps four separate id
    // fields precisely because cc/note/clock are inputs and clockOutput is not.
    CHECK(h.selected(MidiHost::Role::note) == 0);
    CHECK(h.selected(MidiHost::Role::clock) == 0);
    CHECK(h.selected(MidiHost::Role::clockOutput) == 0);

    // ── AN ABSENT DEVICE STAYS SELECTED ─────────────────────────────────────
    // 4242 is not plugged into this machine. The selection must survive that:
    // a device unplugged for ten minutes should still be the chosen one when it
    // returns, and silently clearing it is how a set starts with no MIDI and no
    // explanation. `present()` is how the UI can say "chosen, but absent".
    CHECK(h.selected(MidiHost::Role::cc) == 4242);
    CHECK(!h.present(MidiHost::Role::cc));
    h.refresh(); // a rescan must not clear it either
    CHECK(h.selected(MidiHost::Role::cc) == 4242);

    // ── Deselection is explicit ─────────────────────────────────────────────
    h.select(MidiHost::Role::cc, 0);
    CHECK(h.selected(MidiHost::Role::cc) == 0);
    CHECK(!h.present(MidiHost::Role::cc));

    // ── Enumeration is well-formed, whatever is present ─────────────────────
    for (const auto* list : {&h.sources(), &h.destinations()})
        for (const auto& e : *list) {
            CHECK(e.id != 0);                  // never collides with "none"
            CHECK(e.identifier.isNotEmpty());  // an id derived from nothing is not stable
            CHECK(e.id == MidiHost::idFor(e.identifier));
        }

    // ── A real endpoint, if this machine has one, resolves as present ────────
    if (!h.destinations().isEmpty()) {
        h.select(MidiHost::Role::clockOutput, h.destinations()[0].id);
        CHECK(h.present(MidiHost::Role::clockOutput));
        std::printf("  (saw %d destination(s); checked one resolves)\n",
                    h.destinations().size());
    } else {
        std::printf("  (no MIDI destinations on this machine; rules still checked)\n");
    }

    CHECK(!h.enabled()); // off until asked, like every other hardware door here
    h.setEnabled(true);
    CHECK(h.enabled());

    std::printf("midi_host_test OK\n");
    return 0;
}
