/**
 * P3.5-E8g-d — THE ↻ LOCATOR-REPEAT DOOR'S OWN PATH TO THE SCREEN.
 *
 * The row inherited E8g-a's diagnosis and E8g-a's PRESCRIPTION: "the same
 * one-line fix (`updateRuntime` from the handler)". The diagnosis holds and the
 * prescription does not, and the difference is the whole increment — so it is
 * pinned here rather than argued in a comment.
 *
 *   SAME as E8g-a: the handler `toggleLocatorRepeatTrack` writes the document
 *   and pushes NOTHING at the grid backend. Its only route to the panel was the
 *   binding's session-keyed reload effect, three layers away in another
 *   component — precisely the dependency that made the sample doors
 *   indistinguishable from a dead button.
 *
 *   DIFFERENT from E8g-a: a sample landing is a RUNTIME change
 *   (`toGridRuntime` carries name/sampleKey/durationMs), so `updateRuntime` was
 *   the right verb there. `locatorRepeatActive` is a `toGridPattern` field and
 *   appears NOWHERE in `toGridRuntime`, so `updateRuntime` would repaint every
 *   row and still leave the lamp the user clicked showing the old state. The
 *   first test below is that falsification, driven rather than asserted.
 *
 * ⚠️ WHAT THESE PINS CANNOT SEE. There is no jsdom and no React renderer in this
 * suite, so nothing here proves a SURFACE repainted — they stop at the topic
 * push, exactly as E8g-a's did (P3.5-E8g-f). What they do prove is that the door
 * owns a push at all, which is the property that was missing. The lamp itself is
 * a real-host walk.
 *
 * Runs headless: `publish()` no-ops while the engine is not running and the
 * autosaver only debounces a timer, so nothing here touches OPFS or audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GridBackend } from "./gridBackend.ts";
import { toGridRuntime } from "./gridProjection.ts";
import {
  MAX_DECKS,
  gridDocument,
  idleDeck,
  toggleLocatorRepeatTrack,
  useCompanion,
  type DeckState,
} from "./companionEngine.ts";
import type { GridPatternState } from "../../protocol/schema.ts";
import type { WorkingSession } from "./sessionStore.ts";

/** Three bare tracks — the scaffold a projection needs, nothing more. */
const session = (): WorkingSession =>
  ({
    name: "s",
    pattern: { bpm: 120, sectionA: [{}, {}, {}] },
    kit: { id: "k", name: "kit", samples: [] },
    extras: new Map(),
  }) as unknown as WorkingSession;

function setDeck(deck: number, patch: Partial<DeckState>): void {
  useCompanion.setState((s) => ({
    decks: s.decks.map((d, i) => (i === deck ? { ...d, ...patch } : d)),
  }));
}

function makeBackend() {
  const published: Array<{ topic: string; state: unknown }> = [];
  const backend = new GridBackend({
    publish: (topic, state) => published.push({ topic, state }),
    onEdit: vi.fn(),
    peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
  });
  const runtime = [0, 1, 2].map((i) => ({
    name: `T${i + 1}`,
    sampleKey: null,
    sampleDurationMs: 0,
    samplePeakGain: 1,
  }));
  backend.load(gridDocument(), runtime);
  const patternOf = (i: number): GridPatternState =>
    [...published].reverse().find((p) => p.topic === `gridPattern/${i}`)!.state as GridPatternState;
  const metaOf = () =>
    [...published].reverse().find((p) => p.topic === "gridMeta")!.state as {
      selectedTrackIndex: number;
    };
  return { backend, published, runtime, patternOf, metaOf };
}

beforeEach(() => {
  vi.useFakeTimers();
  useCompanion.setState({ decks: Array.from({ length: MAX_DECKS }, idleDeck), error: null });
  setDeck(0, { session: session(), scene: "A" });
});

afterEach(() => {
  vi.clearAllTimers(); // never let a scheduled autosave actually write
  vi.useRealTimers();
});

