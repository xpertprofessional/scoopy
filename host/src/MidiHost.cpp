#include "MidiHost.h"

namespace wizard::host {

namespace {

juce::Array<MidiHost::Endpoint> convert(const juce::Array<juce::MidiDeviceInfo>& devices) {
    juce::Array<MidiHost::Endpoint> out;
    for (const auto& d : devices) {
        MidiHost::Endpoint e;
        e.id = MidiHost::idFor(d.identifier);
        e.name = d.name;
        e.identifier = d.identifier;
        out.add(e);
    }
    return out;
}

const juce::Array<MidiHost::Endpoint>* listFor(const MidiHost& h, MidiHost::Role r) {
    return r == MidiHost::Role::clockOutput ? &h.destinations() : &h.sources();
}

} // namespace

int MidiHost::idFor(const juce::String& identifier) {
    if (identifier.isEmpty()) return 0;
    // A STABLE id, not an index. An index into a live array changes the moment
    // a device is plugged in ahead of another, which would silently re-point
    // every saved role at somebody else's synth. Hashing the identifier means
    // the id a selection was made against is the id it still has next week.
    //
    // Folded into a positive 31-bit range and never 0, because 0 is "none" in
    // the protocol and a real endpoint must never collide with it.
    const auto h = static_cast<juce::uint32>(identifier.hashCode());
    const int folded = static_cast<int>(h & 0x7fffffffu);
    return folded == 0 ? 1 : folded;
}

void MidiHost::refresh() {
    sourceList = convert(juce::MidiInput::getAvailableDevices());
    destList = convert(juce::MidiOutput::getAvailableDevices());
}

int MidiHost::selected(Role r) const {
    switch (r) {
        case Role::cc: return ccId;
        case Role::note: return noteId;
        case Role::clock: return clockId;
        case Role::clockOutput: return clockOutId;
    }
    return 0;
}

void MidiHost::select(Role r, int deviceId) {
    switch (r) {
        case Role::cc: ccId = deviceId; break;
        case Role::note: noteId = deviceId; break;
        case Role::clock: clockId = deviceId; break;
        case Role::clockOutput: clockOutId = deviceId; break;
    }
}

bool MidiHost::present(Role r) const {
    const int id = selected(r);
    if (id == 0) return false;
    for (const auto& e : *listFor(*this, r))
        if (e.id == id) return true;
    return false;
}

} // namespace wizard::host
