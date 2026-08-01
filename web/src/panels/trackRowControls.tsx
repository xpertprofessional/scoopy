import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GridTrackState } from "../../protocol/schema.ts";
import { DragBox, useDragBoxMenu, type EditIntent } from "../design/DragBox.tsx";
import { useContextMenu, type MenuItem } from "../design/ContextMenu.tsx";
import type { LearnTarget } from "../state/midiLearn.ts";
import type { ScenePinTarget } from "../state/scenePins.ts";
import { useCapabilities } from "../state/capabilitiesStore.ts";
import { buildModMapItems, type ModTarget } from "./modMap.ts";
import { depthForEdge, modulatedValue, sweepRange, type Routing } from "./modMath.ts";
import { modColor, toShapeChannel, type Modulation } from "./useModulation.ts";
import { GeoRange } from "../design/controls.tsx";
import { currentTokens, semanticColor, trackDisplayColor } from "../design/tokens.ts";

/** The row trim bar. Both are SIGNAL (the sample's own waveform, in and out of
    the trim), so neither scales with the look's chrome ink. */
const TRIM = { inTrim: 0.75, outTrim: 0.28 } as const;
import "./modulation.css";
import {
  acquireControlFocus,
  installFocusKeyboard,
  registerFocusTarget,
  useFocusModel,
  useFocusScope,
} from "../design/focusModel.ts";
import {
  accentToolLabel,
  chopToolLabel,
  chordToolLabel,
  flamToolLabel,
  formatChoke,
  formatGain,
  formatGlidePercent,
  formatPan,
  formatPitch,
  formatSend,
  formatSwing,
  formatTone,
  formatVolume,
  freeRatePct,
  freeRateFromPct,
  freeRateLabel,
  glideToolLabel,
  nearestSpeedRatio,
  sliderFractionToVolume,
  SPEED_RATIOS,
  speedRatioName,
  stepSpeedRatio,
  stereoLabel,
  outputAssignLabel,
  unifiedRate,
  unifiedRateLabel,
  stretchQualityLabel,
  toneModeLabel,
  TRACK_PALETTE,
  voiceLabel,
  volumeToSliderFraction,
  withField,
} from "./trackControls.ts";
import {
  dialParamsFor,
  noteName,
  cellParamChipLabel,
  paramHasCellData,
  trackSubModeLabel,
} from "./gridModel.ts";

/**
 * TR fat track-row control band (trackrow.md §8; compacted in TR-FT-4 to the
 * user's signal-flow layout). Rows below each track's cells:
 *   P — pattern + per-cell: launch · STEP · locator · unified RATE (multiply
 *       detents ⊕ free tape rate, TR-FT-9)
 *       · dial chips · Acc/Gld/Fl · G% · PS · SW · ST   (directly below the grid)
 *   H — identity/source + SAMPLE WINDOW in one row (TR-FT-7): name · browse ◀▶
 *       · LOAD · M · S · REG/OWN · sub-mode │ S · waveform (flex — fills all
 *       remaining width; chop segments clickable, boundaries draggable) · E ·
 *       Ls/Le/Lx / CH / Atk·Rel (mode-dependent)
 *   DSP paired sliders (gain·pitch·tone·pan·vol + choke/voice/stereo)
 *   mod-slots (only mapped) · sends
 * Read + edit via `trackEdit` (Swift stays owner); optimistic echo first so
 * drags never wait on the round-trip. Band height is measured (GridPanel).
 */

// Native menu tables (ContentView: pan Output submenu, pitch Tuning submenu,
// tone Filter Mode + Resonance (Q) presets).
const OUTPUT_ASSIGNS = [
  { value: 0, label: "Stereo (pan)" },
  { value: 1, label: "Output 1" },
  { value: 2, label: "Output 2" },
] as const;
const TUNINGS = [
  { value: 0, label: "12-TET (Equal)" },
  { value: 1, label: "Just Intonation" },
] as const;
const FILTER_MODES = [
  { value: "tone", label: "Tone" },
  { value: "lowPass", label: "Low-pass" },
  { value: "highPass", label: "High-pass" },
  { value: "bandPass", label: "Band-pass" },
  { value: "notch", label: "Notch" },
] as const;
const Q_PRESETS = [0.7, 1, 2, 4, 8, 16] as const;
const DRIVE_PRESETS = [0, 25, 50, 75, 100] as const;

export type SendTrackEdit = (params: Record<string, unknown>) => void;
export type Optimistic = (reduce: (t: GridTrackState) => GridTrackState) => void;
export type TrimPeaks = { minMax: number[]; rms: number[] };

interface BandCtx {
  t: GridTrackState;
  i: number;
  peaks?: TrimPeaks;
  send: SendTrackEdit;
  optimistic: Optimistic;
  /** MOD-7: the modulation domain, for sweep bands + arm-to-map. Omitted in DJ rows. */
  mod?: Modulation;
  /**
   * Deck scope, exactly as `trackEdit` carries it (GridPanel `scope`). MIDI
   * learn resolves `trackIndex` against a SEQUENCER, so a DJ row that omits the
   * deck learns deck A's track of the same index — the mapping sticks, on the
   * wrong track (CM-6). undefined = the compose sequencer.
   */
  deck?: number;
  /**
   * CM-5b: the mute group is LATCHED (gridMeta.muteGroupActive). While it is true
   * the M button add/removes this track from the group instead of muting it —
   * native ContentView.toggleMute:3349 branches on exactly this flag, so a row
   * that does not know it silently does the wrong thing on every M click.
   */
  muteGroupActive?: boolean;
}

/**
 * CM-5b: what the M button DOES, which is not always "mute".
 *
 * The mute group is a LATCHED macro over a member set (BeatSequencer:9464). While
 * it is latched, M edits MEMBERSHIP — adding a track silences it on the spot,
 * removing it un-silences it — and that is the whole point of the feature: you slam
 * MUTE, then sweep the M buttons to pull tracks in and out of the silenced set
 * without touching their own mute flags. Native branches on exactly this
 * (ContextView.toggleMute → ContentView:3349); the web sent `toggleMute`
 * unconditionally, so the group could never be built from a web row.
 *
 * Returns the op to send AND the mute value to echo optimistically. Pure, because
 * this rule is the parity claim — the button is just its caller.
 */
export function muteButtonIntent(
  t: Pick<GridTrackState, "muted" | "muteGroupMember">,
  trackIndex: number,
  groupLatched: boolean,
): { op: "toggleMute" | "toggleMuteGroup"; trackIndex: number; muted: boolean } {
  // Latched: joining mutes, leaving unmutes — so the echo follows MEMBERSHIP, not
  // the current mute flag (a member that somehow reads unmuted still leaves silent).
  if (groupLatched) {
    return { op: "toggleMuteGroup", trackIndex, muted: !t.muteGroupMember };
  }
  return { op: "toggleMute", trackIndex, muted: !t.muted };
}

/**
 * How a track-row box names itself to MIDILearnSystem (CM-2 tokens, CM-6 deck).
 *
 * The deck is load-bearing: Swift resolves `trackIndex` against a SEQUENCER
 * (`editTargetSequencer`), so a DJ row that omits it learns deck A's track of
 * the same index. Note `deck === undefined`, not `!deck` — deck A is 0, and a
 * falsy check would drop exactly the deck that looks like it works.
 */
export function trackLearnTarget(
  token: string,
  trackIndex: number,
  deck?: number,
): LearnTarget {
  return {
    kind: "trackParam",
    token,
    trackIndex,
    ...(deck === undefined ? {} : { deck }),
  };
}

/**
 * MOD-7 — the sweep band. This is where "visualization becomes parameter control".
 *
 * A modulated slider grows a translucent band spanning the range the modulation ACTUALLY covers
 * (computed by `modMath`, which mirrors the engine's per-target formula — additive for pan/tone/
 * pitch, multiplicative for volume/gain, asymmetric for a unipolar envelope or follower), with a
 * live dot riding inside it at the true modulated value. **Dragging the band's edge sets depth.**
 * The modulation now lives ON the parameter it moves, instead of in a bar somewhere else.
 *
 * Multi-channel rule (decided, not left open): ONE band, ONE dot, showing the COMBINED sweep. With
 * a single routing the band takes that channel's colour and its edges are draggable. With two or
 * more the split between them is ambiguous, so the band goes neutral and edge-drag is disabled —
 * the `M<n>·<TGT>` slots below stay the exact per-channel editor. Nothing is lost; the band is the
 * fast path, not the only path.
 *
 * The dot is moved by writing `transform` from the shared rAF ticker, never through React state:
 * at 30 Hz across every mapped control, re-rendering the grid would be the end of the frame budget.
 */
