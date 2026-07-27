import { useEffect, useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import { ModCanvas } from "./ModCanvas.tsx";
import { ModLab } from "./ModLab.tsx";
import {
  MOD_NAMES,
  modColor,
  toShapeChannel,
  useModulation,
  type Modulation,
} from "./useModulation.ts";
import type { ModChannelState } from "../../protocol/schema.ts";
import "./modulation.css";

/**
 * The Agitation timing, in one glance (MOD-12): the segment rate as "N st" (a new random target
 * every N grid steps), or "Phrase" when it steps once per pattern loop (LCM mode).
 */
export function lfoTimingLabel(ch: ModChannelState): string {
  // MOD-12: the Agitation segment rate — "a new target every N steps" (or once per Phrase = LCM).
  if (ch.lcmMode) return "Phrase";
  return `${Math.max(1, Math.round(ch.stepsPerCycle || ch.cycleSteps))} st`;
}

/**
 * The mod strip (MOD-6) — four lanes in the master row, replacing native's two-row wall of boxes.
 *
 * The native "modulation centre" is two rows of `CompactLFOStrip`, each up to a dozen drag boxes
 * (type · wave · sync · div · rate · phase · symmetry · jitter · A/D/S/R · trigger · depth). You
 * read `symmetry = 0.34` and had to imagine what it did.
 *
 * A lane here shows the ONE thing a glance should answer — what shape is this, and what is it doing
 * right now — as a live thumbnail with the playhead riding it. Everything else moved into the Lab,
 * one click away. Nothing is hidden; the detail just stopped shouting.
 *
 * The `Mn` label IS the arm button (native does the same, MasterTrackRowView:1085). Arming latches
 * `armedModChannel` in Swift, which pushes to every webview — that is how the ring can appear on a
 * track-row control that lives in a different React tree than this strip.
 */
export function ModStrip({ link }: { link: EngineLink | null }) {
  const mod = useModulation(link);
  const [open, setOpen] = useState<number | null>(null);

  // The LFO canvas draws its cycle against the pattern grid's cell field, so it must group by the
  // SAME beat grouping the grid does — the persisted `grid.groupSize`, read once here exactly as
  // GridPanel reads it (generic settings channel, no schema change; default 4).
  const [groupSize, setGroupSize] = useState(4);
  useEffect(() => {
    if (!link) return;
    link
      .command("getSetting", { key: "grid.groupSize" })
      .then((raw) => {
        const v = (raw as { value?: unknown } | null)?.value;
        if (v === 2 || v === 3 || v === 4 || v === 6 || v === 8) setGroupSize(v);
      })
      .catch(() => {});
  }, [link]);

  // `visible` is View ▸ Show Modulation System — the same native toggle that hides master rows
  // 2 & 3, not a migration flag. (It WAS a migration flag, and that hid the strip with no way to
  // get it back: with the web grid on, the native master row isn't rendered either.)
  if (!mod.state || !mod.state.visible) return null;
  const channels = mod.state.channels;
  const armed = mod.state.armedModChannel;

  return (
    <div className="mod-strip-wrap">
      <section className="mod-strip" aria-label="Modulation channels">
        {channels.slice(0, 4).map((ch, i) => (
          <Lane
            key={i}
            i={i}
            mod={mod}
            groupSize={groupSize}
            armed={armed === i}
            expanded={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
          />
        ))}
      </section>
      {open !== null && channels[open] && (
        <ModLab
          link={link}
          mod={mod}
          index={open}
          groupSize={groupSize}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Lane({
  i,
  mod,
  groupSize,
  armed,
  expanded,
  onToggle,
}: {
  i: number;
  mod: Modulation;
  groupSize: number;
  armed: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ch = mod.state!.channels[i]!;
  const color = modColor(i);

  // The one number worth showing without opening the Lab: what sets this modulator's TIMING.
  // LFO-DIV rework: "8×3:2" (steps × ratio) or "LCM/2"-style when the cycle rides the pattern LCM.
  const headline =
    ch.type === "lfo"
      ? lfoTimingLabel(ch)
      : ch.type === "envelope"
        ? sourceLabel(mod, ch.trigSourceTrackIndex, "trig")
        : sourceLabel(mod, ch.envSourceTrackIndex, "src");

  return (
    <div className={`mod-lane${expanded ? " is-open" : ""}`}>
      <button
        type="button"
        className={`mod-arm${armed ? " is-armed" : ""}`}
        style={{ ["--mod-color" as string]: color }}
        onClick={() => mod.send("arm", i)}
        title={
          armed
            ? `Armed — click a track parameter to map it to ${MOD_NAMES[i]}. Click again to disarm.`
            : `Arm ${MOD_NAMES[i]} to map track parameters to it`
        }
      >
        {MOD_NAMES[i]}
      </button>

      <button
        type="button"
        className="mod-lane-face"
        onClick={onToggle}
        title={`${MOD_NAMES[i]} — ${ch.type} · click to open the Mod Lab`}
      >
        <ModCanvas
          channel={toShapeChannel(ch, i, mod.state!.lcmSteps)}
          color={color}
          getLive={() => mod.getLive(i)}
          stepsPerCycle={ch.stepsPerCycle}
          groupSize={groupSize}
          height={26}
          // A 26px thumbnail has no room for handles, and a stray drag here would edit the shape
          // by accident. The lane is a BUTTON that opens the Lab; editing happens there.
          readOnly
        />
      </button>

      <span className="mod-lane-meta mono dim">{headline}</span>
    </div>
  );
}

/** "KICK" / "t3" / "—" for a source-track index. */
export function sourceLabel(mod: Modulation, index: number, _kind: string): string {
  if (index < 0) return "—";
  const name = mod.state?.trackNames[index];
  return name && name.length > 0 ? name : `t${index + 1}`;
}
