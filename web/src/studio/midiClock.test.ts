import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * S9 — the clock's door, and the four send rules it exists to keep.
 *
 * Source-text, in the house idiom, for the standing reason: no jsdom and no
 * React renderer (P3.5-E8g-f), so a hook cannot be mounted and driven. What is
 * mechanically checkable is that the DECISIONS are still the ones argued for —
 * and each of these, got wrong, is a clock that disagrees with the transport in
 * a way only a listener in the room would notice.
 */

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const SRC = read("src/studio/useMidiClock.ts");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("useMidiClock — the clock follows the transport", () => {
  it("Studio mounts it — the lane had NO caller before this", () => {
    // The whole point. `midiClock` and host/MidiClockOut were built, tested and
    // protocol-reachable, and nothing invoked them: a user could not start the
    // clock at all. A test that only checked the hook's internals would have
    // been just as green while the feature stayed unreachable.
    const face = read("src/studio/StudioPanel.tsx");
    expect(face).toContain("useMidiClock(link, DECK)");
  });

  it("sends nothing on mount while stopped", () => {
    // A `stop` issued because a window opened is not a thing the user did — and
    // on a second Studio window it would stop the clock the first is running.
    expect(CODE).toMatch(/last === null && !playing/);
  });

  it("starts rather than continues", () => {
    // The store's play() restarts at step 0, so the phrase begins again and the
    // receiving sequencer must too. CONTINUE would leave it a bar into a
    // pattern that just went back to the top.
    expect(CODE).toContain("'start'");
    expect(CODE).not.toContain("'continue'");
  });

  it("pushes tempo only while RUNNING", () => {
    // Matches the lane's own rule: a tempo edit is a preference, not a
    // transport command. Sending it while stopped would be harmless today and
    // would silently become a start the moment the lane's guard moved.
    expect(CODE).toMatch(/playing && last\.bpm !== masterBpm/);
  });

  it("stops on unmount, so nothing keeps ticking after the window goes", () => {
    // The transport equivalent of the hanging note MidiNoteOut guards against:
    // an external sequencer still playing to a driver that no longer exists.
    expect(CODE).toMatch(/return \(\) => \{[\s\S]*op: 'stop'/);
  });

  it("does NOT decide whether MIDI is set up — the shell already knows", () => {
    // With no clockOutput role selected the shell opens nothing and start()
    // returns early. Duplicating that here would be two places deciding when
    // the clock may run, and they would drift.
    expect(CODE).not.toContain("enumerateMidiEndpoints");
    expect(CODE).not.toContain("clockOutput");
  });

  it("reads the STORE's tempo, not the persisted setting", () => {
    // The store is what applyTempo resolves against, so the clock and the
    // engine stretch to the same number. The setting is only where it is
    // remembered, and the two differ while a write is in flight.
    expect(CODE).toContain("useMapStore");
  });
});