function SweepBand({
  ctx,
  target,
  value,
  min,
  max,
}: {
  ctx: BandCtx;
  target: ModTarget;
  value: number;
  min: number;
  max: number;
}) {
  const dotRef = useRef<HTMLDivElement | null>(null);
  const mod = ctx.mod;
  // ModSlotState.target is a plain string on the wire (the native enum has 8 cases and the schema
  // does not re-declare them). Narrow it here rather than casting blindly: an unknown target is a
  // routing we cannot draw honestly, so it is dropped, not guessed at.
  const routings: Routing[] = ctx.t.modSlots
    .filter((s) => s.target === target)
    .map((s) => ({ channelIndex: s.channelIndex, target, depth: s.depth }));

  const channels = mod?.state?.channels;
  const lcmSteps = mod?.state?.lcmSteps ?? 0;
  const shapes = channels?.map((c, ci) => toShapeChannel(c, ci, lcmSteps));

  // Poll the live channel values in ONE rAF and write the dot's transform directly.
  useEffect(() => {
    if (!mod || !shapes || routings.length === 0) return;
    const el = dotRef.current;
    if (!el) return;
    const types = shapes.map((c) => c.type);
    let raf = 0;
    const tick = () => {
      const vals = [0, 1, 2, 3].map((c) => mod.getLive(c).value);
      const v = modulatedValue(value, target, routings, vals, types);
      const frac = (v - min) / (max - min || 1);
      el.style.transform = `translateX(${Math.min(Math.max(frac, 0), 1) * 100}%)`;
      el.style.left = "0";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mod, shapes, routings, value, target, min, max]);

  if (!mod || !shapes || routings.length === 0) return null;

  const band = sweepRange(value, target, routings, shapes);
  const pct = (v: number) => (Math.min(Math.max((v - min) / (max - min || 1), 0), 1)) * 100;
  const lo = pct(band.min);
  const hi = pct(band.max);
  if (hi - lo < 0.5) return null; // depth 0 (or a zeroed routing) — draw nothing rather than a hairline

  const single = routings.length === 1 ? routings[0]! : null;
  const color = single ? modColor(single.channelIndex) : "var(--signal)";

  /** Drag an edge → solve the depth that puts the edge there (modMath.depthForEdge). */
  const edgeDrag = (edge: "min" | "max") => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!single) return; // ambiguous with 2+ routings — the M-slots own it
    e.preventDefault();
    e.stopPropagation();
    const rail = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const ch = shapes[single.channelIndex];
    if (!ch) return;
    const move = (ev: PointerEvent) => {
      const frac = Math.min(Math.max((ev.clientX - rail.left) / rail.width, 0), 1);
      const edgeValue = min + frac * (max - min);
      const depth = depthForEdge(value, target, single, ch, edgeValue);
      if (depth === null) return;
      ctx.send({
        op: "setModDepth",
        trackIndex: ctx.i,
        index: single.channelIndex,
        mode: target,
        value: depth,
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    void edge;
  };

  return (
    <>
      <div
        className="mod-band"
        style={{ ["--mod-color" as string]: color, left: `${lo}%`, width: `${hi - lo}%` }}
      />
      {single && (
        <>
          <div className="mod-band-edge" style={{ left: `calc(${lo}% - 2px)` }} onPointerDown={edgeDrag("min")} />
          <div className="mod-band-edge" style={{ left: `calc(${hi}% - 2px)` }} onPointerDown={edgeDrag("max")} />
        </>
      )}
      <div ref={dotRef} className="mod-dot" />
    </>
  );
}

/**
 * Arm-to-map: while a channel is armed, every mappable control offers itself as a target — a ring
 * in the channel's colour, green if it is already routed there. A click maps instead of editing.
 * Mirrors native `.modifierMappable` (TrackFXSettingsView:752).
 *
 * ── The click must never reach the control (user, 2026-07-13) ──────────────────────────────────
 * The first cut hung a capture-phase `onClick` on the slider. That does not work: `GeoRange` is a
 * native `<input type="range">`, and a mousedown on its track jumps the thumb and fires `change`
 * IMMEDIATELY — before `click` exists. So the value was already clobbered by the time the handler
 * could suppress it. Clicking to assign a modulator silently changed the volume you were assigning.
 *
 * The fix is the one native uses: don't intercept the event, make the control **unable to receive
 * it**. While armed the whole paired row goes `pointer-events: none` (see `.mod-armed` in
 * modulation.css) and a real overlay button sits on top. The range input never sees a pointer at
 * all — this is `.allowsHitTesting(false)` + an overlay, ported.
 */
function useArmedMap(ctx: BandCtx, target: ModTarget | undefined) {
  const armed = ctx.mod?.state?.armedModChannel;
  if (target === undefined || armed === null || armed === undefined) return null;
  const mapped = ctx.t.modSlots.some((s) => s.target === target && s.channelIndex === armed);
  const name = `M${armed + 1}`;
  return {
    mapped,
    className: `mod-armed${mapped ? " is-mapped" : ""}`,
    style: { ["--mod-color" as string]: modColor(armed) } as React.CSSProperties,
    title: mapped
      ? `Mapped to ${name} — click to unmap`
      : `Click to map this to ${name}`,
    onMap: () =>
      ctx.send({
        op: mapped ? "unmapMod" : "mapMod",
        trackIndex: ctx.i,
        index: armed,
        mode: target,
      }),
  };
}

/** The transparent hit-target laid over an armed control. It is the ONLY thing that can be clicked. */
function MapOverlay({ arm }: { arm: NonNullable<ReturnType<typeof useArmedMap>> }) {
  return (
    <button type="button" className="mod-map-hit" title={arm.title} onClick={arm.onMap} />
  );
}

/** One box + inline-label geometric slider (native paired DSP control). */
function Paired(props: {
  ctx: BandCtx;
  slug: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  bipolar?: boolean;
  defaultValue?: number;
  onChange: (v: number, intent?: EditIntent) => void;
  /** Non-linear sliders (volume) map value↔fraction; omit = linear. */
  sliderFraction?: (v: number) => number;
  fractionToValue?: (f: number) => number;
  /** Extra right-click items appended after the box's base menu. */
  menu?: MenuItem[];
  /** Names this control to MIDILearnSystem (CM-2); omit = not learnable. */
  learn?: LearnTarget;
  /** Scene-override key (CM-3); omit = not pinnable. */
  scenePin?: ScenePinTarget;
  /** Modulation target (CM-4); omit = not mappable. */
  modTarget?: ModTarget;
  /**
   * Semantic identity color (DESIGN-SYSTEM §2b) — set on the sends, so S3 here
   * and the mixer's FX3 return read as one signal path. Tints the slider fill
   * and the box edge (the edge is what carries it at value 0, which is where a
   * send usually sits).
   */
  identity?: string;
}) {
  const { ctx } = props;
  const id = `track/${ctx.i}/${props.slug}`;
  const useFrac = props.sliderFraction && props.fractionToValue;
  const modMenu = props.modTarget
    ? buildModMapItems(props.modTarget, ctx.i, ctx.t.modSlots, ctx.send)
    : undefined;
  // The whole row is right-clickable (box AND slider), with the identical menu
  // the box itself builds — the slider is the same parameter.
  const onContextMenu = useDragBoxMenu({ ...props, modMenu });
  const armMap = useArmedMap(ctx, props.modTarget);
  return (
    <div
      className={`trk-paired${armMap ? ` ${armMap.className}` : ""}${
        props.identity ? " sem sem-fill" : ""
      }`}
      style={
        props.identity
          ? ({ ...armMap?.style, "--sem-color": props.identity } as React.CSSProperties)
          : armMap?.style
      }
      onContextMenu={onContextMenu}
    >
      <DragBox
        id={id}
        value={props.value}
        display={props.display}
        min={props.min}
        max={props.max}
        step={props.step}
        defaultValue={props.defaultValue}
        onChange={props.onChange}
        menu={props.menu}
        learn={props.learn}
        scenePin={props.scenePin}
        modMenu={modMenu}
      />
      {/* MOD-7: the slider is the rail the sweep band and its live dot are drawn on, so the
          modulation is visible ON the parameter it moves — and its depth is dragged there too.
          While a channel is armed the whole rail becomes a map target instead. */}
      <div className="trk-rail mod-swept">
        {useFrac ? (
          <GeoRange
            value={props.sliderFraction!(props.value)}
            min={0}
            max={1}
            step={0.001}
            label={props.label}
            onChange={(f) => props.onChange(props.fractionToValue!(f), "drag")}
          />
        ) : (
          <GeoRange
            value={props.value}
            min={props.min}
            max={props.max}
            step={props.step}
            label={props.label}
            origin={props.bipolar ? "center" : "left"}
            // The rail is a continuous gesture like the box's drag, so it fans
            // out relative — never absolute (that would flatten the selection).
            onChange={(v) => props.onChange(v, "drag")}
          />
        )}
        {props.modTarget && (
          <SweepBand
            ctx={ctx}
            target={props.modTarget}
            value={props.value}
            min={props.min}
            max={props.max}
          />
        )}
      </div>
      {armMap && <MapOverlay arm={armMap} />}
    </div>
  );
}

/** Value-only box (no slider): choke, step count, etc. */
function BoxOnly(props: {
  ctx: BandCtx;
  slug: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number, intent?: EditIntent) => void;
  /** Scene-override key (CM-3); omit = not pinnable. */
  scenePin?: ScenePinTarget;
  /** Modulation target (CM-4); omit = not mappable. */
  modTarget?: ModTarget;
}) {
  const { ctx } = props;
  const modMenu = props.modTarget
    ? buildModMapItems(props.modTarget, ctx.i, ctx.t.modSlots, ctx.send)
    : undefined;
  // Same arm-to-map contract as Paired: while armed the box cannot be edited, only mapped.
  const armMap = useArmedMap(ctx, props.modTarget);
  return (
    <div
      className={`trk-box${armMap ? ` ${armMap.className}` : ""}`}
      style={armMap?.style}
    >
      <DragBox
        modMenu={modMenu}
        id={`track/${ctx.i}/${props.slug}`}
        value={props.value}
        display={props.display}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={props.onChange}
        scenePin={props.scenePin}
      />
      {props.label && <span className="trk-box-cap">{props.label}</span>}
      {armMap && <MapOverlay arm={armMap} />}
    </div>
  );
}

/** Step count clamp — native `updateStepCountsForSelection` (BeatSequencer:749). */
const STEP_MIN = 1;
const STEP_MAX = 64;

/**
 * Step count = the drag box PLUS its two steppers (native ContentView:1962 —
 * chevron.down · DraggableNumberBox · chevron.up). The steppers are not
 * decoration: **⇧-click halves / doubles** the count, which is how you get
 * between 16 and 32 steps in one click instead of dragging through 16 values.
 * Plain click = ∓1. Mouse-only (no `focusId`) like native, where the focus
 * index (34) belongs to the BOX — ö/ä there already steps ±1.
 */
function StepCount(props: { value: number; onChange: (v: number) => void; box: ReactNode }) {
  const bump = (e: React.MouseEvent, dir: -1 | 1) => {
    const v = props.value;
    const next = e.shiftKey ? (dir > 0 ? v * 2 : Math.floor(v / 2)) : v + dir;
    props.onChange(Math.max(STEP_MIN, Math.min(STEP_MAX, next)));
  };
  return (
    <>
      <button
        className="trk-tog trk-step"
        title="Fewer steps (⇧-click to halve)"
        onClick={(e) => bump(e, -1)}
      >
        ‹
      </button>
      {props.box}
      <button
        className="trk-tog trk-step"
        title="More steps (⇧-click to double)"
        onClick={(e) => bump(e, 1)}
      >
        ›
      </button>
    </>
  );
}

/**
 * TR-FT-12: buttons join the FocusModel with a `press` capability — the
 * DragBox contract (registerFocusTarget + clearFocus on unmount) with
 * adjust == press (ö/ä flips, Enter/'.' presses). `focusId` undefined =
 * mouse-only button, stays out of the cursor world. Unlike a DragBox, a
 * CLICK never acquires focus: the click already performs the action, and
 * stealing the lane would break the grid flow (a chip click must arm the
 * param while ö/ä keeps editing CELLS — grid.md §8.2). Buttons enter the
 * cursor world through arrow traversal only.
 */
function usePressFocus(
  focusId: string | undefined,
  onPress: () => void,
): { isFocused: boolean; scopedFocusId: string | undefined } {
  const focused = useFocusModel((s) => s.focused);
  const clearFocus = useFocusModel((s) => s.clearFocus);
  // NAV-11: scope the id (per-deck prefix on the DJ page, "" in compose) so the
  // two grids' identical `track/<i>/<ctrl>` ids don't collide in the global
  // registry. The caller stamps the returned `scopedFocusId` on the DOM so band
  // traversal (which reads `data-focus-id`) resolves the same scoped id back.
  const scope = useFocusScope();
  const scopedId = focusId === undefined ? undefined : scope + focusId;
  const isFocused = scopedId !== undefined && focused?.id === scopedId;

  // Keys act through the ref, so the registered closures stay live.
  const latest = useRef(onPress);
  latest.current = onPress;

  useEffect(() => {
    installFocusKeyboard();
  }, []);

  const acquire = () => {
    if (scopedId === undefined) return;
    useFocusModel.getState().setFocus({
      id: scopedId,
      adjust: () => latest.current(),
      press: () => latest.current(),
    });
  };
  const acquireRef = useRef(acquire);
  acquireRef.current = acquire;

  useEffect(() => {
    if (scopedId === undefined) return;
    const unregister = registerFocusTarget(scopedId, () => acquireRef.current());
    return () => {
      unregister();
      // A conditional control unmounting hands the keys back to the grid —
      // no stranded ring (DragBox parity).
      clearFocus(scopedId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedId]);

  return { isFocused, scopedFocusId: scopedId };
}

/** Compact toggle/cycle button (mute, solo, launch, direction, mode, voice). */
function Toggle(props: {
  label: string;
  on?: boolean;
  tone?: "mute" | "solo" | "accent" | "pin" | "locator";
  title: string;
  /** TR-FT-12: opt into the cursor world (band ←/→ + ö/ä/Enter/'.'). */
  focusId?: string;
  onClick: () => void;
  /** Right-click items (CM-5); omit = no menu. */
  menu?: MenuItem[];
  /**
   * CM-5b: this button's track belongs to the mute group — drawn as a ring AROUND
   * the button, deliberately not as `on`, because membership and mute are two
   * different facts and a member is very often not muted (the group is unlatched).
   * `armed` brightens the ring while the group is latched, mirroring native's
   * 1.5px/1.0px + opacity split (ContentView:3786).
   */
  marked?: boolean;
  armed?: boolean;
  /**
   * A quantized action is armed but has not fired yet — the button pulses until the
   * engine reaches the launch boundary. Distinct from `on`, which shows the state the
   * track is in NOW (a stopped track with a play scheduled is still stopped).
   */
  pending?: boolean;
  /** Heavy-traffic toggle (M/S/play/locator): claims --hit-slop of invisible
      clickable ground around the painted box (controls.css .ds-hot). Appended
      LAST — tests match on the "trk-tog on <tone>" prefix. */
  hot?: boolean;
}) {
  const { isFocused, scopedFocusId } = usePressFocus(props.focusId, props.onClick);
  const { openMenu } = useContextMenu();
  const cls = `trk-tog${props.on ? " on" : ""}${props.tone ? ` ${props.tone}` : ""}${
    isFocused ? " focused" : ""
  }${props.marked ? " member" : ""}${props.marked && props.armed ? " member-armed" : ""}${
    props.pending ? " pending" : ""
  }${props.hot ? " ds-hot" : ""}`;
  return (
    <button
      className={cls}
      title={props.title}
      data-focus-id={scopedFocusId}
      onClick={props.onClick}
      onContextMenu={(e) => {
        if (!props.menu?.length) return;
        e.preventDefault();
        openMenu(props.menu, e.clientX, e.clientY);
      }}
    >
      {props.label}
    </button>
  );
}

/**
 * Unified rate control (TR-FT-9): ⟳ reset · value box · log tape slider with
 * the 9 multiply ratios as detents MIRRORED onto both sides — the left side
 * plays the pattern BACKWARDS at that ratio (absolute `playbackDirection`,
 * replacing the →/← toggle; the engine mirrors step traversal AND XORs the
 * flag into grain reversal :4493, the bar-locked cousin of negative
 * freeRate). A plain drag LOCKS to the detents (bar-locked `speedMultiplier`
 * + direction — works in every mode, incl. OWN/TS/MIDI); ⌥-drag positions
 * freely between them (continuous `freeRate` phasor incl. reverse + center
 * tape-stop — the engine honors it only for audio REG non-TS, so elsewhere
 * the slider stays fixed to the detents). Writes decompose the signed value
 * so exactly one mechanism is engaged — detent → |v| multiplier + sign
 * direction + freeRate 1; free → freeRate v + multiplier 1 + forward — and
 * the effective signed read rate always equals the shown value.
 * Right-click: ratio list + Play backwards + Pitch Tracking (T / T+P).
 */
/** Slider anchor ratios that get a numeral caption inside the tape (the only
    detents far enough apart to label statically on the log scale). */
const RATE_ANCHORS = [1, 2, 4, 8, 16] as const;

function RateControl({ t, i, send, optimistic }: BandCtx) {
  const { openMenu } = useContextMenu();
  // NAV-11: the rate box registers a SCOPED focus id, so the "click ⟳/tape arms
  // ö/ä on the rate" gesture must acquire the same scoped id.
  const focusScope = useFocusScope();
  const freeAllowed =
    t.trackType === "audio" && t.playbackMode === "regular" && !t.timeStretchMode;
  const altRef = useRef(false);
  const backward = t.playbackDirectionReversed;
  const value = unifiedRate(t.speedMultiplier, t.freeRate, backward);
  const pct = freeRatePct(value);
  // Hover/drag readout: names the detent (or ⌥ tape rate) UNDER THE POINTER
  // before it's committed, so crowded log-scale positions aren't guesswork.
  const [hover, setHover] = useState<{ pct: number; label: string } | null>(null);
  const trackHover = (e: React.PointerEvent<HTMLSpanElement>) => {
    altRef.current = e.altKey;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return;
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const raw = freeRateFromPct(p);
    let label: string;
    if (e.altKey && freeAllowed) {
      label = freeRateLabel(raw);
    } else {
      const d = nearestSpeedRatio(raw);
      label = unifiedRateLabel(Math.abs(d), 1, d < 0);
    }
    setHover({ pct: p, label });
  };

  const apply = (v: number, free: boolean) => {
    if (free && freeAllowed) {
      // Free tape rate: multiplier + direction collapse to neutral so the
      // signed rate = v (negative freeRate already reverses cursor + grains;
      // stacking the direction flag would XOR the grains back to forward).
      if (t.speedMultiplier !== 1) send({ op: "setSpeedMultiplier", trackIndex: i, value: 1 });
      if (backward) send({ op: "setPlaybackDirection", trackIndex: i, value: 0 });
      optimistic((tt) => ({
        ...tt,
        speedMultiplier: 1,
        playbackDirectionReversed: false,
        freeRate: v,
        freeRateEnabled: v !== 1,
      }));
      send({ op: "setFreeRate", trackIndex: i, value: v });
    } else {
      // Signed detent: |detent| = multiplier, sign = playback direction.
      const detent = nearestSpeedRatio(v);
      const mag = Math.abs(detent);
      const back = detent < 0;
      if (t.freeRate === 1 && mag === t.speedMultiplier && back === backward) return;
      optimistic((tt) => ({
        ...tt,
        speedMultiplier: mag,
        playbackDirectionReversed: back,
        freeRate: 1,
        freeRateEnabled: false,
      }));
      if (t.freeRate !== 1) send({ op: "setFreeRate", trackIndex: i, value: 1 });
      if (back !== backward) send({ op: "setPlaybackDirection", trackIndex: i, value: back ? 1 : 0 });
      if (mag !== t.speedMultiplier) send({ op: "setSpeedMultiplier", trackIndex: i, value: mag });
    }
  };

  // ö/ä: walk the detents by INDEX (a ±step value nudge dies inside the current
  // detent's snap zone), ⌥ = the free tape where the engine honors it.
  const adjust = (dir: number, fine: boolean) => {
    if (fine && freeAllowed) apply(value + dir * 0.05, true);
    else apply(stepSpeedRatio(value, dir), false);
  };

  /** Assign the ⟳ reset ratio · direction · pitch tracking. Lives on the box AND
      the wrapper — the box's own right-click stops propagation, so the wrapper
      alone would leave the number itself menu-less (the T/T+P switch users reach
      for). The ratio rows do NOT apply a live rate (drag/ö-ä do that); they store
      the per-track ratio the ⟳ button snaps to — see setRateLockRatio. */
  const rateItems = (): MenuItem[] => [
    { kind: "info" as const, label: "Reset rate (⟳) →" },
    ...SPEED_RATIOS.map((r) => ({
      kind: "item" as const,
      label: speedRatioName(r),
      // The check marks the STORED reset target, not the live rate.
      checked: Math.abs(t.rateLockRatio - r) < 0.05,
      // Store-only: remember r as this track's ⟳ target. Does not change live speed.
      onSelect: () => {
        optimistic((tt) => ({ ...tt, rateLockRatio: r }));
        send({ op: "setRateLockRatio", trackIndex: i, value: r });
      },
    })),
    { kind: "sep" as const },
    {
      kind: "item" as const,
      label: "Play backwards (◀)",
      checked: backward || t.freeRate < 0,
      // Detent domain flips the direction flag; free domain negates the tape rate.
      onSelect: () => apply(-value, t.freeRate !== 1),
    },
    { kind: "sep" as const },
    {
      kind: "item" as const,
      label: "Time Only (T)",
      checked: !t.pitchSyncMode && !t.timeStretchMode,
      onSelect: () => {
        optimistic((tt) => ({ ...tt, pitchSyncMode: false, timeStretchMode: false }));
        send({ op: "setSpeedMode", trackIndex: i, value: 0 });
      },
    },
    {
      kind: "item" as const,
      label: "Time + Pitch (T+P)",
      checked: t.pitchSyncMode,
      onSelect: () => {
        optimistic((tt) => ({ ...tt, pitchSyncMode: true, timeStretchMode: false }));
        send({ op: "setSpeedMode", trackIndex: i, value: 1 });
      },
    },
  ];
  // CM-4: the rate box is a mod target too (native `freeRateLfoMenu`,
  // ContentView:1061) — LFO → rate is vibrato/FM.
  const modItems = (): MenuItem[] => buildModMapItems("freeRate", i, t.modSlots, send);
  const menu = (): MenuItem[] => [
    ...rateItems(),
    ...(modItems().length ? [{ kind: "sep" as const }, ...modItems()] : []),
  ];

  const lo = Math.min(50, pct * 100);
  const hi = Math.max(50, pct * 100);
  return (
    <span
      className="trk-rate"
      title={
        freeAllowed
          ? "Rate — drag locks to the multiply ratios (left side = pattern backwards), ⌥-drag = free tape rate (right-click: ratios + direction + pitch tracking)"
          : "Rate — multiply ratios only in this mode; left side = pattern backwards (right-click: ratios + direction + pitch tracking)"
      }
      // ⟳ · box · tape are three affordances of ONE parameter, so a click on any
      // of them arms ö/ä on the RATE. Without this the lock button reads as dead
      // to the keyboard: a button click deliberately never steals the lane
      // (TR-FT-12, so a grid chip can arm a param while ö/ä keeps editing cells),
      // and ö/ä on a focused ⟳ would only re-fire the reset anyway.
      // Primary button only — opening a context menu is not a focus gesture
      // (DragBox draws the same line at its own pointer-down).
      onPointerDownCapture={(e) => {
        if (e.button === 0) acquireControlFocus(`${focusScope}track/${i}/rate`);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(menu(), e.clientX, e.clientY);
      }}
    >
      <Toggle
        label="⟲"
        on={value !== t.rateLockRatio}
        title={
          t.rateLockRatio === 1
            ? "Reset rate to 1:1 — right-click a ratio to change this track's reset target · click also arms ö/ä on the rate"
            : `Reset rate to ${speedRatioName(t.rateLockRatio)} (this track's assigned reset — right-click to change) · click also arms ö/ä on the rate`
        }
        focusId={`track/${i}/ratereset`}
        onClick={() => apply(t.rateLockRatio, false)}
      />
      <DragBox
        id={`track/${i}/rate`}
        value={value}
        display={unifiedRateLabel(t.speedMultiplier, t.freeRate, backward)}
        min={-64}
        max={64}
        step={0.05}
        defaultValue={1}
        onChange={(v) => apply(v, true)}
        adjust={adjust}
        menu={rateItems()}
        modMenu={modItems()}
      />
      <span
        className="trk-ratetape"
        onPointerDown={trackHover}
        onPointerMove={trackHover}
        onPointerLeave={() => setHover(null)}
      >
        {SPEED_RATIOS.flatMap((r) => [r, -r]).map((r) => {
          const mag = Math.abs(r);
          const kind =
            mag === 1 ? " unity" : (RATE_ANCHORS as readonly number[]).includes(mag) ? " major" : "";
          return (
            <span
              key={r}
              className={`trk-ratetick${kind}`}
              style={{ left: `${freeRatePct(r) * 100}%` }}
            />
          );
        })}
        {RATE_ANCHORS.flatMap((r) => [r, -r]).map((r) => (
          <span key={`n${r}`} className="trk-ratenum" style={{ left: `${freeRatePct(r) * 100}%` }}>
            {Math.abs(r)}
          </span>
        ))}
        {hover && (
          <span
            className="trk-ratehover"
            style={{ left: `${Math.max(8, Math.min(92, hover.pct * 100))}%` }}
          >
            {hover.label}
          </span>
        )}
        <input
          className="ds-range"
          type="range"
          min={0}
          max={1}
          step={0.0005}
          value={pct}
          style={{
            background: `linear-gradient(to right, var(--bg-raised) 0 ${lo}%, var(--fill) ${lo}% ${hi}%, var(--bg-raised) ${hi}% 100%)`,
          }}
          onChange={(e) => apply(freeRateFromPct(Number(e.target.value)), altRef.current)}
        />
      </span>
    </span>
  );
}

/**
 * Cell-tool param selector (the "special cell edit tools"). Selecting it makes
 * the grid's ö/ä + vertical-drag edit THIS parameter (native activeCell
 * parameter), and shows a live count of affected cells. Right-click clears all.
 */
function CellTool(props: {
  label: string;
  param: string;
  active: boolean;
  title: string;
  /** TR-FT-12: cursor-world id (band ←/→ + ö/ä/Enter/'.' selects the tool). */
  focusId?: string;
  /** Menu wording for the clear action (native: "Clear All Accents", …). */
  clearLabel: string;
  onSelect: () => void;
  onClear: () => void;
}) {
  const { isFocused, scopedFocusId } = usePressFocus(props.focusId, props.onSelect);
  const { openMenu } = useContextMenu();
  return (
    <button
      className={`trk-tog trk-celltool${props.active ? " on accent" : ""}${
        isFocused ? " focused" : ""
      }`}
      title={props.title}
      data-focus-id={scopedFocusId}
      onClick={props.onSelect}
      onContextMenu={(e) => {
        // Native puts the clear behind a menu item — a bare right-click must
        // never destroy a track's per-cell edits with no way back.
        e.preventDefault();
        openMenu(
          [{ kind: "item", label: props.clearLabel, onSelect: props.onClear }],
          e.clientX,
          e.clientY,
        );
      }}
    >
      {props.label}
    </button>
  );
}

/**
 * P5-PCE selection core (percell-selection-ux.md P1.1): the Family-1 dial
 * param chips — PIT · TON · PAN · VOL · STA · END. Click arms the param for
 * the whole grid lane (ö/ä, vertical drag, ⌘-paint) WITHOUT touching cell
 * focus (the chip is DOM; it never calls clearSelection/focusRef). Active
 * chip = accent border+text (the one focus language); the 2px dot = the
 * param carries per-cell data somewhere on the track. Right-click = clear
 * per-cell values via menu (deliberate, not a bare click).
 */
export function ParamChips({
  t,
  i,
  send,
  optimistic,
}: {
  t: GridTrackState;
  i: number;
  send: SendTrackEdit;
  optimistic: Optimistic;
}) {
  // A note-emitting track dials NOTE · VEL · LEN · CHD; a sampler dials its six.
  // Same strip, same gestures — it just offers the params that mean something here.
  return (
    <span className="trk-chips">
      {dialParamsFor(t).map((p) => (
        <ParamChip key={p} p={p} t={t} i={i} send={send} optimistic={optimistic} />
      ))}
    </span>
  );
}

function ParamChip({
  p,
  t,
  i,
  send,
  optimistic,
}: {
  p: string;
  t: GridTrackState;
  i: number;
  send: SendTrackEdit;
  optimistic: Optimistic;
}) {
  const { openMenu } = useContextMenu();
  const arm = () => {
    optimistic((tt) => ({ ...tt, activeCellParameterName: p }));
    send({ op: "setActiveCellParameter", trackIndex: i, mode: p });
  };
  const focusId = `track/${i}/chip/${p}`;
  const { isFocused, scopedFocusId } = usePressFocus(focusId, arm);
  return (
    <button
      className={`trk-chip${t.activeCellParameterName === p ? " on" : ""}${
        isFocused ? " focused" : ""
      }`}
      title={`Arm ${cellParamChipLabel(p)} for per-cell editing (ö/ä · vertical drag) — right-click: clear per-cell values`}
      data-focus-id={scopedFocusId}
      onClick={arm}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(
          [
            {
              kind: "item",
              label: `Clear per-cell ${cellParamChipLabel(p)}`,
              onSelect: () => send({ op: "clearCellParameter", trackIndex: i, mode: p }),
            },
          ],
          e.clientX,
          e.clientY,
        );
      }}
    >
      {cellParamChipLabel(p)}
      {paramHasCellData(t, p) && <span className="trk-chip-dot" />}
    </button>
  );
}

/**
 * Editable track name (native EditableTrackNameLabel): double-click to edit
 * inline; Enter commits (`renameTrack` — empty resets to the derived name),
 * Escape cancels. Single click stays inert so the header never eats grid focus.
 */
export function TrackNameEditor({
  name,
  trackIndex,
  colorHex,
  send,
  selected = false,
  onToggleSelect,
}: {
  name: string;
  trackIndex: number;
  colorHex: string;
  send: SendTrackEdit;
  /** C3: in the ⌘-click multi-selection (the ops below fan out across it). */
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const { openMenu } = useContextMenu();
  // The name IS the track's colour swatch — it carries the row identity that
  // the left colour bar used to (universal override still wins).
  const color = trackDisplayColor(colorHex);
  if (editing === null) {
    return (
      <span
        className={`trk-name${selected ? " sel" : ""}`}
        style={{ color }}
        title={
          "Double-click to rename (right-click: reset to the derived name)\n" +
          "⌘-click: add/remove from the multi-track selection — STEP, REG/OWN, ↻, direction, " +
          "output and tuning then apply to every selected track at once"
        }
        onClick={(e) => {
          // ⌘ ONLY. Native reserves ⇧ for cell selection, so inventing a ⇧ gesture here would
          // collide with the grid. A plain click stays inert on purpose — the header must not
          // eat grid focus (clicking a CELL is what moves the cursor and replaces the selection).
          if (e.metaKey && onToggleSelect) {
            e.preventDefault();
            e.stopPropagation();
            onToggleSelect();
          }
        }}
        onDoubleClick={() => setEditing(name)}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(
            [
              { kind: "item", label: "Enter name…", onSelect: () => setEditing(name) },
              {
                kind: "item",
                label: "Reset to default name",
                // Empty string = reset to the derived (sample) name, Swift-side.
                onSelect: () => send({ op: "renameTrack", trackIndex, mode: "" }),
              },
              { kind: "sep" },
              // MB-5 relocations (v80): the menu bar's topology items, moved to
              // the track they act on — which deletes the word "Selected" from
              // their labels by construction. INTENTS: Swift owns topology
              // (MB-1c) and guards the caps (16-per-type, last-track).
              {
                kind: "item",
                label: "Duplicate Track",
                onSelect: () => send({ op: "duplicateTrack", trackIndex }),
              },
              {
                kind: "item",
                label: "Delete Track",
                onSelect: () => send({ op: "deleteTrack", trackIndex }),
              },
              { kind: "sep" },
              {
                kind: "item",
                label: "Move Up",
                onSelect: () => send({ op: "moveTrackUp", trackIndex }),
              },
              {
                kind: "item",
                label: "Move Down",
                onSelect: () => send({ op: "moveTrackDown", trackIndex }),
              },
            ],
            e.clientX,
            e.clientY,
          );
        }}
      >
        {name || `TRK ${trackIndex + 1}`}
      </span>
    );
  }
  return (
    <input
      className="trk-name-input"
      style={{ color }}
      value={editing}
      autoFocus
      onChange={(e) => setEditing(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep grid keyboard lanes out of the editor
        if (e.key === "Enter") {
          send({ op: "renameTrack", trackIndex, mode: editing });
          setEditing(null);
        } else if (e.key === "Escape") {
          setEditing(null);
        }
      }}
      onBlur={() => setEditing(null)}
    />
  );
}

