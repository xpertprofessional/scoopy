import { useEffect, useRef } from "react";
import { inkAlpha, onTokensApplied } from "../design/tokens.ts";
import {
  envelopeTotalMs,
  lfoValueAt,
  sampleShape,
  unipolarToBipolar,
  type ShapeChannel,
} from "./modShape.ts";

/**
 * ModCanvas — the modulator's shape, drawn STATIC, with a playhead riding it.
 *
 * This replaces the old scrolling-history monitors, which were unreadable by construction: a 6 Hz
 * LFO sampled at 30 Hz is aliased mush. Here the shape holds still — because it is the thing you
 * are EDITING — and a dot rides it at the engine's live phase.
 *
 * ── MOD-9b: THE RULE IS THAT NOTHING CAN COLLAPSE ───────────────────────────────────────────────
 *
 * The first cut of this canvas had two ways to destroy a shape and no way back, and the user hit
 * both:
 *
 *   1. Dragging the BACKGROUND set `depth`. An invisible gesture with a destructive result — drag
 *      down, depth hits 0, the curve goes flat. Worse, at depth 0 the peak and phase handles both
 *      collapse onto the centre line, and a click near the centre was read as a *phase* drag, so
 *      the obvious recovery gesture didn't restore it. Now the background does NOTHING. Depth has
 *      a slider; it should never have been a hidden gesture.
 *
 *   2. SYMMETRY had no guard rails. A square at symmetry 0.99 is a flat line whose peak handle sits
 *      at x=0, half off-canvas and effectively ungrabbable. Now symmetry is clamped to
 *      [SYMMETRY_MIN, SYMMETRY_MAX] so the shape stays a shape and the handle stays reachable — and
 *      on sine/saw, where the engine *ignores* symmetry entirely, the handle is HIDDEN rather than
 *      offered as a control that does nothing.
 *
 * Everything else follows from that rule: handles never leave the canvas, never stack
 * indistinguishably, and double-clicking any handle resets it to its default.
 */

/** Live engine read-back, supplied by the parent (HotFrame). Kept out of React state — it's hot. */
export interface ModLive {
  /** Current channel output, −1…1 (already depth-scaled by the engine). */
  value: number;
  /** Progress through the shape, 0…1. −1 = nothing to ride (follower, or an idle envelope). */
  phase: number;
}

export interface ModCanvasProps {
  channel: ShapeChannel;
  /** The channel's identity colour (ModChannelPalette — M1 blue / M2 green / M3 orange / M4 violet). */
  color: string;
  /** Polled each rAF. A function, not a prop value, so live data never re-renders React. */
  getLive: () => ModLive;
  /** MOD-12: the mod's PERIOD in grid steps (the "Length" = this many cells). The canvas draws
      exactly this many step-cells with the pattern grid's field. 0 = draw no grid. */
  stepsPerCycle?: number;
  /** Beat grouping for the cell field — the grid's persisted `grid.groupSize` (bands + bar rule).
      Default 4 (the app default) when the setting hasn't been read. */
  groupSize?: number;
  /** MOD-12: when >0 and the channel is an LFO, draw the whole pattern loop as a STEP GRID that wraps
      to a new row every `wrapSteps` steps (like the pattern grid), the waveform drawn across the
      cells. 0 / omitted = the single-row form (strip thumbnails, envelope, follower). */
  wrapSteps?: number;
  height?: number;
  /** Read-only (the strip's thumbnails): draw the shape, but no handles and no gestures. */
  readOnly?: boolean;

  // --- LFO (its SHAPE lives on the macro sliders; only phase is spatial) -----------------------
  onPhaseOffset?: (v: number) => void;
  // --- breakpoint shapes (the Envelope type AND the custom LFO waveform) -----------------------
  onNodeMove?: (index: number, timeMs: number, value: number) => void;
  onNodeAdd?: (afterIndex: number, timeMs: number, value: number) => void;
  onNodeDelete?: (index: number) => void;
  onCurveBend?: (index: number, curve: number) => void;
}

/**
 * The mod canvas's alphas. CHROME scales with the look's ink level (inkAlpha);
 * SIGNAL does not — dimming the beat grid to suit a light ground must never dim
 * the shape you are editing or the live phase dot tracking the engine.
 */