describe("the ↻ locator-repeat door", () => {
  it("the row's PROPOSED verb cannot repaint it — `locatorRepeatActive` is not on the runtime wire", () => {
    // Driven, not asserted from the type: `updateRuntime` is exactly what the
    // launch/solo doors call and exactly what E8g-a gave the sample doors, and
    // the whole question this row turns on is whether it carries this field.
    const wire = toGridRuntime({
      name: "T1",
      sampleKey: null,
      sampleDurationMs: 0,
      samplePeakGain: 1,
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(wire)).not.toContain("locatorRepeatActive");

    const { backend, published, runtime } = makeBackend();
    toggleLocatorRepeatTrack(1);
    const before = published.length;
    backend.updateRuntime(runtime);
    // It republished — and touched not one pattern topic, which is where the
    // lamp lives. A door wired this way looks alive in the log and dead on screen.
    const after = published.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((p) => p.topic.startsWith("gridPattern/"))).toEqual([]);
  });

  it("the store handler alone pushes NOTHING — the defect, before the fix", () => {
    // The premise the row asserts, measured rather than inherited. If this ever
    // goes green-by-accident (the store gaining a link), the fix below is moot
    // and this pin is the one that says so.
    const { published } = makeBackend();
    const before = published.length;
    toggleLocatorRepeatTrack(1);
    expect(published.slice(before)).toEqual([]);
  });

  it("flip + `updatePatternRow` puts the new bit on the row's OWN pattern topic", () => {
    const { backend, published, patternOf } = makeBackend();
    expect(patternOf(1).locatorRepeatActive).toBe(false);

    toggleLocatorRepeatTrack(1);
    const before = published.length;
    backend.updatePatternRow(1, gridDocument());

    // Exactly one topic, and it is the touched track's. Republishing the whole
    // document here would risk reverting a drag in flight on another row.
    expect(published.slice(before).map((p) => p.topic)).toEqual(["gridPattern/1"]);
    expect(patternOf(1).locatorRepeatActive).toBe(true);
    // The siblings are untouched — a selection-scoped op the browser deliberately
    // applies single-track (companionEngine.ts:1107).
    expect(patternOf(0).locatorRepeatActive).toBe(false);
    expect(patternOf(2).locatorRepeatActive).toBe(false);

    // And it flips BACK — the second click reads the projected document, not a
    // remembered local bit.
    toggleLocatorRepeatTrack(1);
    backend.updatePatternRow(1, gridDocument());
    expect(patternOf(1).locatorRepeatActive).toBe(false);
  });

  it("the repaint does NOT move the cursor or disarm a lane, the way `load` would", () => {
    // The reason this is a new method instead of a second `load()`. `load` sets
    // `selected = 0` and clears `activeParams` — correct for a NEW document,
    // and a defect of its own on an edit to the open one (P3.5-E8g-e).
    const { backend, published } = makeBackend();
    backend.selectTrack(2);
    backend.setActiveCellParameter(2, "pan");

    toggleLocatorRepeatTrack(2);
    backend.updatePatternRow(2, gridDocument());

    expect(
      ([...published].reverse().find((p) => p.topic === "gridMeta")!.state as {
        selectedTrackIndex: number;
      }).selectedTrackIndex,
    ).toBe(2);
    expect(
      ([...published].reverse().find((p) => p.topic === "gridRuntime/2")!.state as {
        activeCellParameterName: string;
      }).activeCellParameterName,
    ).toBe("pan");
  });

  it("repaints the ACTIVE SCENE's row, not sectionA's, when a later scene is live", () => {
    // `toggleLocatorRepeatTrack` writes scene-aware (scene B+ lands in that
    // scene's section, lazily materialized). `gridDocument` must project the same
    // scene back, or the grid would repaint with a pattern the engine is not
    // playing — the failure mode the binding's `scene` dependency exists for.
    setDeck(0, { scene: "B" });
    const { backend, patternOf } = makeBackend();

    toggleLocatorRepeatTrack(1);
    backend.updatePatternRow(1, gridDocument());
    expect(patternOf(1).locatorRepeatActive).toBe(true);

    // Scene A never saw the flip — proof the write and the repaint agree on WHERE.
    const pattern = useCompanion.getState().decks[0]!.session!.pattern as Record<string, unknown>;
    const sectionA = pattern.sectionA as Record<string, unknown>[];
    expect(sectionA[1]!.locatorRepeatActive).toBeUndefined();
    expect((pattern.sectionB as Record<string, unknown>[])[1]!.locatorRepeatActive).toBe(true);
  });

  it("`gridDocument` on an idle deck is an empty document, so a republish is a no-op", () => {
    const { backend, published } = makeBackend();
    setDeck(0, { session: null });
    const before = published.length;
    backend.updatePatternRow(1, gridDocument());
    // No row ⇒ nothing published. Publishing a default `toGridPattern` over a
    // real one would blank the row instead of leaving it alone.
    expect(published.slice(before)).toEqual([]);
  });
});
