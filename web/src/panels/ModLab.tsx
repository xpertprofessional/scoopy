import type { EngineLink } from "../engineLink.ts";
import { Button, GeoRange } from "../design/controls.tsx";
import { DragBox } from "../design/DragBox.tsx";
import { ModCanvas } from "./ModCanvas.tsx";
import { MOD_NAMES, modColor, toShapeChannel, type Modulation } from "./useModulation.ts";
import { sourceLabel } from "./ModStrip.tsx";
import { envelopeTotalMs, type EnvNode } from "./modShape.ts";

/**
 * MOD-12: the "Length" control — one modulation waveform spans N grid steps, N = ANY 1…64 (the app
 * is step-based, so every count), plus an "LCM" slot = one wave across the whole pattern loop. N=1 is
 * a shape per step; N=16 one wave per bar; N=64 a slow wave over four bars. One control replaces the
 * old Rate × Ratio × LCM triple. Each N maps to `cycleSteps = N, cycleRatio = 1:1`; LCM sets `lcmMode`.
 */
const LENGTH_MAX = 64;
const LCM_SLOT = LENGTH_MAX + 1; // the value just past 64 = "LCM"

/**
 * The Mod Lab — one channel, full size.
 *
 * ── MOD-12: the LFO is a GRM-Atelier "Agitation" engine ─────────────────────────────────────────
 *
 * Not a periodic waveform with shapers bolted on, but a random step-and-ramp generator: each
 * segment picks a new random target and ramps to it. Four controls shape that MOTION —
 *   Ease   (ramp curve, smooth ↔ instant step),
 *   Slant  (up/down asymmetry),
 *   Cyclic (targets random ↔ alternating = a periodic LFO),
 *   Jitter (looseness of the step timing).
 * Kept grid-locked (a segment every Rate steps) so it stays musical and repeats at the LCM.
 *
 * The canvas has nothing to grab for an LFO (the shape is the four sliders), so nothing to break.
 * The ENVELOPE keeps its breakpoints (a gated ADSR wants them) and its own Ease macro.
 */

/** PRESETS — points in the Agitation space (they write ease/slant/cyclic/jitter), not modes. */
const PRESETS: { id: string; glyph: string; title: string }[] = [
  { id: "sine", glyph: "∿", title: "Sine — ease 0, cyclic 1 (smooth alternating ramps)" },
  { id: "square", glyph: "⊓", title: "Square — ease +1, cyclic 1 (instant alternating steps)" },
  { id: "saw", glyph: "◺", title: "Saw — slant +1, cyclic 1 (asymmetric ramps)" },
  { id: "random", glyph: "⁙", title: "Random — cyclic 0 (a new random target each step)" },
];

const TYPES = ["lfo", "envFollower", "envelope"] as const;
const TYPE_LABEL: Record<string, string> = {
  lfo: "LFO",
  envFollower: "Env Fol",
  envelope: "Envelope",
};