const MOD = {
  depthFill: 0.12, // signal — fill to the zero line, reads as "amount"
  phaseLine: 0.35, // signal — the live playhead through the shape
} as const;

/**
 * The beat-cell field, drawn to grid parity (GridPanel `FIELD`): the SAME alpha ratios so the
 * LFO's cells read as one surface with the pattern grid — group shading (--text whisper),
 * hairline cell boundaries, and the stronger bar rule every 4 groups. Chrome, so all three
 * scale together with the look's ink level (inkAlpha).
 */
const CELL = {
  groupShade: 0.03, // alternating groupSize bands (pattern-grid parity)
  gridline: 0.35, // cell-boundary hairlines
  barRule: 0.6, // the stronger bar rule (musical anchor)
} as const;

/**
 * Below this drawn cell width (px) a per-step grid becomes an unreadable wall, so the cell overlay
 * thins to group- then bar-boundaries. This is the LCM / long-cycle answer: the SHAPE and PLAYHEAD
 * never thin (they always span the full width, so positions stay exact) — only the overlay does.
 */
const MIN_CELL_PX = 6;

const HANDLE = 7; // hit radius, px
const PAD = 6; // vertical breathing room so peaks aren't clipped by the frame

type Drag =
  | { kind: "phase"; startPhase: number; startX: number }
  | { kind: "node"; index: number }
  | { kind: "curve"; index: number; startCurve: number; startY: number };

/**
 * Geometry, in ONE place. Paint and hit-testing MUST agree — if they drift, handles stop landing
 * where they look, which is the classic canvas-editor bug and exactly the kind of thing that made
 * the old canvas feel broken.
 */
function geom(ch: ShapeChannel, w: number, h: number) {
  // A custom LFO carries its own polarity (its shape's `bipolar` flag); analytic waves are always
  // bipolar; an envelope is bipolar only if flagged; a follower is always unipolar.
  const bipolar = ch.type === "lfo" ? true : ch.type === "envelope" && ch.bipolar;
  const axisLo = bipolar ? -1 : 0;
  const yFor = (v: number) => h - PAD - ((v - axisLo) / (1 - axisLo)) * (h - 2 * PAD);
  const vFor = (py: number) => axisLo + ((h - PAD - py) / (h - 2 * PAD)) * (1 - axisLo);
  return { bipolar, axisLo, yFor, vFor, w, h };
}

/**
 * Does this channel's shape consist of draggable breakpoints?
 *
 * ONLY the envelope, now. The LFO's shape comes from four macro sliders (MOD-10), so there is
 * nothing on its canvas to grab and therefore nothing to break — which is the cleanest possible
 * answer to "the handles collapse the shape". The one exception is PHASE, which is genuinely
 * spatial: dragging the curve sideways is the clearest way to express it.
 */
const hasNodes = (ch: ShapeChannel) => ch.type === "envelope";