/**
 * Per-track colour swatch (native ColorPickerBox, DraggableNumberBox.swift).
 * Sits with the name in the compose identity row — the colour picker the SwiftUI
 * row exposed, brought back after the web migration dropped it. Click opens the
 * 8-colour palette menu (a direct pick, not native's 8-tap cycle); the current
 * colour carries a check. Writes `setColor` (mode = hex) → `updateTrackColor`.
 */
export function TrackColorSwatch({
  trackIndex,
  colorHex,
  send,
  optimistic,
}: {
  trackIndex: number;
  colorHex: string;
  send: SendTrackEdit;
  optimistic: Optimistic;
}) {
  const { openMenu } = useContextMenu();
  const swatch = trackDisplayColor(colorHex);
  const currentHex = colorHex.toUpperCase();
  const pick = (hex: string) => {
    // Optimistic echo so the swatch (and the name, which wears the same colour)
    // update on the frame; Swift pushes the authoritative colorHex back.
    optimistic((tt) => ({ ...tt, colorHex: hex }));
    send({ op: "setColor", trackIndex, mode: hex });
  };
  const openPalette = (clientX: number, clientY: number) => {
    openMenu(
      TRACK_PALETTE.map((c) => ({
        kind: "item" as const,
        label: c.name,
        swatch: c.hex,
        checked: c.hex.toUpperCase() === currentHex,
        onSelect: () => pick(c.hex),
      })),
      clientX,
      clientY,
    );
  };
  return (
    <button
      type="button"
      className="trk-color"
      style={{ background: swatch }}
      title="Track colour — click to choose"
      onClick={(e) => {
        e.stopPropagation();
        openPalette(e.clientX, e.clientY);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openPalette(e.clientX, e.clientY);
      }}
    />
  );
}

