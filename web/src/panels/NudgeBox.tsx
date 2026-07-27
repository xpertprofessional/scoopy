import { useEffect, useRef, useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import "./nudge.css";

/**
 * Sync NUDGE — a MOMENTARY performance gesture, not a stored parameter: HOLD < or >
 * to push the deck behind / ahead of the locked rate, and the delta keeps ramping for
 * as long as the button is held; RELEASE and it snaps back to lock (Swift applies the
 * delta on top of the sync rate and never touches bpm/originalBpm —
 * `BeatSequencer.applyDJNudge`). That release-snap is why this can't be a persistent
 * value: it would leave the deck silently drifting off the grid for the rest of the set.
 *
 * Hold-to-ramp (not drag): mirrors native `DeckNudgeButton` — a 25 Hz timer accumulates
 * 0.3 BPM per tick (7.5 BPM/s) while held, clamped to the schema's ±20. Two arrow buttons
 * replace the old ew-drag surface so the gesture reads as a transport control, not a slider.
 *
 * Single home = the deck's TRANSPORT box (djmode.md §4C). It is a transport/sync gesture,
 * it lives beside SYNC and the pulse ratio, and native puts it there too
 * (`DeckNudgeButton`, GlobalToolbarView:1677).
 */
const STEP = 0.3; // BPM delta per tick — matches native DeckNudgeButton
const INTERVAL_MS = 40; // 25×/s smooth ramp (matches DJNudgeManager)
const LIMIT = 20; // schema clamp on deckNudgeBpm

export function NudgeBox({ link, deck }: { link: EngineLink | null; deck: number }) {
  const [delta, setDelta] = useState(0);
  const deltaRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const write = (v: number) => {
    deltaRef.current = v;
    setDelta(v);
    link?.paramWrite("deckNudgeBpm", v, deck);
  };

  const startHold = (direction: number) => {
    if (timerRef.current !== null) return;
    // First tick fires immediately so a quick tap still bends the deck.
    write(clamp(deltaRef.current + direction * STEP));
    timerRef.current = setInterval(() => {
      write(clamp(deltaRef.current + direction * STEP));
    }, INTERVAL_MS);
  };

  const release = () => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    write(0); // snap back to lock
  };

  // Never leave a ramp running if the component unmounts mid-hold.
  useEffect(() => () => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
  }, []);

  const arrow = (direction: number, glyph: string, hint: string) => (
    <button
      className="nudge-arrow ds-hot"
      title={hint}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        startHold(direction);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {glyph}
    </button>
  );

  return (
    <div className={`nudge-box${delta !== 0 ? " live" : ""}`}>
      <span className="mono dim">NUDGE</span>
      {arrow(-1, "‹", "Hold to nudge this deck behind (temporary timing shift — BPM unchanged)")}
      <span className="mono nudge-value">
        {delta === 0 ? "0.0" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
      </span>
      {arrow(1, "›", "Hold to nudge this deck ahead (temporary timing shift — BPM unchanged)")}
    </div>
  );
}

function clamp(v: number): number {
  return Number(Math.max(-LIMIT, Math.min(LIMIT, v)).toFixed(2));
}