export function ModCanvas(props: ModCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The props the rAF loop reads. A ref, not a closure capture: the loop outlives any one render.
  const p = useRef(props);
  p.current = props;
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Follower history ring — the one channel type that legitimately scrolls (~4 s at 30 Hz).
    const history = new Float64Array(120);
    let head = 0;
    let raf = 0;

    // Token colours are CACHED, not re-read per frame: getComputedStyle forces a style recalc, and
    // this loop runs at 60 Hz across five canvases.
    let pal = readPalette();
    const offTokens = onTokensApplied(() => {
      pal = readPalette();
    });

    const paint = () => {
      const {
        channel: ch,
        color,
        getLive,
        stepsPerCycle = 0,
        groupSize = 4,
        wrapSteps = 0,
        readOnly,
      } = p.current;
      const live = getLive();

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const g = geom(ch, w, h);
      const zeroY = g.yFor(0);

      ctx.fillStyle = pal.bgRaised;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = pal.line;
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      // MOD-12: the WRAPPING STEP GRID. The mod's own PERIOD (the "Length" = `stepsPerCycle` cells) is
      // laid out as a step grid — `wrapSteps` (16) steps per row, wrapping down — exactly like the
      // pattern grid, one value per cell. So "Length = N steps" reads directly: N cells, wrapping.
      if (wrapSteps > 0 && ch.type === "lfo") {
        const loop = Math.max(1, Math.round(stepsPerCycle || 1)); // the mod's period, in cells
        const perRow = wrapSteps;
        const nRows = Math.max(1, Math.ceil(loop / perRow));
        const cellW = w / perRow; // one step's width (constant across rows)
        const rowH = h / nRows;
        const bar = Math.max(1, groupSize * 4);
        const pad = Math.min(3, rowH * 0.12);

        for (let r = 0; r < nRows; r++) {
          const y0 = r * rowH;
          const midY = y0 + rowH / 2;
          const ampY = rowH / 2 - pad; // ±1 → ±ampY within the row band
          const startStep = r * perRow;
          const rowSteps = Math.min(perRow, loop - startStep);
          const rowW = rowSteps * cellW;

          // Group shading — alternating groupSize bands, continuous across rows (the band parity keys
          // off the ABSOLUTE step so the shading lines up bar-to-bar down the grid).
          ctx.fillStyle = pal.text;
          ctx.globalAlpha = inkAlpha(CELL.groupShade);
          for (let s = 0; s < rowSteps; s += groupSize) {
            if (Math.floor((startStep + s) / groupSize) % 2 === 1) {
              ctx.fillRect(s * cellW, y0 + 1, Math.min(groupSize * cellW, rowW - s * cellW), rowH - 2);
            }
          }
          ctx.globalAlpha = 1;

          // Row zero line.
          ctx.strokeStyle = pal.line;
          ctx.globalAlpha = inkAlpha(CELL.gridline);
          ctx.beginPath();
          ctx.moveTo(0, Math.round(midY) + 0.5);
          ctx.lineTo(rowW, Math.round(midY) + 0.5);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // Step / bar gridlines (device px for crispness).
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          const yT = Math.round((y0 + 1) * dpr);
          const yB = Math.round((y0 + rowH - 1) * dpr);
          ctx.fillStyle = pal.line;
          for (let s = 1; s < rowSteps; s++) {
            const isBar = (startStep + s) % bar === 0;
            ctx.globalAlpha = inkAlpha(isBar ? CELL.barRule : CELL.gridline);
            const bx = Math.round(s * cellW * dpr);
            ctx.fillRect(bx, yT, isBar ? Math.max(1, Math.round(dpr)) : 1, yB - yT);
          }
          ctx.restore();
          ctx.globalAlpha = 1;

          // Row separator.
          if (r > 0) {
            ctx.strokeStyle = pal.line;
            ctx.globalAlpha = inkAlpha(CELL.barRule);
            ctx.beginPath();
            ctx.moveTo(0, Math.round(y0) + 0.5);
            ctx.lineTo(w, Math.round(y0) + 0.5);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // The waveform across this row's steps.
          const nPts = Math.max(2, Math.ceil(rowW));
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let i = 0; i < nPts; i++) {
            const frac = i / (nPts - 1);
            const x = frac * rowW;
            const val = lfoValueAt(ch, startStep + frac * rowSteps);
            const y = midY - val * ampY;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        // Playhead — the dot rides the row it is currently in.
        if (live.phase >= 0) {
          const lp = live.phase * loop; // steps into the loop
          const r = Math.min(nRows - 1, Math.floor(lp / perRow));
          const midY = r * rowH + rowH / 2;
          const ampY = rowH / 2 - pad;
          const x = (lp - r * perRow) * cellW;
          const y = midY - lfoValueAt(ch, lp) * ampY;
          ctx.strokeStyle = pal.signal;
          ctx.globalAlpha = MOD.phaseLine;
          ctx.beginPath();
          ctx.moveTo(x, r * rowH + 1);
          ctx.lineTo(x, r * rowH + rowH - 1);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = pal.signal;
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        raf = requestAnimationFrame(paint);
        return;
      }

      // MOD-12 single-row grid (strip thumbnails): the drawn width spans the mod's PERIOD (its
      // `stepsPerCycle` cells), drawn with the pattern grid's step-cell field — group shading, step
      // hairlines, bar rule — thinned when a per-step grid would be an unreadable wall.
      if (stepsPerCycle > 0 && ch.type === "lfo") {
        const loopSteps = Math.max(1, Math.round(stepsPerCycle)); // the mod's period, in cells
        const cellW = w / loopSteps; // one grid STEP's width
        const nCells = loopSteps;
        const bar = groupSize * 4;
        const raw = Math.max(1, Math.ceil(MIN_CELL_PX / cellW));
        const stride = raw <= 1 ? 1 : raw <= groupSize ? groupSize : Math.ceil(raw / bar) * bar;
        const band = stride === 1 ? groupSize : stride;

        ctx.fillStyle = pal.text;
        ctx.globalAlpha = inkAlpha(CELL.groupShade);
        for (let s = 0; s < nCells; s += band) {
          if (Math.floor(s / band) % 2 === 1) {
            const x = s * cellW;
            ctx.fillRect(x, 1, Math.min(band * cellW, w - 1 - x), h - 2);
          }
        }
        ctx.globalAlpha = 1;

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const yTop = Math.round(1 * dpr);
        const yBot = Math.round((h - 1) * dpr);
        ctx.fillStyle = pal.line;
        for (let s = stride; s < loopSteps - 1e-6; s += stride) {
          const isBar = s % bar === 0;
          ctx.globalAlpha = inkAlpha(isBar ? CELL.barRule : CELL.gridline);
          const bx = Math.round(s * cellW * dpr);
          ctx.fillRect(bx, yTop, isBar ? Math.max(1, Math.round(dpr)) : 1, yBot - yTop);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      ctx.strokeStyle = pal.line;
      ctx.beginPath();
      ctx.moveTo(0, zeroY);
      ctx.lineTo(w, zeroY);
      ctx.stroke();

      if (ch.type === "envFollower") {
        // No static shape. Scroll the history — and unlike the old monitor, draw the WHOLE range
        // (it clamped Math.max(v, 0) and flattened every negative excursion against the floor).
        history[head] = live.value;
        head = (head + 1) % history.length;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < history.length; i++) {
          const v = history[(head + i) % history.length] ?? 0;
          const x = (i / (history.length - 1)) * w;
          const y = g.yFor(v);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        drawLiveTick(ctx, pal, g.yFor(live.value));
        raf = requestAnimationFrame(paint);
        return;
      }

      // ---- The shape ------------------------------------------------------------------------
      const pts = sampleShape(ch, Math.max(64, Math.floor(w)));
      if (pts) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const x = (i / (pts.length - 1)) * w;
          const y = g.yFor(pts[i]!);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Faint fill to the zero line — reads as "amount", and makes depth 0 unmistakable.
        ctx.globalAlpha = MOD.depthFill;
        ctx.fillStyle = color;
        ctx.lineTo(w, zeroY);
        ctx.lineTo(0, zeroY);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // ---- Handles ---------------------------------------------------------------------------
      if (!readOnly) {
        if (hasNodes(ch)) {
          for (const m of segmentMidpoints(ch, g)) drawHandle(ctx, pal, m.x, m.y, pal.line, "diamond");
          for (const n of nodePositions(ch, g)) {
            drawHandle(ctx, pal, n.x, n.y, n.isSustain && ch.type === "envelope" ? pal.warn : color, "circle");
          }
        } else if (ch.type === "lfo") {
          const ph = phaseHandle(ch, g);
          drawHandle(ctx, pal, ph.x, ph.y, color, "square");
        }
      }

      // ---- The playhead: a dot riding the curve ------------------------------------------------
      if (live.phase >= 0 && pts) {
        const x = live.phase * w;
        const idx = Math.min(pts.length - 1, Math.round(live.phase * (pts.length - 1)));
        const y = g.yFor(pts[idx] ?? 0);
        ctx.strokeStyle = pal.signal;
        ctx.globalAlpha = MOD.phaseLine;
        ctx.beginPath();
        ctx.moveTo(x, 1);
        ctx.lineTo(x, h - 1);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.signal;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      drawLiveTick(ctx, pal, g.yFor(live.value));

      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(raf);
      offTokens();
    };
  }, []);

  // ---- Gestures ----------------------------------------------------------------------------

  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const ch = props.channel;
    return {
      x: e.clientX - r.left,
      y: e.clientY - r.top,
      g: geom(ch, r.width, r.height),
      ch,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (props.readOnly) return;
    const { x, y, g, ch } = at(e);

    if (hasNodes(ch)) {
      // Nodes win over midpoints where they overlap — matching the paint order.
      const node = hitNode(ch, x, y, g);
      if (node >= 0) {
        drag.current = { kind: "node", index: node };
      } else {
        const mid = hitMidpoint(ch, x, y, g);
        if (mid >= 0) {
          drag.current = {
            kind: "curve",
            index: mid,
            startCurve: ch.envelopeNodes[mid]?.curve ?? 1,
            startY: y,
          };
        }
      }
    } else if (ch.type === "lfo" && near(phaseHandle(ch, g), x, y)) {
      drag.current = { kind: "phase", startPhase: ch.phaseOffset, startX: x };
    }
    // Anything else: NOTHING. The background is not a control (MOD-9b — see the header).
    if (drag.current) e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    const { x, y, g, ch } = at(e);

    switch (d.kind) {
      case "phase": {
        let v = (d.startPhase + (x - d.startX) / g.w) % 1;
        if (v < 0) v += 1;
        props.onPhaseOffset?.(v);
        break;
      }
      case "node": {
        const total = envelopeTotalMs(ch.envelopeNodes) || 1;
        // Node 0 anchors the start of the timeline and has no incoming segment — its time is
        // always 0. Everything else takes its time from the cursor, floored at 0.
        const timeMs = d.index === 0 ? 0 : Math.max(0, (x / g.w) * total);
        // vFor is in DRAWN space (already depth-scaled and bipolar-mapped); invert both to get
        // back to the stored 0…1 the model holds.
        const drawn = clamp(g.vFor(y), g.axisLo, 1);
        const undepth = clamp(drawn / (ch.depth || 1), g.axisLo, 1);
        const stored = g.bipolar ? clamp((undepth + 1) / 2, 0, 1) : clamp(undepth, 0, 1);
        props.onNodeMove?.(d.index, timeMs, stored);
        break;
      }
      case "curve":
        // Up = ease-in, down = ease-out. Clamped well inside the engine's own 0.01…∞.
        props.onCurveBend?.(d.index, clamp(d.startCurve * Math.pow(2, (d.startY - y) / 60), 0.15, 6));
        break;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  /** Double-click: on a handle → RESET it. On empty space of a node shape → add a node. */
  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (props.readOnly) return;
    const { x, y, g, ch } = at(e);

    if (hasNodes(ch)) {
      const node = hitNode(ch, x, y, g);
      if (node >= 0) return; // a node's own reset is "delete", which is right-click — don't surprise
      const mid = hitMidpoint(ch, x, y, g);
      if (mid >= 0) {
        props.onCurveBend?.(mid, 1); // straighten this segment
        return;
      }
      if (!props.onNodeAdd) return;
      const total = envelopeTotalMs(ch.envelopeNodes) || 1;
      const timeMs = (x / g.w) * total;
      const drawn = clamp(g.vFor(y), g.axisLo, 1);
      const undepth = clamp(drawn / (ch.depth || 1), g.axisLo, 1);
      const stored = g.bipolar ? clamp((undepth + 1) / 2, 0, 1) : clamp(undepth, 0, 1);

      // Insert after the last node whose cumulative time is left of the click.
      let cum = 0;
      let after = 0;
      for (let i = 1; i < ch.envelopeNodes.length; i++) {
        cum += Math.max(0, ch.envelopeNodes[i]!.timeMs);
        if (cum <= timeMs) after = i;
      }
      props.onNodeAdd(after, timeMs, stored);
      return;
    }

    if (ch.type === "lfo" && near(phaseHandle(ch, g), x, y)) props.onPhaseOffset?.(0);
  };

  /** Right-click a node to delete it — paired with double-click to add. */
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (props.readOnly || !props.onNodeDelete) return;
    const { x, y, g, ch } = at(e);
    if (!hasNodes(ch)) return;
    const i = hitNode(ch, x, y, g);
    if (i < 0) return; // not on a node — let any surrounding menu handle it
    e.preventDefault();
    // Node 0 anchors the shape's start, and (for an envelope) the sustain node anchors the gate:
    // removing either changes what the shape MEANS, not just how it looks. And below 2 nodes there
    // is no shape at all — the exact degenerate state MOD-9b exists to prevent.
    if (i === 0 || ch.envelopeNodes.length <= 2) return;
    if (ch.type === "envelope" && i === ch.sustainNodeIndex) return;
    props.onNodeDelete(i);
  };

  return (
    <canvas
      ref={canvasRef}
      className="mod-canvas"
      style={{
        width: "100%",
        height: props.height ?? 96,
        touchAction: "none",
        cursor: props.readOnly ? "pointer" : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    />
  );
}

// ---- helpers ---------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type Geom = ReturnType<typeof geom>;
type Pt = { x: number; y: number };

const near = (pt: Pt, x: number, y: number) => Math.hypot(x - pt.x, y - pt.y) <= HANDLE;

interface Palette {
  bg: string;
  bgRaised: string;
  line: string;
  text: string;
  signal: string;
  warn: string;
}

/** Resolve the token colours once. Refreshed via `onTokensApplied`, never per frame. */
function readPalette(): Palette {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    bg: v("--bg"),
    bgRaised: v("--bg-raised"),
    line: v("--line"),
    text: v("--text"),
    signal: v("--signal"),
    warn: v("--warn"),
  };
}

/** The phase handle rides the zero line at the cycle's start. */
function phaseHandle(ch: ShapeChannel, g: Geom): Pt {
  const p = ((ch.phaseOffset % 1) + 1) % 1;
  return { x: p * g.w, y: g.yFor(0) };
}

/**
 * Node handle positions. ONE source of truth for drawing AND hit-testing — if these drift apart,
 * handles stop landing where they look.
 */
function nodePositions(ch: ShapeChannel, g: Geom) {
  const total = envelopeTotalMs(ch.envelopeNodes);
  if (total <= 0) return [];
  const out: { i: number; x: number; y: number; isSustain: boolean }[] = [];
  let t = 0;
  for (let i = 0; i < ch.envelopeNodes.length; i++) {
    const n = ch.envelopeNodes[i]!;
    t += i === 0 ? 0 : Math.max(0, n.timeMs);
    const drawn = (g.bipolar ? unipolarToBipolar(n.value) : n.value) * ch.depth;
    out.push({ i, x: (t / total) * g.w, y: g.yFor(drawn), isSustain: i === ch.sustainNodeIndex });
  }
  return out;
}

/**
 * Midpoint of each segment — drag it vertically to bend that segment via its node's `curve`
 * exponent. The engine has honoured `curve` since the modulation overhaul but nothing could ever
 * SET it: the native editor only moves nodes. This handle is what finally exposes it.
 *
 * Zero-length segments (the instantaneous jumps of a STEPPED random shape) get no handle — there
 * is nothing to bend, and a handle stacked on its node would just steal that node's clicks.
 */
function segmentMidpoints(ch: ShapeChannel, g: Geom) {
  const nodes = nodePositions(ch, g);
  const out: { i: number; x: number; y: number }[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    if (b.x - a.x < HANDLE * 3) continue;
    out.push({ i, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  return out;
}

function hitNode(ch: ShapeChannel, x: number, y: number, g: Geom): number {
  // Nearest wins, not first: a stepped shape stacks two nodes at the same x (different y), and
  // "first within radius" would make the lower one unreachable.
  let best = -1;
  let bestD = HANDLE;
  for (const n of nodePositions(ch, g)) {
    const d = Math.hypot(x - n.x, y - n.y);
    if (d <= bestD) {
      bestD = d;
      best = n.i;
    }
  }
  return best;
}

function hitMidpoint(ch: ShapeChannel, x: number, y: number, g: Geom): number {
  for (const m of segmentMidpoints(ch, g)) {
    if (near(m, x, y)) return m.i;
  }
  return -1;
}

function drawHandle(
  ctx: CanvasRenderingContext2D,
  pal: Palette,
  x: number,
  y: number,
  color: string,
  shape: "square" | "circle" | "diamond",
) {
  ctx.fillStyle = pal.bg;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, 4, 0, Math.PI * 2);
  } else if (shape === "diamond") {
    ctx.moveTo(x, y - 3.5);
    ctx.lineTo(x + 3.5, y);
    ctx.lineTo(x, y + 3.5);
    ctx.lineTo(x - 3.5, y);
    ctx.closePath();
  } else {
    ctx.rect(x - 3.5, y - 3.5, 7, 7);
  }
  ctx.fill();
  ctx.stroke();
}

/** The current output, as a tick on the left edge — readable even when the playhead is off-shape. */
function drawLiveTick(ctx: CanvasRenderingContext2D, pal: Palette, y: number) {
  ctx.fillStyle = pal.signal;
  ctx.fillRect(0, y - 1, 4, 2);
}