/**
 * One mapped modifier routing (native ModSlotView): bipolar depth −1…1 with a
 * `M<n>·<TARGET>` label inside the bar. Data-driven — a slot exists only for a
 * routing the user mapped. Right-click unmaps it.
 */
function ModSlot(props: {
  ctx: BandCtx;
  slot: { channelIndex: number; target: string; targetShort: string; depth: number };
}) {
  const { ctx, slot } = props;
  const { i, send, optimistic } = ctx;
  const label = `M${slot.channelIndex + 1}·${slot.targetShort}`;
  const write = (v: number) => {
    // Optimistic echo on the matching slot (depth lives in flat lfo* fields
    // Swift-side; the local mirror keeps the drag smooth).
    optimistic((tt) => ({
      ...tt,
      modSlots: tt.modSlots.map((s) =>
        s.channelIndex === slot.channelIndex && s.target === slot.target ? { ...s, depth: v } : s,
      ),
    }));
    send({
      op: "setModDepth",
      trackIndex: i,
      index: slot.channelIndex,
      mode: slot.target,
      value: v,
    });
  };
  // Native puts Unmap behind a menu item (ContentView ModSlotView :12046) —
  // a bare right-click must not silently destroy the routing.
  const menu: MenuItem[] = [
    {
      kind: "item",
      label: `Unmap from M${slot.channelIndex + 1}`,
      onSelect: () =>
        send({ op: "unmapMod", trackIndex: i, index: slot.channelIndex, mode: slot.target }),
    },
  ];
  const onContextMenu = useDragBoxMenu({ value: slot.depth, min: -1, max: 1, onChange: write, menu });
  return (
    // The slot IS the per-channel depth editor, so it wears its channel's color:
    // it was the one modulation surface with no identity at all, which made a row
    // of `M1·VOL M3·PAN M1·PIT` slots read as an undifferentiated wall.
    <div
      className="trk-paired sem sem-fill"
      style={{ "--sem-color": modColor(slot.channelIndex) } as React.CSSProperties}
      onContextMenu={onContextMenu}
      title={`${label} depth (right-click: unmap)`}
    >
      <DragBox
        menu={menu}
        id={`track/${i}/mod/${slot.channelIndex}/${slot.target}`}
        value={slot.depth}
        display={String(Math.round(slot.depth * 100))}
        min={-1}
        max={1}
        step={0.05}
        defaultValue={0}
        onChange={write}
      />
      <GeoRange
        value={slot.depth}
        min={-1}
        max={1}
        step={0.01}
        origin="center"
        label={label}
        onChange={write}
      />
    </div>
  );
}

/**
 * Row trim bar (native RowTrimWaveformView + S/E boxes) — since TR-FT-4 the
 * whole SAMPLE-WINDOW row: S · waveform · E, plus the mode-dependent window
 * boxes (loop Ls/Le/Lx · chop ÷ count + CH select · OWN Atk/Rel) in
 * signal-flow order. With
 * the chopper active the waveform draws the chop segments; CLICKING a segment
 * selects it (setDefaultChop) and DRAGGING a boundary moves that chop point
 * (setChopPoint; double-click a boundary → resetChopPoint, back to
 * auto-distribute). Dragging near the S/E handles still trims. Reuses the
 * grid's getSamplePeaks cache.
 */