export function ModLab({
  link,
  mod,
  index,
  groupSize,
  onClose,
}: {
  link: EngineLink | null;
  mod: Modulation;
  index: number;
  groupSize: number;
  onClose: () => void;
}) {
  void link;
  const ch = mod.state!.channels[index]!;
  const color = modColor(index);
  const name = MOD_NAMES[index]!;
  const nTracks = mod.state!.trackNames.length;
  const send = mod.send;
  const nodes: EnvNode[] = ch.envelopeNodes;

  // MOD-12: an LFO draws its own PERIOD (the "Length", = ch.stepsPerCycle cells) as a wrapping step
  // grid — 16 cells per row, like the pattern grid. Size the canvas to the row count so each row keeps
  // a readable height; envelope/follower stay a single 120px lane. Capped so a long period (up to the
  // pattern LCM in LCM mode) doesn't make a giant canvas.
  const STEPS_PER_ROW = 16;
  const isLfo = ch.type === "lfo";
  const periodSteps = Math.max(1, Math.round(ch.stepsPerCycle || STEPS_PER_ROW));
  const rows = isLfo ? Math.min(8, Math.ceil(periodSteps / STEPS_PER_ROW)) : 1;
  const canvasHeight = isLfo ? Math.max(64, rows * 46) : 120;

  /**
   * Commit the whole envelope shape. The guard matters: a shape whose segments all have zero length
   * has no timeline — it collapses to a flat line with every node stacked at x=0, exactly the
   * unrecoverable state MOD-9b exists to prevent. Repair it rather than refuse the edit.
   */
  const writeEnvelope = (next: EnvNode[], sustainNodeIndex = ch.sustainNodeIndex) => {
    const safe = next.map((n) => ({ ...n }));
    if (safe.length > 1 && envelopeTotalMs(safe) <= 0) safe[safe.length - 1]!.timeMs = 100;
    send("setEnvelope", index, {
      envelope: {
        nodes: safe,
        sustainNodeIndex: Math.min(Math.max(sustainNodeIndex, 0), safe.length - 1),
        bipolar: ch.bipolar,
        tempoSync: ch.tempoSync,
      },
    });
  };

  return (
    <section
      className="mod-lab"
      aria-label={`Mod Lab ${name}`}
      style={{ ["--mod-color" as string]: color }}
    >
      <header className="mod-lab-head">
        <span className="mod-lab-title" style={{ color }}>
          {name}
        </span>
        <div className="mod-lab-types">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={`mod-chip${ch.type === t ? " is-on" : ""}`}
              onClick={() => send("setType", index, { mode: t })}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <Button label="Close" onClick={onClose} />
      </header>

      <ModCanvas
        channel={toShapeChannel(ch, index, mod.state!.lcmSteps)}
        color={color}
        getLive={() => mod.getLive(index)}
        stepsPerCycle={ch.stepsPerCycle}
        groupSize={groupSize}
        wrapSteps={isLfo ? STEPS_PER_ROW : 0}
        height={canvasHeight}
        onPhaseOffset={(v) => send("setPhaseOffset", index, { value: v })}
        onNodeMove={(i, timeMs, value) =>
          writeEnvelope(
            nodes.map((n, k) => (k === i ? { ...n, timeMs: i === 0 ? 0 : timeMs, value } : n)),
          )
        }
        onNodeAdd={(after, timeMs, value) => {
          if (nodes.length >= 16) return; // BreakpointEnvelope.maxNodes — the C++ POD's hard cap
          const next = [...nodes];
          next.splice(after + 1, 0, { timeMs: Math.max(0, timeMs), value, curve: 1 });
          // Inserting BEFORE the sustain node shifts it right, or the gate moves under the user.
          writeEnvelope(
            next,
            after < ch.sustainNodeIndex ? ch.sustainNodeIndex + 1 : ch.sustainNodeIndex,
          );
        }}
        onNodeDelete={(i) =>
          writeEnvelope(
            nodes.filter((_, k) => k !== i),
            i < ch.sustainNodeIndex ? ch.sustainNodeIndex - 1 : ch.sustainNodeIndex,
          )
        }
        onCurveBend={(i, curve) =>
          writeEnvelope(nodes.map((n, k) => (k === i ? { ...n, curve } : n)))
        }
      />

      <div className="mod-lab-params">
        {ch.type === "lfo" && (
          <>
            <div className="mod-waves">
              {PRESETS.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className="mod-chip"
                  title={w.title}
                  onClick={() => send("setWavePreset", index, { mode: w.id })}
                >
                  {w.glyph}
                </button>
              ))}
            </div>

            {/* LENGTH — one waveform spans N grid steps (1 = a shape per step, 16 = one wave per bar,
                64 = a slow wave over four bars), ANY N 1…64, plus an "LCM" slot = one wave across the
                whole pattern loop. Cyclic then decides clean-wave vs random within that length. */}
            <LabParam
              id={`mod/${index}/length`}
              label="Length"
              value={ch.lcmMode ? LCM_SLOT : ch.cycleSteps}
              display={ch.lcmMode ? "LCM" : `${ch.cycleSteps} st`}
              min={1}
              max={LCM_SLOT}
              step={1}
              defaultValue={8}
              onChange={(v) => {
                const n = Math.max(1, Math.min(LCM_SLOT, Math.round(v)));
                if (n === LCM_SLOT) {
                  send("setLcmMode", index, { value: 1 });
                } else {
                  send("setLcmMode", index, { value: 0 });
                  send("setCycleRatio", index, { value: 1 }); // pin to 1:1 — wavelength = N steps
                  send("setCycleSteps", index, { value: n });
                }
              }}
            />

            {/* THE FOUR AGITATION CONTROLS (GRM Atelier). They shape the random step-and-ramp motion:
                  EASE    ramp curve       (−1 hold-then-step · 0 smooth · +1 instant step / S&H)
                  SLANT   up/down time     (asymmetry of each ramp — saw ↔ reverse-saw)
                  CYCLIC  target order     (0 random ↔ 1 alternating = a periodic LFO)
                  JITTER  step timing      (0 on the grid → looser rhythm) */}
            <LabParam
              id={`mod/${index}/ease`}
              label="Ease"
              value={ch.ease}
              display={ch.ease <= -0.999 ? "hold" : ch.ease >= 0.999 ? "step" : ch.ease.toFixed(2)}
              min={-1}
              max={1}
              step={0.01}
              defaultValue={0}
              bipolar
              onChange={(v) => send("setEase", index, { value: v })}
            />
            <LabParam
              id={`mod/${index}/slant`}
              label="Slant"
              value={ch.slant}
              display={ch.slant.toFixed(2)}
              min={-1}
              max={1}
              step={0.01}
              defaultValue={0}
              bipolar
              onChange={(v) => send("setSlant", index, { value: v })}
            />
            <LabParam
              id={`mod/${index}/cyclic`}
              label="Cyclic"
              value={ch.cyclic}
              display={ch.cyclic >= 0.999 ? "cyclic" : ch.cyclic <= 0.001 ? "random" : ch.cyclic.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              defaultValue={1}
              onChange={(v) => send("setCyclic", index, { value: v })}
            />
            <LabParam
              id={`mod/${index}/jitter`}
              label="Jitter"
              value={ch.jitter}
              display={ch.jitter <= 0 ? "tight" : ch.jitter.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(v) => send("setJitter", index, { value: v })}
            />

            <LabParam
              id={`mod/${index}/phase`}
              label="Phase"
              value={ch.phaseOffset}
              display={`${Math.round(ch.phaseOffset * 360)}°`}
              min={0}
              max={1}
              step={0.005}
              defaultValue={0}
              onChange={(v) => send("setPhaseOffset", index, { value: v })}
            />
          </>
        )}

        {ch.type === "envFollower" && (
          <>
            <SourceRow
              label="Source"
              index={index}
              mod={mod}
              current={ch.envSourceTrackIndex}
              nTracks={nTracks}
              op="setFollowerSource"
            />
            <LabParam
              id={`mod/${index}/gain`}
              label="Gain"
              value={ch.envGain}
              display={`${ch.envGain.toFixed(1)}×`}
              min={0}
              max={10}
              step={0.1}
              defaultValue={1}
              onChange={(v) => send("setFollowerGain", index, { value: v })}
            />
            <LabParam
              id={`mod/${index}/atk`}
              label="Atk"
              value={ch.envAttack}
              display={ch.envAttack.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(v) => send("setFollowerAttack", index, { value: v })}
            />
            <LabParam
              id={`mod/${index}/rel`}
              label="Rel"
              value={ch.envRelease}
              display={ch.envRelease.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.2}
              onChange={(v) => send("setFollowerRelease", index, { value: v })}
            />
            <LabParam
              id={`mod/${index}/smth`}
              label="Smth"
              value={ch.smooth}
              display={ch.smooth.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              defaultValue={0}
              onChange={(v) => send("setSmooth", index, { value: v })}
            />
          </>
        )}

        {ch.type === "envelope" && (
          <>
            <SourceRow
              label="Trigger"
              index={index}
              mod={mod}
              current={ch.trigSourceTrackIndex}
              nTracks={nTracks}
              op="setTriggerSource"
            />
            {/* One slider curves every segment at once — the common case, without hunting for the
                per-segment bend handles (which stay, for when you do want them). */}
            <LabParam
              id={`mod/${index}/envEase`}
              label="Ease"
              value={ch.envEase}
              display={ch.envEase.toFixed(2)}
              min={-1}
              max={1}
              step={0.01}
              defaultValue={0}
              bipolar
              onChange={(v) => send("setEnvEase", index, { value: v })}
            />
            <p className="mod-note dim">
              {ch.trigSourceTrackIndex < 0
                ? "Pick a trigger track — its cells become this envelope's gate."
                : `Gated by ${sourceLabel(mod, ch.trigSourceTrackIndex, "trig")}'s cells · ${nodes.length} nodes · double-click to add, right-click to delete, drag a segment's middle to bend it.`}
            </p>
          </>
        )}

        <LabParam
          id={`mod/${index}/depth`}
          label="Depth"
          value={ch.depth}
          display={`${Math.round(ch.depth * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          defaultValue={1}
          onChange={(v) => send("setDepth", index, { value: v })}
        />
      </div>
    </section>
  );
}

/**
 * One parameter in the track-row control-band idiom (MOD-11): a 48px value box, then the
 * parameter name printed INSIDE the geometric bar. Box first (native `Paired` ordering), value
 * lives ONLY in the box — the bar carries the name. Bipolar params fill from the centre (native
 * pan/crossfader parity). Every one still joins the ö/ä focus lane via its DragBox.
 */
function LabParam(props: {
  id: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  defaultValue?: number;
  bipolar?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mod-paired">
      <DragBox
        id={props.id}
        value={props.value}
        display={props.display}
        min={props.min}
        max={props.max}
        step={props.step}
        defaultValue={props.defaultValue}
        onChange={props.onChange}
      />
      <GeoRange
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        label={props.label}
        origin={props.bipolar ? "center" : "left"}
        onChange={props.onChange}
      />
    </div>
  );
}

/**
 * Source-track picker. A DragBox (not a `<select>`) on purpose: it joins the ö/ä focus lane like
 * every other value control, so the whole Lab stays keyboard-reachable.
 */
function SourceRow({
  label,
  index,
  mod,
  current,
  nTracks,
  op,
}: {
  label: string;
  index: number;
  mod: Modulation;
  current: number;
  nTracks: number;
  op: string;
}) {
  return (
    <div className="mod-box">
      <span className="mod-box-cap">{label}</span>
      <DragBox
        id={`mod/${index}/${op}`}
        value={current + 1} // 0 = none, so the box's range starts at "no source"
        display={current < 0 ? "—" : sourceLabel(mod, current, label)}
        min={0}
        max={nTracks}
        step={1}
        defaultValue={0}
        onChange={(v) => mod.send(op, index, { value: Math.round(v) - 1 })}
      />
    </div>
  );
}
