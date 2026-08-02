#include "MidiClockOut.h"

namespace wizard::host {

namespace {
constexpr int kPPQN = 24;              // the MIDI standard, not a choice
constexpr double kMinBpm = 20.0;       // matches the session BPM floor
constexpr double kMaxBpm = 300.0;      // and its ceiling
} // namespace

/** The tick thread. `HighResolutionTimer` because a 120 BPM clock ticks every
    ~20.8 ms and the ordinary message-thread timer is neither that fine nor
    free of the UI's jitter. */
class MidiClockOut::Ticker : public juce::HighResolutionTimer {
public:
    explicit Ticker(juce::MidiOutput& o) : dest(o) {}
    void hiResTimerCallback() override {
        dest.sendMessageNow(juce::MidiMessage::midiClock());
    }

private:
    juce::MidiOutput& dest;
};

MidiClockOut::MidiClockOut() = default;

MidiClockOut::~MidiClockOut() { close(); }

double MidiClockOut::tickIntervalMs(double bpm) {
    const double safe = juce::jlimit(kMinBpm, kMaxBpm, bpm > 0.0 ? bpm : kMinBpm);
    // 60_000 ms per minute / (beats per minute * ticks per beat).
    return 60000.0 / (safe * kPPQN);
}

bool MidiClockOut::open(const juce::String& identifier) {
    close();
    openedId = identifier;
    if (identifier.isEmpty()) return true; // "none" is a valid destination
    out = juce::MidiOutput::openDevice(identifier);
    if (out == nullptr) openedId.clear(); // failed: do not claim to hold it
    return out != nullptr;
}

void MidiClockOut::close() {
    stop();
    ticker.reset();
    out.reset();
    openedId.clear();
}

void MidiClockOut::start(double bpm, bool continueRatherThanRestart) {
    if (out == nullptr) return; // no destination: nothing to say, honestly
    currentBpm = bpm;
    out->sendMessageNow(continueRatherThanRestart ? juce::MidiMessage::midiContinue()
                                                  : juce::MidiMessage::midiStart());
    if (ticker == nullptr) ticker = std::make_unique<Ticker>(*out);
    // `startTimer` takes whole milliseconds; at 300 BPM the interval is ~8.3 ms
    // so rounding costs a few percent of a tick. Rounding rather than
    // truncating keeps the average rate centred on the target instead of
    // running consistently fast.
    ticker->startTimer(juce::roundToInt(tickIntervalMs(currentBpm)));
    isRunning = true;
}

void MidiClockOut::stop() {
    if (ticker != nullptr) ticker->stopTimer();
    // The STOP byte only goes out if we were actually running — a stop sent to
    // a device that never started is noise, and some hardware treats it as a
    // reset.
    if (isRunning && out != nullptr) out->sendMessageNow(juce::MidiMessage::midiStop());
    isRunning = false;
}

void MidiClockOut::setTempo(double bpm) {
    currentBpm = bpm;
    // Deliberately does NOT start anything. A tempo edit while stopped is a
    // preference, not a transport command; starting here would make dragging
    // the master tempo launch the external sequencer.
    if (isRunning && ticker != nullptr)
        ticker->startTimer(juce::roundToInt(tickIntervalMs(currentBpm)));
}

} // namespace wizard::host