function TrimBar({ ctx, compact = false }: { ctx: BandCtx; compact?: boolean }) {
  const { t, i, peaks, send, optimistic } = ctx;
  const { openMenu } = useContextMenu();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** "start"/"end" = trim handles; a number = that chop point's index. */
  const dragRef = useRef<"start" | "end" | number | null>(null);
  const dur = Math.max(1, t.sampleDurationMs);
  const startFrac = Math.max(0, Math.min(1, t.sampleStartMs / dur));
  const endFrac = Math.max(startFrac, Math.min(1, (t.sampleEndMs > 0 ? t.sampleEndMs : dur) / dur));
  // TR-FT-10: chop segments render ONLY while the chopper is toggled on
  // (defaultChopIndex ≥ 0) — engine parity (NativeAudioEngineCore :4449 gates
  // the whole slice path on it), and OWN tracks with the chopper off keep a
  // clean trim bar.
  const chopMode =
    t.playbackMode === "owner" && t.defaultChopIndex >= 0 && t.chopPointsMs.length > 0;
  // Compact (DJ name line): the bar + S/E only. The mode-dependent window
  // boxes (loop Ls/Le/Lx · chop ÷/CH · OWN Atk/Rel) are sound design, not
  // performance — the canvas itself keeps ALL its gestures (trim drag, chop
  // boundary drag, segment select), which is exactly the performative part.
  const loopShown = t.loopEnabled && !compact;
  const ownShown = t.playbackMode === "owner" && !compact;

  /** Chop points as fractions, in payload order (index k = chop k). These ARE
   *  the segment START times (native effectiveChopPoints), so segment k spans
   *  point[k] → point[k+1] (last segment runs to the sample end). The earlier
   *  `[0, ...pts, 1]` was wrong: point[0] is already 0 when auto-distributed,
   *  which produced a zero-width first segment. */
  const chopFracs = (): number[] =>
    t.chopPointsMs.map((ms) => Math.max(0, Math.min(1, ms / dur)));

  /** The chop point whose boundary sits within `tolPx` of `frac` (null = none).
   *  Chop 0 is excluded from dragging when it sits at the very start — there
   *  is nothing to the left of it and it collides with the S handle. */
  const chopPointNear = (frac: number, tolPx: number, widthPx: number): number | null => {
    const tol = tolPx / Math.max(1, widthPx);
    let best: number | null = null;
    let bestD = Infinity;
    chopFracs().forEach((f, k) => {
      if (k === 0 && f <= tol) return; // pinned at the start; S handle owns it
      const d = Math.abs(frac - f);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = k;
      }
    });
    return best;
  };

  // Draw the envelope + in-trim highlight (device-pixel crisp).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2 = canvas.getContext("2d");
    if (!ctx2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    ctx2.clearRect(0, 0, w, h);
    // in-trim light field
    const sx = startFrac * w;
    const ex = endFrac * w;
    ctx2.fillStyle = css("--bg-raised");
    ctx2.fillRect(sx, 0, Math.max(1, ex - sx), h);

    const minMax = peaks?.minMax ?? [];
    const cols = minMax.length / 2;
    const midY = h / 2;
    const amp = (h / 2 - 1) * 0.9;
    if (cols >= 2) {
      const cText = css("--text");
      const cDim = css("--text-dim");
      for (let x = 0; x < w; x++) {
        const c = Math.min(cols - 1, Math.floor((x / w) * cols));
        const mn = minMax[c * 2] ?? 0;
        const mx = minMax[c * 2 + 1] ?? 0;
        const frac = x / w;
        const inTrim = frac >= startFrac && frac <= endFrac;
        ctx2.strokeStyle = inTrim ? cText : cDim;
        ctx2.globalAlpha = inTrim ? TRIM.inTrim : TRIM.outTrim;
        ctx2.beginPath();
        ctx2.moveTo(x + 0.5, midY - Math.abs(mx) * amp);
        ctx2.lineTo(x + 0.5, midY + Math.abs(mn) * amp);
        ctx2.stroke();
      }
      ctx2.globalAlpha = 1;
    }
    // Chop segments (OWN + chopper): the SELECTED segment tinted + a DRAGGABLE
    // boundary per chop point. Segment k spans point[k] → point[k+1] (last one
    // runs to the sample end). Boundaries carry a grab tab so they read as
    // movable (TR-FT-6 — they were static ticks before).
    if (chopMode) {
      const fr = chopFracs();
      const sel = t.defaultChopIndex;
      if (sel >= 0 && sel < fr.length) {
        const a = fr[sel]!;
        const b = sel + 1 < fr.length ? fr[sel + 1]! : 1;
        ctx2.fillStyle = css("--accent");
        // The same selection tint the grid uses — one idiom for "this is chosen".
        ctx2.globalAlpha = currentTokens().surface.selectionAlpha;
        ctx2.fillRect(a * w, 0, Math.max(1, (b - a) * w), h);
        ctx2.globalAlpha = 1;
      }
      ctx2.strokeStyle = css("--warn");
      ctx2.fillStyle = css("--warn");
      ctx2.lineWidth = 1;
      fr.forEach((f, k) => {
        if (k === 0 && f <= 0.001) return; // pinned at the start (S handle owns it)
        const bx = Math.round(f * w) + 0.5;
        ctx2.beginPath();
        ctx2.moveTo(bx, 0);
        ctx2.lineTo(bx, h);
        ctx2.stroke();
        // grab tab (top) — the affordance that says "drag me"
        ctx2.fillRect(bx - 2, 0, 4, 3);
      });
    }
    // S/E handle ticks
    ctx2.strokeStyle = css("--accent");
    ctx2.lineWidth = 1;
    for (const hx of [sx, ex]) {
      ctx2.beginPath();
      ctx2.moveTo(Math.max(0.5, Math.min(w - 0.5, hx)), 0);
      ctx2.lineTo(Math.max(0.5, Math.min(w - 0.5, hx)), h);
      ctx2.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, startFrac, endFrac, t.sampleStartMs, t.sampleEndMs, chopMode, t.defaultChopIndex, t.chopPointsMs]);

  /**
   * ⚠️ Drag sends are COALESCED to frame rate — do not send per pointermove.
   *
   * Every trim/chop send is a full-document publish under owner mode, and on the
   * desktop each publish costs Swift a JSON decode + a whole engine-state push.
   * Raw pointer-rate sends (120 Hz+) arrive faster than that pipeline drains, the
   * main thread backlog grows without bound, and the app freezes — the
   * 2026-07-17 trim-bar incident. Only the LATEST value per op survives a frame;
   * `flushDragSends` runs once per rAF, and pointer-up flushes synchronously so
   * the settled value always lands. The optimistic echo stays per-move (cheap,
   * and it is what makes the drag feel instant).
   */
  const pendingSends = useRef(new Map<string, Record<string, unknown>>());
  const flushHandle = useRef<number | null>(null);
  const flushDragSends = () => {
    flushHandle.current = null;
    const batch = pendingSends.current;
    pendingSends.current = new Map();
    batch.forEach((params) => send(params));
  };
  const sendCoalesced = (key: string, params: Record<string, unknown>) => {
    pendingSends.current.set(key, params);
    if (flushHandle.current === null) {
      flushHandle.current = requestAnimationFrame(flushDragSends);
    }
  };
  const endDrag = () => {
    dragRef.current = null;
    if (flushHandle.current !== null) {
      cancelAnimationFrame(flushHandle.current);
      flushDragSends();
    }
  };
  useEffect(
    () => () => {
      // Unmounted mid-drag: drop the frame, never send into a dead panel.
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current);
    },
    [],
  );

  const onDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const d = dragRef.current;
    if (!canvas || d === null) return;
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ms = frac * dur;
    if (typeof d === "number") {
      // Chop boundary: keep it strictly between its neighbours so segments
      // never invert (Swift also clamps to the sample duration).
      const fr = chopFracs();
      const lo = (d > 0 ? (fr[d - 1] ?? 0) : 0) * dur + 1;
      const hi = (d + 1 < fr.length ? (fr[d + 1] ?? 1) : 1) * dur - 1;
      const v = Math.max(lo, Math.min(hi, ms));
      optimistic((tt) => {
        const pts = tt.chopPointsMs.slice();
        pts[d] = v;
        return { ...tt, chopPointsMs: pts };
      });
      sendCoalesced(`chop${d}`, { op: "setChopPoint", trackIndex: i, index: d, value: v });
      return;
    }
    if (d === "start") {
      const v = Math.max(0, Math.min(ms, t.sampleEndMs - 1));
      optimistic((tt) => ({ ...tt, sampleStartMs: v }));
      sendCoalesced("start", { op: "setSampleStart", trackIndex: i, value: v });
    } else {
      const v = Math.max(t.sampleStartMs + 1, ms);
      optimistic((tt) => ({ ...tt, sampleEndMs: v }));
      sendCoalesced("end", { op: "setSampleEnd", trackIndex: i, value: v });
    }
  };

  // TR-FT-7: a FRAGMENT, not a row — the trim bar is rendered INSIDE the
  // identity row so the waveform fills all the width left of it (one row
  // saved). `.trk-trim-wave` keeps `flex:1 1 0`, so it absorbs the slack.
  return (
    <>
      <span className="trk-vsep" />
      <BoxOnly
        ctx={ctx}
        slug="sstart"
        modTarget="sampleStart"
        scenePin={{ key: `track.${i}.sampleStartMs` }}
        label="S"
        value={t.sampleStartMs}
        display={String(Math.round(t.sampleStartMs))}
        min={0}
        max={dur}
        step={1}
        onChange={(v) => {
          optimistic((tt) => ({ ...tt, sampleStartMs: v }));
          send({ op: "setSampleStart", trackIndex: i, value: v });
        }}
      />
      <canvas
        ref={canvasRef}
        className="trk-trim-wave"
        onPointerDown={(e) => {
          if (e.button !== 0) return; // secondary click opens the crop menu, never drags
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const handlePx = 8 / Math.max(1, rect.width);
          // Priority: chop BOUNDARY drag (finest target) → S/E trim handle →
          // chop segment select. A boundary wins within 5px so it stays
          // grabbable even when it sits near a trim handle.
          if (chopMode) {
            const cp = chopPointNear(frac, 5, rect.width);
            if (cp !== null) {
              dragRef.current = cp;
              e.currentTarget.setPointerCapture(e.pointerId);
              onDrag(e);
              return;
            }
          }
          const nearTrim =
            Math.abs(frac - startFrac) <= handlePx || Math.abs(frac - endFrac) <= handlePx;
          if (chopMode && !nearTrim) {
            // Select the segment under the pointer (segment k = point[k]…point[k+1]).
            const fr = chopFracs();
            let seg = 0;
            while (seg < fr.length - 1 && frac >= fr[seg + 1]!) seg++;
            optimistic((tt) => ({ ...tt, defaultChopIndex: seg }));
            send({ op: "setDefaultChop", trackIndex: i, value: seg });
            return;
          }
          dragRef.current = Math.abs(frac - startFrac) <= Math.abs(frac - endFrac) ? "start" : "end";
          e.currentTarget.setPointerCapture(e.pointerId);
          onDrag(e);
        }}
        onPointerMove={(e) => {
          // Hover cursor: a boundary advertises the horizontal drag.
          if (dragRef.current === null) {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const overBoundary = chopMode && chopPointNear(frac, 5, rect.width) !== null;
            e.currentTarget.style.cursor = overBoundary ? "ew-resize" : "pointer";
            return;
          }
          onDrag(e);
        }}
        onDoubleClick={(e) => {
          // Double-click a boundary → reset that chop point to auto-distribute.
          if (!chopMode) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const cp = chopPointNear(frac, 6, rect.width);
          if (cp !== null) send({ op: "resetChopPoint", trackIndex: i, index: cp });
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => {
          // Right-click → "Crop to trim": bake [S,E] into a new file (Swift-owned).
          // No-op when the window already spans the whole sample.
          e.preventDefault();
          const full = t.sampleStartMs <= 0 && (t.sampleEndMs <= 0 || t.sampleEndMs >= dur);
          openMenu(
            [{ kind: "item", label: "Crop to trim", disabled: full,
               onSelect: () => send({ op: "cropSample", trackIndex: i }) }],
            e.clientX, e.clientY,
          );
        }}
      />
      <BoxOnly
        ctx={ctx}
        slug="send"
        modTarget="sampleEnd"
        scenePin={{ key: `track.${i}.sampleEndMs` }}
        label="E"
        value={t.sampleEndMs}
        display={String(Math.round(t.sampleEndMs))}
        min={0}
        max={dur}
        step={1}
        onChange={(v) => {
          optimistic((tt) => ({ ...tt, sampleEndMs: v }));
          send({ op: "setSampleEnd", trackIndex: i, value: v });
        }}
      />
      {/* Mode-dependent sample-window boxes ride the trim row (TR-FT-4). */}
      {loopShown && (
        <>
          <BoxOnly
            ctx={ctx}
            slug="loopstart"
            label="Ls"
            value={t.loopStartMs}
            display={String(Math.round(t.loopStartMs))}
            min={0}
            max={dur}
            step={1}
            onChange={(v) => {
              optimistic((tt) => ({ ...tt, loopStartMs: v }));
              send({ op: "setLoopStart", trackIndex: i, value: v });
            }}
          />
          <BoxOnly
            ctx={ctx}
            slug="loopend"
            label="Le"
            value={t.loopEndMs}
            display={String(Math.round(t.loopEndMs))}
            min={0}
            max={dur}
            step={1}
            onChange={(v) => {
              optimistic((tt) => ({ ...tt, loopEndMs: v }));
              send({ op: "setLoopEnd", trackIndex: i, value: v });
            }}
          />
          <BoxOnly
            ctx={ctx}
            slug="loopxf"
            label="Lx"
            value={t.loopCrossfadeMs}
            display={String(Math.round(t.loopCrossfadeMs))}
            min={0}
            max={500}
            step={1}
            onChange={(v) => {
              optimistic((tt) => ({ ...tt, loopCrossfadeMs: v }));
              send({ op: "setLoopCrossfade", trackIndex: i, value: v });
            }}
          />
        </>
      )}
      {chopMode && !compact && (
        <>
          <BoxOnly
            ctx={ctx}
            slug="chopcount"
            label="÷"
            value={t.chopPointsMs.length}
            display={String(t.chopPointsMs.length)}
            min={1}
            max={8}
            step={1}
            onChange={(v) => {
              const n = Math.max(1, Math.min(8, Math.round(v)));
              // Mirror Swift setChopCount: every point back to auto-distribute
              // (equal slices), default + per-cell selections clamped in range.
              optimistic((tt) => {
                const d = tt.sampleDurationMs > 0 ? tt.sampleDurationMs : 1;
                return {
                  ...tt,
                  chopPointsMs: Array.from({ length: n }, (_, k) => (d * k) / n),
                  defaultChopIndex: Math.min(tt.defaultChopIndex, n - 1),
                  cellChopIndices: tt.cellChopIndices.map((c) =>
                    c < 0 ? -1 : Math.min(c, n - 1),
                  ),
                };
              });
              send({ op: "setChopCount", trackIndex: i, value: n });
            }}
          />
          <BoxOnly
            ctx={ctx}
            slug="chop"
            label="CH"
            value={t.defaultChopIndex}
            display={t.defaultChopIndex < 0 ? "-" : String(t.defaultChopIndex + 1)}
            min={0}
            max={Math.max(0, t.chopPointsMs.length)}
            step={1}
            onChange={(v) => {
              const seg = Math.round(v);
              optimistic((tt) => ({ ...tt, defaultChopIndex: seg }));
              send({ op: "setDefaultChop", trackIndex: i, value: seg });
            }}
          />
        </>
      )}
      {ownShown && (
        <>
          <BoxOnly
            ctx={ctx}
            slug="ownatk"
            label="Atk"
            value={t.ownerAttack}
            display={`${Math.round(t.ownerAttack)}%`}
            min={0}
            max={100}
            step={1}
            onChange={(v) => {
              optimistic((tt) => ({ ...tt, ownerAttack: v }));
              send({ op: "setOwnerAttack", trackIndex: i, value: v });
            }}
          />
          <BoxOnly
            ctx={ctx}
            slug="owngate"
            label="Rel"
            value={t.ownerGate}
            display={`${Math.round(t.ownerGate === 0 ? 100 : t.ownerGate)}%`}
            min={1}
            max={100}
            step={1}
            onChange={(v) => {
              optimistic((tt) => ({ ...tt, ownerGate: v }));
              send({ op: "setOwnerGate", trackIndex: i, value: v });
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * DJ variant (user layout, 2026-07-12; row order + trim bar 2026-07-16).
 * The DJ deck row is a PERFORMANCE surface, so it drops the sound-design
 * controls (sample browse, cell-param chips + mark tools, swing /
 * pre-silence / pattern-start, choke / voice / stereo) and orders what's
 * left in COMPOSE order — pattern row first, identity row second:
 *
 *   1 — play · STEP · locator · RATE (multiply detents ⊕ free tape rate)
 *   2 — name · trim bar (S · waveform · E) · M · S · IN
 *   3 — gain · pitch · filter · pan · volume
 *   4 — modifier sliders
 *   5 — send sliders
 *
 * The trim bar rides the name line (compact: no loop/chop/own boxes) so
 * S/E can be played live — dragging the sample window IS a DJ gesture.
 *
 * It is the SAME controls, not a fork: every box/slider below is shared with
 * the compose row, so a fix to either lands on both (djmode.md §8 Q1).
 */
/**
 * P8-9 — the inert form of a native-only control. Rendered when the DOCUMENT
 * carries a binding this host cannot drive (preserve-don't-drop: the fields
 * stay in the file, and the user must be able to see why a bound track makes
 * no sound here). Joins no FocusModel, sends nothing.
 */
function DesktopBadge({ label, why }: { label: string; why: string }) {
  return (
    <span className="trk-desktop-badge" title={why} aria-disabled="true">
      {label} ⌁
    </span>
  );
}

function OutputCluster({
  t,
  i,
  send,
  openInstrumentWindow,
}: {
  t: GridTrackState;
  i: number;
  send: SendTrackEdit;
  openInstrumentWindow?: (trackIndex: number) => void;
}) {
  const sampleOut = t.trackType === "audio";
  const caps = useCapabilities();

  // SMP|INST is a hard-exclusive SOURCE SWITCH (user decision 2026-07-18, supersedes the
  // three-independent-outputs model for these two): a track sounds its sample OR its
  // instrument, never both. Exclusivity is enforced Swift-side (one home) — enabling one
  // output disables the other; the UI just sends the same ops as before. The switch is
  // NEVER destructive: the sample stays loaded and the plugin stays bound (with its
  // captured state) across any number of flips. MIDI remains an independent toggle.
  return (
    <span className="trk-src" title="Source — sample OR instrument (switching never erases either); MIDI is independent">
      <Toggle
        label="SMP"
        title={
          sampleOut
            ? "Sample source active — click to silence it (the sample stays loaded)"
            : "Switch to the SAMPLE source (the instrument stays bound, with its state)"
        }
        on={sampleOut}
        focusId={`track/${i}/smpout`}
        onClick={() => send({ op: "setSampleOut", trackIndex: i, value: sampleOut ? 0 : 1 })}
      />
      {/* No plugin hosting on this host (P8-9): an unbound track shows no
          instrument affordance at all; a bound one shows the inert badge —
          hiding it would leave a silent track with no explanation. The seam
          for a future Web-MIDI/WAM host is these caps flipping true. */}
      {caps.pluginHosting ? (
        <>
          <Toggle
            label="INST"
            title={
              t.hasInstrument
                ? t.instrumentOutEnabled
                  ? `Instrument source active (${t.instrumentName}) — click to switch it off (the plugin stays bound, with its state)`
                  : `Switch to the INSTRUMENT source (${t.instrumentName} — the sample stays loaded)`
                : "No instrument yet — click to choose one"
            }
            on={t.instrumentOutEnabled}
            focusId={`track/${i}/instout`}
            onClick={() => {
              // Nothing bound yet: the honest response to "turn the instrument on" is to ask
              // WHICH instrument, not to sit there doing nothing. So the toggle opens the picker.
              if (!t.hasInstrument) {
                openInstrumentWindow?.(i);
                return;
              }
              send({ op: "setInstrumentOut", trackIndex: i, value: t.instrumentOutEnabled ? 0 : 1 });
            }}
          />
          {/* The picker is a WINDOW, not a popover — a popover cannot escape its WKWebView
              (MIX-R8), which is exactly why the FX slots gained one. Same window shell, same
              picker: the app should have ONE answer to "choose a plugin". */}
          <button
            type="button"
            className="trk-tog trk-inst"
            title={
              t.hasInstrument
                ? `${t.instrumentName} — click to change or edit`
                : "Choose an instrument plugin…"
            }
            onClick={() => openInstrumentWindow?.(i)}
          >
            {t.instrumentName ?? "PLUGIN…"}
          </button>
          {/* The plugin's OWN window, one click from the row — parameters and its native
              preset browser (the only preset access for plugins that publish no JUCE
              program list, i.e. a disabled ‹›). Only while the instance is LIVE: with
              INST off the slot is unloaded, so there is nothing to attach an editor to
              (same gate as InstrumentPanel's EDIT). A momentary action, never `on`. */}
          {t.hasInstrument && t.instrumentOutEnabled && (
            <Toggle
              label="EDIT"
              title={`Open ${t.instrumentName}'s own window — parameters + its preset browser`}
              focusId={`track/${i}/instedit`}
              onClick={() => send({ op: "openInstrumentEditor", trackIndex: i })}
            />
          )}
        </>
      ) : (
        t.instrumentOutEnabled && (
          <DesktopBadge
            label="INST"
            why="This track drives an instrument plugin on the desktop. A browser cannot host plugins — the binding is preserved in the file, but the track will not sound here."
          />
        )
      )}
      {caps.midiHardware ? (
        <Toggle
          label="MIDI"
          title={
            t.midiOutEnabled
              ? "MIDI output ON — this pattern also drives the external port"
              : "MIDI output OFF — click to also drive the external port (the track keeps sounding as it does)"
          }
          on={t.midiOutEnabled}
          tone="accent"
          focusId={`track/${i}/midiout`}
          onClick={() =>
            send({ op: "setMidiOutEnabled", trackIndex: i, value: t.midiOutEnabled ? 0 : 1 })
          }
        />
      ) : (
        t.midiOutEnabled && (
          <DesktopBadge
            label="MIDI"
            why="This track drives an external MIDI port on the desktop. This host has no MIDI output — the setting is preserved in the file, inert here."
          />
        )
      )}
    </span>
  );
}

export function TrackBand({
  t,
  i,
  peaks,
  send,
  optimistic,
  mod,
  deck,
  muteGroupActive,
  openInstrumentWindow,
  variant = "compose",
  selected = false,
  onToggleSelect,
  onRandomize,
  onClearTrack,
  registerLed,
}: BandCtx & {
  /** "perform" is a THIRD level below "dj", not a peer of it — see `dj`/`perf`
      below. Everything dj hides, perform hides too. */
  variant?: "compose" | "dj" | "perform";
  openInstrumentWindow?: (trackIndex: number) => void;
  /** C3: this track is in the ⌘-click multi-selection. */
  selected?: boolean;
  onToggleSelect?: () => void;
  /** TR-RND — regenerate / clear this track's pattern (compose only). */
  onRandomize?: () => void;
  onClearTrack?: () => void;
  /** SIG-3: registers this row's activity-LED element into the panel's one
      lighting loop (GridPanel writes its opacity from the HotFrame at rAF —
      no React state, no per-band subscription). */
  registerLed?: (trackIndex: number, el: HTMLElement | null) => void;
}) {
  /** The SAMPLE output. `trackType` is no longer a type — it is this switch. */
  const audio = t.trackType === "audio";
  /** ⚠️ NOT `variant === "dj"`. "perform" is a step further DOWN the same
      ladder, so every cluster the dj row already hides must stay hidden — a
      strict equality here would have silently brought all of them BACK the
      moment PERF was armed, which is the opposite of what PERF is for. */
  const dj = variant !== "compose";
  /** The third level (DECKPLUGIN v2 §5): mid-set, the waveform and the playhead
      are the information. These three clusters are the ones you do not reach
      for during a transition, and their height is worth more as cells. */
  const perf = variant === "perform";
  const caps = useCapabilities();

  // TR-RND — CLEAR's two-click safety. Local to this row (each track arms on its
  // own), engine-independent: the worst case of a remount mid-arm is a reset arm,
  // never a spurious clear. First click arms + starts a disarm timer; a second
  // click within the window fires.
  const [clearArmed, setClearArmed] = useState(false);
  const clearTimer = useRef<number | null>(null);
  const disarmClear = () => {
    if (clearTimer.current !== null) {
      window.clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    setClearArmed(false);
  };
  useEffect(() => disarmClear, []); // clear the pending timeout on unmount
  const onClearClick = () => {
    if (clearArmed) {
      disarmClear();
      onClearTrack?.();
    } else {
      setClearArmed(true);
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(() => {
        clearTimer.current = null;
        setClearArmed(false);
      }, 2500);
    }
  };
  /** Every learnable box in this row names itself the same way — one helper, so
   *  no site can forget the deck and silently learn another deck's track. */
  const learnable = (token: string) => trackLearnTarget(token, i, deck);
  /** This track emits NOTES — into a plugin, out to the port, or both. */
  const notes = t.instrumentOutEnabled || t.midiOutEnabled;
  /** It puts AUDIO into the mix — from its sample, from its instrument, or both. */
  const hasAudioPath = audio || t.instrumentOutEnabled;
  /** "Clear per-cell values" — on every box that owns a CellParameter. */
  const clearCells = (param: string, label: string): MenuItem => ({
    kind: "item",
    label,
    onSelect: () => send({ op: "clearCellParameter", trackIndex: i, mode: param }),
  });
  const set = (field: keyof GridTrackState, value: number | string) =>
    optimistic((tt) => withField(tt, field, value as never));

  // --- edit helpers: optimistic local echo + trackEdit command -------------
  //
  // `intent` rides along so a multi-track selection can fan the edit out (the
  // panel gates on SELECTION_FANOUT — an op not in that set drops it). The
  // optimistic echo stays single-track ON PURPOSE: the other selected tracks
  // are Swift's to move, and it pushes them back. That is the standing rule for
  // a selection-scoped op (GridPanel:2401) — TS does not model them.
  const edit = (
    field: keyof GridTrackState,
    value: number,
    params: Record<string, unknown>,
    intent?: EditIntent,
  ) => {
    set(field, value);
    send(intent ? { ...params, selectionIntent: intent } : params);
  };

  // Only "tone" is bipolar. The dedicated filter modes are unipolar 0…100 —
  // the engine folds the sign away (BeatSequencer.clampedToneValue), so a rail
  // reaching below 0 would send values that come back mirrored (native mirrors
  // this range in ContentView.toneControl).
  const toneIsFilter = t.toneFilterMode !== "tone";
  const toneValue = toneIsFilter ? Math.abs(t.tone) : t.tone;

  // Mute/solo — shared, because the DJ row keeps them on its NAME line (they
  // are performance controls you hit mid-set) while compose keeps them on the
  // identity row. One definition, so their behaviour can't drift apart.
  const groupLatched = muteGroupActive === true;
  const intent = muteButtonIntent(t, i, groupLatched);
  const muteSolo = (
    <>
      <Toggle
        label="M"
        on={t.muted}
        tone="mute"
        hot
        marked={t.muteGroupMember}
        armed={groupLatched}
        title={
          groupLatched
            ? "Mute group ACTIVE — click to add/remove this track from the group"
            : "Mute (right-click: mute group)"
        }
        focusId={`track/${i}/mute`}
        onClick={() => {
          // The optimistic echo is the MUTE only. Membership is never echoed: Swift
          // owns the set, and it now re-pushes the row when the set changes (the
          // $muteGroupMembers sink), so guessing here could only disagree with it.
          optimistic((tt) => ({ ...tt, muted: intent.muted }));
          send({ op: intent.op, trackIndex: i });
        }}
        menu={[
          {
            kind: "item",
            label: t.muteGroupMember ? "Remove from Mute Group" : "Add to Mute Group",
            onSelect: () => send({ op: "toggleMuteGroup", trackIndex: i }),
          },
        ]}
      />
      <Toggle
        label="S"
        on={t.soloed}
        tone="solo"
        hot
        title="Solo"
        focusId={`track/${i}/solo`}
        onClick={() => {
          optimistic((tt) => ({ ...tt, soloed: !tt.soloed }));
          send({ op: "toggleSolo", trackIndex: i });
        }}
      />
      {/* NK-3 — IN: lock note input to this track. It sits with mute/solo because
          it is the same kind of control: one you hit mid-set without looking.
          The pin is the ONLY note-in route (pin-only, 2026-07-15): unpinned,
          the keyboard and incoming MIDI are silent — they never follow the
          selection or the deck focus.

          Named IN because that is what SwiftUI already calls it (the per-track
          "In" menu, ContentView:4727) and both write the SAME field: one field,
          one name, two UIs.

          No optimistic echo, deliberately: the lock is EXCLUSIVE app-wide, so one
          click also releases whatever another deck held. Only Swift knows what
          that was — echoing locally would light two locks for a frame. */}
      <Toggle
        label="IN"
        on={t.midiInputPinned}
        tone="pin"
        title={
          t.midiInputPinned
            ? "Note input LOCKED to this track — it answers the keyboard and incoming MIDI no matter what is selected or which deck is focused. Click to release (note input goes silent until another track is pinned)."
            : "Lock note input to this track — the ONLY way notes reach a track: the keyboard and incoming MIDI are silent until a track is pinned."
        }
        focusId={`track/${i}/midiPin`}
        onClick={() => send({ op: "setMidiInputPin", trackIndex: i, value: t.midiInputPinned ? 0 : 1 })}
      />
    </>
  );

  return (
    <div className="trk-band">
      {/* P — PATTERN row, FIRST (TR-FT-6: pattern-relevant controls sit
          directly below the grid cells; everything sample/audio follows).
          launch/steps/direction/unified-rate/locator + the dial chips and
          mark tools. Wraps when narrow; band height is measured per track.
          DJ row 1 is exactly this row's LEFT half — play · STEP · locator ·
          RATE — with the per-cell tooling dropped (see the variant doc). */}
      <div className="trk-ctrl-row trk-tools trk-wrap">
        {/* The label shows what the track is doing NOW; `pending` pulses while a
            quantized launch/stop waits for its boundary. Which of the two is armed
            follows from `isStopped` — you can only schedule the opposite of the
            current state — so the pushed flag needs no direction. */}
        <Toggle
          label={t.isStopped ? "▶" : "■"}
          on={!t.isStopped}
          hot
          pending={t.launchScheduled}
          title={
            t.isStopped
              ? t.launchScheduled
                ? "Play scheduled — click to cancel"
                : "Play track"
              : t.launchScheduled
                ? "Stop scheduled — click to cancel"
                : "Stop track"
          }
          focusId={`track/${i}/launch`}
          onClick={() => send({ op: "toggleLaunch", trackIndex: i })}
        />
        <StepCount
          value={t.stepCount}
          onChange={(v) => edit("stepCount", v, { op: "setStepCount", trackIndex: i, value: v })}
          box={
            <BoxOnly
              ctx={{ t, i, send, optimistic, mod }}
              slug="steps"
              label="STEP"
              value={t.stepCount}
              display={String(t.stepCount)}
              min={STEP_MIN}
              max={STEP_MAX}
              step={1}
              onChange={(v) =>
                edit("stepCount", v, { op: "setStepCount", trackIndex: i, value: v })
              }
            />
          }
        />
        {/* Locator window: ⌊ start · len ⌉ + repeat toggle. Placed BEFORE the
            rate control (user, 2026-07-16) so it sits within easy reach; the
            repeat toggle wears the locator's --warn identity (its grid brackets)
            so it never reads as the neighbouring rate-reset ⟲. */}
        <span className="trk-loc-group">
          <span className="trk-bracket">⌊</span>
          <BoxOnly
            ctx={{ t, i, send, optimistic, mod }}
            slug="locstart"
            label=""
            value={t.locatorStartStep + 1}
            display={String(t.locatorStartStep + 1)}
            min={1}
            max={t.stepCount}
            step={1}
            onChange={(v) =>
              send({ op: "adjustLocatorStart", trackIndex: i, value: v - (t.locatorStartStep + 1) })
            }
          />
          <BoxOnly
            ctx={{ t, i, send, optimistic, mod }}
            slug="loclen"
            label=""
            value={t.locatorLengthSteps}
            display={String(t.locatorLengthSteps)}
            min={1}
            max={t.stepCount}
            step={1}
            onChange={(v) =>
              send({ op: "adjustLocatorLength", trackIndex: i, value: v - t.locatorLengthSteps })
            }
          />
          <span className="trk-bracket">⌉</span>
          <Toggle
            label="↻"
            on={t.locatorRepeatActive}
            tone="locator"
            hot
            title="Locator repeat — loop the ⌊ start · length ⌉ window"
            focusId={`track/${i}/locrepeat`}
            onClick={() => send({ op: "toggleLocatorRepeat", trackIndex: i })}
          />
        </span>
        {/* Unified rate (TR-FT-9): replaces the ‹1:4…4:1› multiply stepper,
            the separate free-rate box AND the →/← direction toggle — the
            slider's left-side detents ARE backwards playback. */}
        <RateControl t={t} i={i} send={send} optimistic={optimistic} />
        {/* Per-cell tools mount for ANY track that sounds — the sample lane OR a
            note emitter. The engine has honoured accent/glide/flam/chord/pre-
            silence/swing on note tracks since UT-1; gating this cluster on
            `audio` alone was what made CHORD (and every cell tool) vanish the
            moment SMP went off. Sample-only tools stay behind `audio` inside. */}
        {(audio || notes) && !dj && (
          <>
          <span className="trk-vsep" />
          <ParamChips t={t} i={i} send={send} optimistic={optimistic} />
          <span className="trk-vsep" />
          <CellTool
            label={accentToolLabel(t.accentLevels)}
            param="accent"
            clearLabel="Clear All Accents"
            focusId={`track/${i}/tool/accent`}
            active={t.activeCellParameterName === "accent"}
            title="Accent — select, then edit accents in the grid (right-click: clear all)"
            onSelect={() => send({ op: "setActiveCellParameter", trackIndex: i, mode: "accent" })}
            onClear={() => send({ op: "clearCellParameter", trackIndex: i, mode: "accent" })}
          />
          <CellTool
            label={glideToolLabel(t.glideSteps)}
            param="glide"
            clearLabel="Clear All Glides"
            focusId={`track/${i}/tool/glide`}
            active={t.activeCellParameterName === "glide"}
            title="Glide — select, then toggle glide in the grid (right-click: clear all)"
            onSelect={() => send({ op: "setActiveCellParameter", trackIndex: i, mode: "glide" })}
            onClear={() => send({ op: "clearCellParameter", trackIndex: i, mode: "glide" })}
          />
          <BoxOnly
            ctx={{ t, i, send, optimistic, mod }}
            slug="glidepct"
            label="G%"
            value={t.glidePercent}
            display={formatGlidePercent(t.glidePercent)}
            min={0}
            max={100}
            step={1}
            onChange={(v) =>
              edit("glidePercent", v, { op: "setGlidePercent", trackIndex: i, value: v })
            }
          />
          <CellTool
            label={flamToolLabel(t.flamCounts)}
            param="flam"
            clearLabel="Clear All Flams"
            focusId={`track/${i}/tool/flam`}
            active={t.activeCellParameterName === "flam"}
            title="Flam — select, then edit flam in the grid (right-click: clear all)"
            onSelect={() => send({ op: "setActiveCellParameter", trackIndex: i, mode: "flam" })}
            onClear={() => send({ op: "clearCellParameter", trackIndex: i, mode: "flam" })}
          />
          {/* TR-4f: per-cell CHORD tool. Family-1 dial (grid.md §8) — arming it
              makes ö/ä + vertical drag cycle the curated ChordLibrary
              (OFF · OCT · 5TH · … · AD9) on the focused cell; Swift's
              adjustStepParameter .chord clamps at both ends (no wrap). The
              library itself is Swift-owned; the web only moves the index. */}
          <CellTool
            label={chordToolLabel(t.chordIndices)}
            param="chord"
            clearLabel="Clear all chords"
            focusId={`track/${i}/tool/chord`}
            active={t.activeCellParameterName === "chord"}
            title="Chord — select, then dial each cell's voicing in the grid (right-click: clear all chords)"
            onSelect={() => send({ op: "setActiveCellParameter", trackIndex: i, mode: "chord" })}
            onClear={() => send({ op: "clearCellParameter", trackIndex: i, mode: "chord" })}
          />
          {/* TR-FT-10: per-cell chop tool — only while the chopper is toggled
              on (engine ignores cellChopIndices otherwise, :4449). ö/ä /
              vertical drag cycles − → C1…Cn → − (Swift adjustStepParameter
              .chop); − = the track's default slice. */}
          {audio && t.playbackMode === "owner" && t.defaultChopIndex >= 0 && (
            <CellTool
              label={chopToolLabel(t.cellChopIndices)}
              param="chop"
            clearLabel="Clear all chops"
              focusId={`track/${i}/tool/chop`}
              active={t.activeCellParameterName === "chop"}
              title="Chop — select, then dial each cell's slice in the grid (− = default slice; right-click: clear all)"
              onSelect={() => send({ op: "setActiveCellParameter", trackIndex: i, mode: "chop" })}
              onClear={() => send({ op: "clearCellParameter", trackIndex: i, mode: "chop" })}
            />
          )}
          <BoxOnly
            ctx={{ t, i, send, optimistic, mod }}
            slug="presilence"
            label="PS"
            value={t.preSilenceMs}
            display={String(Math.round(t.preSilenceMs))}
            min={0}
            max={1000}
            step={1}
            onChange={(v) =>
              edit("preSilenceMs", v, { op: "setPreSilence", trackIndex: i, value: v })
            }
          />
          <BoxOnly
            ctx={{ t, i, send, optimistic, mod }}
            slug="swing"
            label="SW"
            value={Math.round(t.swing * 100)}
            display={formatSwing(t.swing)}
            min={0}
            max={100}
            step={1}
            onChange={(v) => {
              optimistic((tt) => withField(tt, "swing", v / 100));
              send({ op: "setSwing", trackIndex: i, value: v });
            }}
          />
          <BoxOnly
            ctx={{ t, i, send, optimistic, mod }}
            slug="patstart"
            label="ST"
            value={t.patternStartStep ?? 0}
            display={String(t.patternStartStep ?? 0)}
            min={0}
            max={Math.max(0, t.stepCount - 1)}
            step={1}
            onChange={(v) =>
              edit("patternStartStep", v, { op: "setPatternStart", trackIndex: i, value: v })
            }
          />
          </>
        )}
        {/* TR-RND — per-track pattern tools, at the RIGHT end of the tools band.
            Compose only (`!dj`); shown for MIDI tracks too (they have a pattern
            worth randomizing/clearing). RANDOMIZE regenerates a fresh musical
            pattern; its right-click menu is reserved for the future musical
            randomization menu. CLEAR needs two clicks (armed via `clearArmed`). */}
        {!dj && (
          <>
            <span className="trk-vsep" />
            <Toggle
              label="⚄"
              title="Randomize this track's pattern"
              focusId={`track/${i}/randomize`}
              onClick={() => {
                disarmClear();
                onRandomize?.();
              }}
              menu={[
                { kind: "item", label: "Randomize", onSelect: () => onRandomize?.() },
              ]}
            />
            <Toggle
              label={clearArmed ? "CLR?" : "CLR"}
              on={clearArmed}
              title={
                clearArmed
                  ? "Click again to clear this track"
                  : "Clear this track's pattern (click twice)"
              }
              focusId={`track/${i}/clear`}
              onClick={onClearClick}
            />
          </>
        )}
      </div>


      {/* DJ name line — SECOND, mirroring compose's P-then-H order: identity,
          the trim bar as a live instrument (compact — the window boxes are
          sound design, the bar itself is the performance surface), and the
          controls you hit mid-set (M/S/IN). */}
      {dj && (
        <div className="trk-ctrl-row trk-dj-name">
          <TrackNameEditor name={t.name} trackIndex={i} colorHex={t.colorHex} send={send} selected={selected} onToggleSelect={onToggleSelect} />
          {t.trackType === "midi" && <span className="trk-tag">MIDI</span>}
          {audio && t.sampleKey && <TrimBar ctx={{ t, i, peaks, send, optimistic, mod }} compact />}
          {muteSolo}
        </div>
      )}

      {/* H — identity/source in signal-flow order (TR-FT-4 user layout):
          name → browse → open → mute → solo → sample mode.
          DJ has no H row: its name + M/S + trim bar ride the DJ name line, and
          sample browsing / sub-modes are sound design, not performance. */}
      {!dj && (
      <div className="trk-ctrl-row trk-wrap">
        <TrackColorSwatch trackIndex={i} colorHex={t.colorHex} send={send} optimistic={optimistic} />
        <TrackNameEditor name={t.name} trackIndex={i} colorHex={t.colorHex} send={send} selected={selected} onToggleSelect={onToggleSelect} />
        <OutputCluster t={t} i={i} send={send} openInstrumentWindow={openInstrumentWindow} />
        {audio && (
          <span className="trk-browse">
            <Toggle
              label="◀"
              title="Previous sample"
              focusId={`track/${i}/brwprev`}
              onClick={() => send({ op: "browseSample", trackIndex: i, value: -1 })}
            />
            <Toggle
              label="▶"
              title="Next sample"
              focusId={`track/${i}/brwnext`}
              onClick={() => send({ op: "browseSample", trackIndex: i, value: 1 })}
            />
            <Toggle
              label="LOAD"
              title="Load sample… (native file dialog)"
              focusId={`track/${i}/load`}
              onClick={() => send({ op: "loadSample", trackIndex: i })}
            />
          </span>
        )}
        {/* INST source: the SAME ‹› slot steps the plugin's PRESETS instead of
            samples (v81) — one browse affordance, its meaning follows the source
            switch. Programs come from the live instance's JUCE program list;
            count ≤ 1 = the plugin doesn't expose one (steppers disabled, its
            own preset browser still works in the EDIT window). */}
        {!audio && t.instrumentOutEnabled && caps.pluginHosting && (
          <span className="trk-browse">
            <Toggle
              label="◀"
              title={
                (t.instrumentPresetCount ?? 0) > 1
                  ? "Previous preset"
                  : "This plugin exposes no preset list — use its own browser in the EDIT window"
              }
              focusId={`track/${i}/prstprev`}
              onClick={() => {
                if ((t.instrumentPresetCount ?? 0) > 1)
                  send({ op: "instrumentPresetStep", trackIndex: i, value: -1 });
              }}
            />
            <Toggle
              label="▶"
              title={
                (t.instrumentPresetCount ?? 0) > 1
                  ? "Next preset"
                  : "This plugin exposes no preset list — use its own browser in the EDIT window"
              }
              focusId={`track/${i}/prstnext`}
              onClick={() => {
                if ((t.instrumentPresetCount ?? 0) > 1)
                  send({ op: "instrumentPresetStep", trackIndex: i, value: 1 });
              }}
            />
            {t.instrumentPresetName != null && (
              <span
                className="trk-preset-name"
                title={`Preset ${(t.instrumentPresetIndex ?? 0) + 1}/${t.instrumentPresetCount ?? 0}`}
              >
                {t.instrumentPresetName}
              </span>
            )}
          </span>
        )}
        {muteSolo}
        <span className="trk-vsep" />
        {/* OWN/REG is a SAMPLE-lane concept — a note-only track always plays REG
            semantics in the grid (extensions = note length), so the toggle only
            renders while the sample source is active. */}
        {audio && (
        <Toggle
          label={t.playbackMode === "owner" ? "OWN" : "REG"}
          title="Playback mode (REG/OWN)"
          focusId={`track/${i}/mode`}
          onClick={() => {
            set("playbackMode", t.playbackMode === "owner" ? "regular" : "owner");
            send({ op: "cyclePlaybackMode", trackIndex: i });
          }}
        />
        )}
        {audio && (
          <Toggle
            label={trackSubModeLabel(t) || "—"}
            title="Sub-mode (OWN: —/CHOP/LOOP · REG: —/STR/LOOP)"
            focusId={`track/${i}/submode`}
            onClick={() => send({ op: "cycleSubMode", trackIndex: i })}
          />
        )}
        {audio && t.playbackMode !== "owner" && t.stretchToCell && (
          <Toggle
            label={stretchQualityLabel(t.stretchTimeOnly)}
            title="Stretch quality (T / T+P)"
            focusId={`track/${i}/stretchq`}
            onClick={() =>
              send({ op: "setStretchTimeOnly", trackIndex: i, value: t.stretchTimeOnly ? 0 : 1 })
            }
          />
        )}
        {/* Sample window rides the SAME row (TR-FT-7): S · waveform · E ·
            loop/chop/own-env boxes. The waveform is flex:1, so it eats every
            pixel left of it — one whole row saved. */}
        {audio && t.sampleKey && <TrimBar ctx={{ t, i, peaks, send, optimistic, mod }} />}
      </div>
      )}

      {/* R3 — DSP: paired box + geometric slider (DJ row 2).
          A note-emitting track lives here too: its ROOT and GATE are its pitch
          and its length. And on a track with NO audio path of its own, the
          volume/pan/tone dials keep their shape but speak MIDI — CC 7, 10, 74. */}
      {!perf && (hasAudioPath || notes) && (
        <div className="trk-ctrl-row">
          {hasAudioPath && (
          <Paired
            ctx={{ t, i, send, optimistic, mod }}
            slug="gain"
            modTarget="gain"
            scenePin={{ key: `track.${i}.trackGain` }}
            learn={learnable("gain")}
            label="GAIN"
            value={t.gain}
            display={formatGain(t.gain)}
            min={0}
            max={2}
            step={0.01}
            defaultValue={1}
            onChange={(v) => edit("gain", v, { op: "setGain", trackIndex: i, value: v })}
           
            menu={[clearCells("gain", "Clear per-cell gain")]}
          />
          )}
          {/* The pitch dial speaks the language of whatever the track drives.
              On a note-emitting track it becomes the ROOT NOTE — the note a cell
              with no pitch offset plays, which every cell then transposes. A
              track with BOTH a sample and a MIDI destination shows both: they are
              genuinely different things (one pitches audio, one names a note). */}
          {notes && (
            <>
              <BoxOnly
                ctx={{ t, i, send, optimistic, mod }}
                slug="root"
                label="ROOT"
                value={t.midiRootNote}
                display={noteName(t.midiRootNote)}
                min={0}
                max={127}
                step={1}
                onChange={(v) =>
                  edit("midiRootNote", v, { op: "setMidiRootNote", trackIndex: i, value: v })
                }
              />
              <BoxOnly
                ctx={{ t, i, send, optimistic, mod }}
                slug="gate"
                label="GATE"
                value={t.midiGatePercent}
                display={`${Math.round(t.midiGatePercent)}%`}
                min={1}
                max={100}
                step={1}
                onChange={(v) =>
                  edit("midiGatePercent", v, { op: "setMidiGate", trackIndex: i, value: v })
                }
              />
            </>
          )}
          {audio && (
          <Paired
            ctx={{ t, i, send, optimistic, mod }}
            slug="pitch"
            modTarget="pitch"
            scenePin={{ key: `track.${i}.globalPitchOffset` }}
            learn={learnable("pitch")}
            label="PITCH"
            value={t.globalPitchOffset}
            display={formatPitch(t.globalPitchOffset, t.globalFineTuneCents)}
            min={-96}
            max={96}
            step={1}
            bipolar
            defaultValue={0}
            onChange={(v, intent) =>
              edit("globalPitchOffset", v, { op: "setPitch", trackIndex: i, value: v }, intent)
            }
           
            menu={[
              clearCells("pitch", "Clear per-cell pitch"),
              { kind: "sep" },
              {
                kind: "item",
                label: "Melodic pitch mode",
                checked: t.melodicPitchMode,
                onSelect: () =>
                  send({
                    op: "setMelodicPitchMode",
                    trackIndex: i,
                    value: t.melodicPitchMode ? 0 : 1,
                  }),
              },
              { kind: "sep" },
              ...TUNINGS.map((tn) => ({
                kind: "item" as const,
                label: tn.label,
                checked: t.tuning === tn.value,
                onSelect: () => send({ op: "setTuning", trackIndex: i, value: tn.value }),
              })),
            ]}
          />
          )}
          <Paired
            ctx={{ t, i, send, optimistic, mod }}
            slug="tone"
            modTarget="filter"
            scenePin={{ key: `track.${i}.tone` }}
            learn={learnable("tone")}
            label={toneModeLabel(t.toneFilterMode)}
            value={toneValue}
            display={formatTone(t.tone, t.toneFilterMode)}
            min={toneIsFilter ? 0 : -100}
            max={100}
            step={1}
            bipolar={!toneIsFilter}
            defaultValue={0}
            onChange={(v, intent) =>
              edit("tone", v, { op: "setTone", trackIndex: i, value: v }, intent)
            }
           
            menu={[
              clearCells("tone", "Clear per-cell tone"),
              { kind: "sep" },
              ...FILTER_MODES.map((m) => ({
                kind: "item" as const,
                label: m.label,
                checked: t.toneFilterMode === m.value,
                // A MODE is not a quantity — there is no delta to preserve, so
                // the whole selection lands on the same mode (native :7216).
                onSelect: () =>
                  send({
                    op: "setToneFilterMode",
                    trackIndex: i,
                    mode: m.value,
                    selectionIntent: "set",
                  }),
              })),
              // Resonance applies to the dedicated filter modes only (native).
              ...(t.toneFilterMode !== "tone"
                ? [
                    { kind: "sep" as const },
                    ...Q_PRESETS.map((q) => ({
                      kind: "item" as const,
                      label: `Q ${q}`,
                      checked: Math.abs(t.toneQ - q) < 0.05,
                      onSelect: () =>
                        send({ op: "setToneQ", trackIndex: i, value: q, selectionIntent: "set" }),
                    })),
                    { kind: "sep" as const },
                    // Resonance drive — saturates the SVF's band-pass state so the peak
                    // self-limits and squishes instead of ringing linearly.
                    ...DRIVE_PRESETS.map((d) => ({
                      kind: "item" as const,
                      label: d === 0 ? "Drive off" : `Drive ${d}%`,
                      checked: Math.abs(t.filterDrive - d) < 0.5,
                      onSelect: () =>
                        send({
                          op: "setFilterDrive",
                          trackIndex: i,
                          value: d,
                          selectionIntent: "set",
                        }),
                    })),
                  ]
                : []),
            ]}
          />
          <Paired
            ctx={{ t, i, send, optimistic, mod }}
            slug="pan"
            modTarget="pan"
            scenePin={{ key: `track.${i}.pan` }}
            learn={learnable("pan")}
            label="PAN"
            value={t.pan}
            display={formatPan(t.pan)}
            min={-1}
            max={1}
            step={0.01}
            bipolar
            defaultValue={0}
            onChange={(v, intent) =>
              edit("pan", v, { op: "setPan", trackIndex: i, value: v }, intent)
            }

            menu={[clearCells("pan", "Clear per-cell pan")]}
          />
          <Paired
            ctx={{ t, i, send, optimistic, mod }}
            slug="volume"
            modTarget="volume"
            scenePin={{ key: `track.${i}.volume` }}
            learn={learnable("volume")}
            label="VOLUME"
            value={t.volume}
            display={formatVolume(t.volume)}
            min={0}
            max={2}
            step={0.01}
            defaultValue={1}
            sliderFraction={volumeToSliderFraction}
            fractionToValue={sliderFractionToVolume}
            onChange={(v, intent) =>
              edit("volume", v, { op: "setVolume", trackIndex: i, value: v }, intent)
            }
           
            menu={[clearCells("volume", "Clear per-cell volume")]}
          />
          {/* Voice architecture (choke group · mono/poly · stereo mode) is a
              patch decision, not a performance move — compose only. It also
              belongs to the SAMPLE voice: a hosted instrument owns its own
              polyphony, and a bare MIDI track has no voices to choke. */}
          {!dj && audio && (
            <>
              <span className="trk-vsep" />
              <BoxOnly
                ctx={{ t, i, send, optimistic, mod }}
                slug="choke"
            scenePin={{ key: `track.${i}.chokeGroup` }}
                label="CHOKE"
                value={t.chokeGroup}
                display={formatChoke(t.chokeGroup)}
                min={0}
                max={8}
                step={1}
                onChange={(v) =>
                  edit("chokeGroup", Math.round(v), {
                    op: "setChokeGroup",
                    trackIndex: i,
                    value: Math.round(v),
                  })
                }
              />
              <Toggle
                label={voiceLabel(t.voiceMode)}
                title="Voice mode (mono/poly)"
                focusId={`track/${i}/voice`}
                onClick={() => {
                  const next = t.voiceMode === "poly" ? "mono" : "poly";
                  set("voiceMode", next);
                  send({ op: "setVoiceMode", trackIndex: i, mode: next });
                }}
              />
              <Toggle
                label={stereoLabel(t.stereoMode)}
                title="Stereo mode"
                focusId={`track/${i}/stereo`}
                onClick={() => {
                  const next = (t.stereoMode + 1) % 4;
                  set("stereoMode", next);
                  // Cycling from THIS track's mode lands the whole selection on
                  // the mode it just reached (native :7330 fans the same way).
                  send({ op: "setStereoMode", trackIndex: i, value: next, selectionIntent: "set" });
                }}
              />
              {/* Hard output routing — click cycles off → Out 1 → Out 2; right-click
                  picks directly. When engaged the track mono-sums straight onto a
                  physical output and pan is ignored (native `outputAssign`). Lives
                  next to Stereo mode because it OVERRIDES it. Also reachable from the
                  pan box's right-click menu — this is the visible, one-click home.
                  P8-9: gated on device selection — the browser's render is main-L/R
                  only, so an assignment can neither be made nor honored there. */}
              {caps.audioDeviceSelection ? (
                <Toggle
                  label={outputAssignLabel(t.outputAssign)}
                  on={t.outputAssign !== 0}
                  title="Direct output routing (ignores pan) — click to cycle, right-click to pick"
                  focusId={`track/${i}/outputAssign`}
                  onClick={() => {
                    const next = (t.outputAssign + 1) % 3;
                    set("outputAssign", next);
                    send({ op: "setOutputAssign", trackIndex: i, value: next });
                  }}
                  menu={OUTPUT_ASSIGNS.map((o) => ({
                    kind: "item" as const,
                    label: o.label,
                    checked: t.outputAssign === o.value,
                    onSelect: () => {
                      set("outputAssign", o.value);
                      send({ op: "setOutputAssign", trackIndex: i, value: o.value });
                    },
                  }))}
                />
              ) : (
                t.outputAssign !== 0 && (
                  <DesktopBadge
                    label={outputAssignLabel(t.outputAssign)}
                    why="This track is routed to a hard output on the desktop. This host renders main L/R only — the routing is preserved in the file, inactive here."
                  />
                )
              )}
            </>
          )}
          {/* SIG-3 — the OUTPUT meter: a horizontal bar (DragBox width, the app's
              meter language) at the end of the DSP row (the channel's post-fader
              output), painting the track's true per-channel peak at the END of
              its chain (post tone filter, track clipper, volume/pan, mute). A
              fixed green→amber→red gradient the fill reveals from the left: a
              short green bar while nominal, pushing into the red right end when
              the track runs HOT (near/over 0 dBFS). It keeps reading while a
              plugin rings past transport stop (the "which track is still
              sounding?" answer) and goes dark the instant the track is muted.
              GridPanel's LED loop writes the cap WIDTH from the HotFrame — no
              React re-render. Only where the track actually makes audio. */}
          {hasAudioPath && (
            <span
              className="trk-led"
              aria-hidden
              title="Output level — real post-chain peak (tick = recent peak · right edge latches on clip)"
              ref={(el) => registerLed?.(i, el)}
            >
              <span className="trk-led-bar">
                <span className="trk-led-cap" />
                <span className="trk-led-hold" />
              </span>
              <span className="trk-led-clip" />
            </span>
          )}
        </div>
      )}

      {/* R3b — mapped modifier slots (only what the user routed) */}
      {!perf && t.modSlots.length > 0 && (
        <div className="trk-ctrl-row trk-wrap">
          {t.modSlots.map((s) => (
            <ModSlot
              key={`${s.channelIndex}/${s.target}`}
              ctx={{ t, i, peaks, send, optimistic, mod }}
              slot={s}
            />
          ))}
        </div>
      )}

      {/* R4 — sends. An INSTRUMENT track has real audio (the plugin's output runs
          the same DSP chain a sample does), so it sends like any other track. A
          bare MIDI-out track has no audio to send.
          P8-9: gone entirely on a host with no return-FX section (caps.returnFx —
          the browser) — a send whose return plays hardcoded defaults is not a
          control, and the world zeroes the levels to match. */}
      {!perf && caps.returnFx && hasAudioPath && (
        <div className="trk-ctrl-row">
          {([1, 2, 3, 4] as const).map((n) => {
            const field = `send${n}Level` as keyof GridTrackState;
            const value = t[field] as number;
            return (
              <Paired
                key={n}
                ctx={{ t, i, send, optimistic, mod }}
                slug={`send${n}`}
                label={`S${n}`}
                identity={semanticColor("send", n - 1)}
                value={value}
                display={formatSend(value)}
                min={0}
                max={1}
                step={0.02}
                defaultValue={0}
                onChange={(v, intent) =>
                  edit(field, v, { op: "setSend", trackIndex: i, index: n, value: v }, intent)
                }
                learn={learnable(`send${n}`)}
              />
            );
          })}
        </div>
      )}

    </div>
  );
}
