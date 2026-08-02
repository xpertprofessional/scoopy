#include "MidiNoteOut.h"

namespace wizard::host {

// ─────────────────────────────────────────────────────────────────────────────
// NoteBook — pure
// ─────────────────────────────────────────────────────────────────────────────

bool NoteBook::isHeld(int channel, int note) const {
    for (const auto& s : slots)
        if (s.channel == channel && s.note == note) return true;
    return false;
}

bool NoteBook::hold(int channel, int note, double untilMs, bool& retriggered) {
    retriggered = false;
    // Same note again: reuse the slot and extend the gate. The caller sends the
    // note-off first (rule 1) — taking a SECOND slot here would be the bug,
    // because then only one of the two would ever be released.
    for (auto& s : slots) {
        if (s.channel == channel && s.note == note) {
            retriggered = true;
            s.untilMs = untilMs;
            return true;
        }
    }
    for (auto& s : slots) {
        if (s.channel < 0) {
            s = {channel, note, untilMs};
            return true;
        }
    }
    // FULL. Drop the new note rather than evicting a held one: a dropped note
    // is silence, an evicted one is a note nobody will ever release.
    return false;
}

juce::Array<NoteBook::Release> NoteBook::expire(double nowMs) {
    juce::Array<Release> out;
    for (auto& s : slots) {
        if (s.channel < 0) continue;
        if (s.untilMs > nowMs) continue;
        out.add({s.channel, s.note});
        s = {};
        s.channel = -1;
        s.note = -1;
    }
    return out;
}

juce::Array<NoteBook::Release> NoteBook::releaseAll() {
    juce::Array<Release> out;
    for (auto& s : slots) {
        if (s.channel < 0) continue;
        out.add({s.channel, s.note});
        s = {};
        s.channel = -1;
        s.note = -1;
    }
    return out;
}

int NoteBook::heldCount() const {
    int n = 0;
    for (const auto& s : slots)
        if (s.channel >= 0) ++n;
    return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// MidiNoteOut
// ─────────────────────────────────────────────────────────────────────────────

/** Services expiries. 2 ms is finer than any musical gate and cheap; the
    resolution limit is stated in the header rather than implied. */
class MidiNoteOut::Servicer : public juce::HighResolutionTimer {
public:
    explicit Servicer(MidiNoteOut& o) : owner(o) {}
    void hiResTimerCallback() override { owner.service(); }

private:
    MidiNoteOut& owner;
};

MidiNoteOut::MidiNoteOut() = default;

MidiNoteOut::~MidiNoteOut() { close(); }

bool MidiNoteOut::open(const juce::String& identifier) {
    close(); // releases anything held — never change device with notes down
    openedId = identifier;
    if (identifier.isEmpty()) return true; // "none" is a valid destination
    out = juce::MidiOutput::openDevice(identifier);
    if (out == nullptr) {
        openedId.clear();
        return false;
    }
    servicer = std::make_unique<Servicer>(*this);
    servicer->startTimer(2);
    return true;
}

void MidiNoteOut::close() {
    allNotesOff();
    if (servicer != nullptr) servicer->stopTimer();
    servicer.reset();
    out.reset();
    openedId.clear();
}

void MidiNoteOut::sendOff(int channel, int note) {
    if (out == nullptr) return;
    out->sendMessageNow(juce::MidiMessage::noteOff(channel + 1, note));
}

void MidiNoteOut::service() {
    const double now = juce::Time::getMillisecondCounterHiRes();
    for (const auto& r : book.expire(now)) sendOff(r.channel, r.note);
}

void MidiNoteOut::play(int channel, int note, int velocity, double gateMs) {
    if (out == nullptr) return; // nowhere to send: say nothing, honestly
    const int ch = juce::jlimit(0, 15, channel);
    const int n = juce::jlimit(0, 127, note);
    const int v = juce::jlimit(1, 127, velocity); // 0 would BE a note-off

    bool retriggered = false;
    const double until = juce::Time::getMillisecondCounterHiRes() + juce::jmax(1.0, gateMs);
    if (!book.hold(ch, n, until, retriggered)) return; // full: drop, never evict

    // RULE 1, and the order is the whole point: release the old voice BEFORE
    // articulating the new one, or the synth holds a voice nothing will ever
    // release.
    if (retriggered) sendOff(ch, n);
    out->sendMessageNow(juce::MidiMessage::noteOn(ch + 1, n, static_cast<juce::uint8>(v)));
}

void MidiNoteOut::allNotesOff() {
    for (const auto& r : book.releaseAll()) sendOff(r.channel, r.note);
}

} // namespace wizard::host
