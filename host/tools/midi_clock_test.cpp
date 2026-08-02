// MIDI clock out (S9). Headless: the tick MATHS and the state rules, which are
// the parts that can be wrong in ways no amount of listening would reveal —
// a clock running 4% fast sounds fine alone and drifts apart over a set.
#include "MidiClockOut.h"

#include <cmath>
#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

using namespace wizard::host;

static bool near(double a, double b, double eps = 1e-6) { return std::fabs(a - b) < eps; }

int main() {
    // ── 24 PPQN, against numbers worked by hand ─────────────────────────────
    // 120 BPM = 2 beats/s = 48 ticks/s = 20.8333… ms.
    CHECK(near(MidiClockOut::tickIntervalMs(120.0), 60000.0 / (120.0 * 24.0)));
    CHECK(near(MidiClockOut::tickIntervalMs(120.0), 20.833333, 1e-5));
    // 60 BPM = 1 beat/s = 24 ticks/s = exactly 41.666… ms.
    CHECK(near(MidiClockOut::tickIntervalMs(60.0), 41.666666, 1e-5));
    // Twice the tempo is half the interval — the property that matters more
    // than any single value.
    CHECK(near(MidiClockOut::tickIntervalMs(140.0) * 2.0, MidiClockOut::tickIntervalMs(70.0)));

    // ── THE DIVISOR IS GUARDED ──────────────────────────────────────────────
    // A 0 arriving from a UI mid-load must not become an infinite interval, and
    // a negative must not invert the clock. Both clamp to the floor rather than
    // producing something a timer would spin on.
    CHECK(MidiClockOut::tickIntervalMs(0.0) > 0.0);
    CHECK(std::isfinite(MidiClockOut::tickIntervalMs(0.0)));
    CHECK(near(MidiClockOut::tickIntervalMs(0.0), MidiClockOut::tickIntervalMs(20.0)));
    CHECK(near(MidiClockOut::tickIntervalMs(-50.0), MidiClockOut::tickIntervalMs(20.0)));
    CHECK(std::isfinite(MidiClockOut::tickIntervalMs(1e9)));
    CHECK(near(MidiClockOut::tickIntervalMs(1e9), MidiClockOut::tickIntervalMs(300.0)));

    // ── State rules, with no device attached ────────────────────────────────
    MidiClockOut clock;
    CHECK(!clock.isOpen());
    CHECK(!clock.running());

    // "none" is a valid destination, and opening it is not a failure.
    CHECK(clock.open(""));
    CHECK(!clock.isOpen());

    // Starting with no destination must not pretend to run — there is nothing
    // to send to, and a `running` clock that emits nothing is the kind of lie
    // that makes someone debug their synth instead of their routing.
    clock.start(128.0);
    CHECK(!clock.running());

    // A tempo edit while stopped is a PREFERENCE, not a transport command.
    // Starting the external sequencer because someone dragged the master tempo
    // would be the worst possible interpretation of that gesture.
    clock.setTempo(150.0);
    CHECK(!clock.running());
    CHECK(near(clock.tempo(), 150.0));

    // An unknown device fails honestly rather than silently half-opening.
    CHECK(!clock.open("no-such-device-identifier"));
    CHECK(!clock.isOpen());

    // Stop on a never-started clock is safe and stays not-running.
    clock.stop();
    CHECK(!clock.running());

    std::printf("midi_clock_test OK\n");
    return 0;
}
