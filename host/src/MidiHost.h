#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

namespace wizard::host {

/**
 * THE MIDI SURFACE — devices, roles, and what is selected (S9, ledger B8).
 *
 * ⚠️ WHAT THE MERGED APP HAD BEFORE THIS: nothing. `slengine` contains zero
 * occurrences of "midi", `SlDispatch.cpp` answered none of the eleven MIDI
 * methods, and `MergedLink.NATIVE_METHODS` routed none of them — so
 * `MidiPanel.tsx`, which is a full donor-parity pane, rendered "loading
 * endpoints…" forever. The protocol has been fully specified since v-early and
 * answered by nobody, which is the exact defect class `nativemethods:check`
 * exists to catch, seen from the other side.
 *
 * THIS IS THE CONFIGURATION HALF ONLY, deliberately, and it says so where it
 * matters. It enumerates real CoreMIDI endpoints and remembers which one has
 * which role. It does NOT yet emit a note, a clock, or read one — that needs an
 * engine MIDI surface which does not exist, and `ScoopyPluginProcessor.h`
 * already records the same wall: *"THE ENGINE HAS NO MIDI SURFACE AT ALL — no
 * note door, no live-trigger door."* Claiming otherwise would put a lit control
 * in front of silence, which is what the four rules are about.
 *
 * ROLES, from the donor's `MIDIManager`: `cc` and `note` are INPUT sources,
 * `clock` is an input source, `clockOutput` is a DESTINATION. Three of the four
 * name a source and one names a destination, which is easy to get backwards —
 * the donor keeps them as four separate id fields for that reason and so does
 * this.
 *
 * ID 0 IS "NONE", per the protocol. A real endpoint never gets id 0: ids are
 * assigned from a stable hash of the endpoint identifier so a selection
 * survives a rescan, a reboot, and a device being unplugged and returned —
 * which an index into a live array does not.
 */
class MidiHost {
public:
    struct Endpoint {
        int id = 0;               ///< stable, non-zero; 0 means "none"
        juce::String name;        ///< what a person sees
        juce::String identifier;  ///< CoreMIDI's own, what `id` is derived from
    };

    enum class Role { cc, note, clock, clockOutput };

    /** Re-scan CoreMIDI. Safe to call often; selections survive it by id. */
    void refresh();

    const juce::Array<Endpoint>& sources() const { return sourceList; }
    const juce::Array<Endpoint>& destinations() const { return destList; }

    /** 0 = none. An id that is no longer present stays SELECTED rather than
        being cleared — a device unplugged for ten minutes should still be the
        chosen one when it comes back, and silently forgetting it is how a set
        starts with no MIDI and no explanation. */
    int selected(Role r) const;
    void select(Role r, int deviceId);

    bool enabled() const { return isEnabled; }
    void setEnabled(bool e) { isEnabled = e; }

    /** Whether the selection currently resolves to a device that is plugged in.
        The honest half of `selected()` — the UI can say "chosen but absent". */
    bool present(Role r) const;

    juce::String syncMode = "internalMaster";
    juce::String slaveTransportPolicy = "fullTransport";

    /** The stable id for an endpoint identifier. Exposed for its test: the
        whole point is that it does not change between runs. */
    static int idFor(const juce::String& identifier);

private:
    juce::Array<Endpoint> sourceList, destList;
    int ccId = 0, noteId = 0, clockId = 0, clockOutId = 0;
    bool isEnabled = false;
};

} // namespace wizard::host
