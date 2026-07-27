import type { GridTrackState } from "../../protocol/schema.ts";

/**
 * Waveform segment mapping (P5-02c) — pure-TS port of the essential
 * WaveformOverlay.performWaveformCalculation math (ContentView :8568–9010),
 * which itself mirrors what NativeAudioEngineCore plays:
 * - trim window + per-step start/end offsets, chopper slices
 * - per-step pitch/varispeed audio consumption (each step's pitch affects
 *   consumption only from that step forward)
 * - stretch-to-cell (window spans the cell), loop wrap (window repeats)
 * - wrap continuation (step-0 cell resumes where the source cell left off)
 * - lead-in silence: negative start + pre-silence + rhythmic offset + swing
 *
 * Deliberately not mirrored yet (documented): glide ramps between cells,
 * owner-mode gate/attack envelope shaping, clipper-curve shading.
 */

export interface WaveSegment {
  /** Audio window inside the sample, absolute ms (pre-reverse). */
  audioStartMs: number;
  audioEndMs: number;
  /** Visual span inside the cell, 0..1 of the cell width. */
  visualStartFrac: number;
  visualEndFrac: number;
  /** Played step (per-step amplitude lookup). */
  stepIndex: number;
}

export interface CellWaveform {
  segments: WaveSegment[];
  /** Lead-in silence as a fraction of the cell width. */
  silenceFrac: number;
  /** Whole-cell reverse (track-level OR the owner step's flag). */
  reversed: boolean;
  /** Audio window bounds — reverse mirrors segments inside these. */
  windowStartMs: number;
  windowEndMs: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Grid step duration before per-track speed (native currentStepDuration). */
export function gridStepMs(bpm: number): number {
  const safe = !Number.isFinite(bpm) || bpm <= 0 ? 120 : clamp(bpm, 20, 300);
  return 60000 / (safe * 4);
}

/**
 * Lead-in decomposition for the pre-silence onset drag (P5-PCE §2.4).
 * `cellDurationMs` = the cell's full rendered time; `floorMs` = the
 * non-editable lead-in (negative-start + rhythmic + swing) the onset handle
 * cannot drag below; `preSilenceAbsMs` = the current editable component.
 * A pure subset of computeCellSegments' lead-in math (non-wrap owner cells).
 */
export function cellLeadIn(
  t: GridTrackState,
  bpm: number,
  owner: number,
  span: number,
): { cellDurationMs: number; floorMs: number; preSilenceAbsMs: number } {
  const speed =
    !Number.isFinite(t.speedMultiplier) || t.speedMultiplier <= 0
      ? 1
      : clamp(t.speedMultiplier, 0.001, 10);
  const gridMs = gridStepMs(bpm);
  const stepMs = gridMs / speed;
  const cellDurationMs = span * stepMs;
  const win = cellWindow(t, owner);
  const negativeStartMs = win.startMs < 0 ? -win.startMs : 0;
  const rhythmicMs = stepMs * (t.rhythmicOffsetRatios[owner] ?? 0);
  const swingMs = t.swing > 0 && owner % 2 === 1 ? t.swing * 0.5 * gridMs : 0;
  const preSilenceAbsMs = Math.max(0, t.preSilenceMs + (t.preSilenceMsOffsets[owner] ?? 0));
  return { cellDurationMs, floorMs: negativeStartMs + rhythmicMs + swingMs, preSilenceAbsMs };
}

/** Per-step playback rate (native :8780–8797). */
export function stepRate(t: GridTrackState, step: number): number {
  const pitchIndex = t.playbackMode === "owner" ? ownerIndexFor(t, step) : step;
  const pitchOffset = t.pitchOffsets[pitchIndex] ?? 0;
  let semitone = t.melodicPitchMode ? 0 : (t.globalPitchOffset + pitchOffset) / 2;
  if ((t.pitchSyncMode || t.timeStretchMode) && t.speedMultiplier !== 1) {
    semitone += Math.log2(t.speedMultiplier) * 12;
  }
  semitone = Number.isFinite(semitone) ? clamp(semitone, -96, 96) : 0;
  const rate = Math.pow(2, semitone / 12);
  return Number.isFinite(rate) ? clamp(rate, 0.0001, 100) : 1;
}

function ownerIndexFor(t: GridTrackState, step: number): number {
  // Owner mode reads the owner's pitch for the whole extended cell; the
  // caller passes the owner already, so this is the identity in practice.
  return step;
}

/** Trim/chop audio window for a cell anchored at `attrIndex` (native :8820–8850). */
function cellWindow(t: GridTrackState, attrIndex: number): { startMs: number; endMs: number } {
  const duration = t.sampleDurationMs;
  const cellChop = t.cellChopIndices[attrIndex] ?? -1;
  const resolvedChop = t.defaultChopIndex >= 0 ? (cellChop >= 0 ? cellChop : t.defaultChopIndex) : -1;
  if (resolvedChop >= 0 && resolvedChop < t.chopPointsMs.length) {
    const startMs = t.chopPointsMs[resolvedChop]!;
    const endMs =
      resolvedChop + 1 < t.chopPointsMs.length
        ? t.chopPointsMs[resolvedChop + 1]!
        : duration > 0
          ? duration
          : t.sampleEndMs;
    return { startMs, endMs };
  }
  const startMs = t.sampleStartMs + (t.sampleStartMsOffsets[attrIndex] ?? 0);
  const rawEnd = t.sampleEndMs > 0 ? t.sampleEndMs : duration;
  const endMs = rawEnd + (t.sampleEndMsOffsets[attrIndex] ?? 0);
  return { startMs, endMs };
}

/** Audio consumed by the wrap-source cell up to the pattern end (native :8760–8807). */
function wrapConsumedMs(t: GridTrackState, wrapSource: number, stepMs: number): number {
  const win = cellWindow(t, wrapSource);
  const windowDur = (win.endMs > 0 ? win.endMs : t.sampleDurationMs) - Math.max(0, win.startMs);
  let consumed = 0;
  for (let s = wrapSource; s < t.stepCount; s++) {
    consumed += stepMs * stepRate(t, t.playbackMode === "owner" ? wrapSource : s);
    if (consumed >= windowDur) break;
  }
  return Math.max(0, win.startMs) + Math.min(windowDur, consumed);
}

export function computeCellSegments(
  t: GridTrackState,
  bpm: number,
  owner: number,
  span: number,
  isWrap: boolean,
): CellWaveform | null {
  if (!t.sampleKey || t.sampleDurationMs <= 0 || span < 1) return null;
  const speed =
    !Number.isFinite(t.speedMultiplier) || t.speedMultiplier <= 0
      ? 1
      : clamp(t.speedMultiplier, 0.001, 10);
  const gridMs = gridStepMs(bpm);
  const stepMs = gridMs / speed;
  const cellDurationMs = span * stepMs;
  const attrIndex = isWrap ? (t.wrapSourceStep ?? owner) : owner;

  // Audio window (wrap continuation resumes where the source cell stopped).
  let windowStart: number;
  let windowEnd: number;
  if (isWrap && t.wrapSourceStep !== null) {
    windowStart = wrapConsumedMs(t, t.wrapSourceStep, stepMs);
    const rawEnd = t.sampleEndMs > 0 ? t.sampleEndMs : t.sampleDurationMs;
    windowEnd = rawEnd + (t.sampleEndMsOffsets[attrIndex] ?? 0);
  } else {
    const win = cellWindow(t, attrIndex);
    windowStart = win.startMs;
    windowEnd = win.endMs;
  }

  // Lead-in silence: negative start + pre-silence + rhythmic offset + swing.
  const negativeStartMs = windowStart < 0 ? -windowStart : 0;
  const preSilence = t.preSilenceMs + (t.preSilenceMsOffsets[attrIndex] ?? 0);
  const rhythmicMs = stepMs * (t.rhythmicOffsetRatios[attrIndex] ?? 0);
  const swingMs = t.swing > 0 && attrIndex % 2 === 1 ? t.swing * 0.5 * gridMs : 0;
  const silenceMs = Math.min(
    cellDurationMs,
    negativeStartMs + Math.max(0, preSilence) + rhythmicMs + swingMs,
  );

  const audioStart = Math.max(0, windowStart);
  const effectiveEnd = windowEnd > 0 ? windowEnd : t.sampleDurationMs;
  const fileAudioDur = Math.max(0, effectiveEnd - audioStart);
  if (fileAudioDur <= 0) return null;

  const ownerRev = t.reverseSteps[attrIndex] ?? false;
  // XOR, not OR: the engine composes track-reverse and per-step reverse as
  // toggles, so track+step both reversed plays FORWARD (UX-RESEARCH
  // audibility-fidelity fix — OR drew it mirrored).
  const reversed = t.isReversed !== ownerRev;
  const segments: WaveSegment[] = [];

  if (t.stretchToCell && !t.loopEnabled) {
    // Stretch-to-cell: the whole window spans the whole cell.
    segments.push({
      audioStartMs: audioStart,
      audioEndMs: effectiveEnd,
      visualStartFrac: silenceMs / cellDurationMs,
      visualEndFrac: 1,
      stepIndex: owner,
    });
    return {
      segments,
      silenceFrac: silenceMs / cellDurationMs,
      reversed,
      windowStartMs: audioStart,
      windowEndMs: effectiveEnd,
    };
  }

  // Per-step consumption; loop mode wraps the window instead of stopping.
  let cursor = 0; // consumed audio ms relative to audioStart (unwrapped)
  let visualMs = silenceMs;
  for (let k = 0; k < span && visualMs < cellDurationMs; k++) {
    const step = owner + k;
    const rate = stepRate(t, t.playbackMode === "owner" ? attrIndex : step);
    const stepVisualEnd = Math.min(silenceMs + (k + 1) * stepMs, cellDurationMs);
    let remainingVisual = stepVisualEnd - visualMs;
    while (remainingVisual > 0.001) {
      const posInWindow = t.loopEnabled ? cursor % fileAudioDur : cursor;
      if (!t.loopEnabled && posInWindow >= fileAudioDur) break;
      const audioLeft = fileAudioDur - posInWindow;
      const visualForAudio = audioLeft / rate;
      const take = Math.min(remainingVisual, visualForAudio);
      segments.push({
        audioStartMs: audioStart + posInWindow,
        audioEndMs: audioStart + posInWindow + take * rate,
        visualStartFrac: visualMs / cellDurationMs,
        visualEndFrac: (visualMs + take) / cellDurationMs,
        stepIndex: step,
      });
      cursor += take * rate;
      visualMs += take;
      remainingVisual -= take;
      if (!t.loopEnabled && take >= visualForAudio - 0.0001 && remainingVisual > 0.001) {
        break; // audio exhausted mid-step, no wrap
      }
    }
    if (!t.loopEnabled && cursor >= fileAudioDur) break;
    visualMs = stepVisualEnd;
  }
  return {
    segments,
    silenceFrac: silenceMs / cellDurationMs,
    reversed,
    windowStartMs: audioStart,
    windowEndMs: effectiveEnd,
  };
}

/**
 * SIG-1 — INVERT the segment map: a source position (ms into the sample) → where
 * that audio is DRAWN inside the cell (0…1 of the cell width). null if this cell
 * isn't showing that part of the sample right now.
 *
 * This is the whole trick behind the truthful playhead, and it needs no new
 * knowledge on either side. The engine says "voice is at frame N". The cell was
 * already drawn from those same source frames, through trim, chop, pitch,
 * varispeed, stretch, loop-wrap and lead-in silence. So the drawing itself is
 * the coordinate system: run the map backwards and you get the exact column the
 * playing audio is standing on — no assumptions about tempo, no re-deriving what
 * the engine did.
 *
 * REVERSE composes correctly, and that is the case that proves it. A reversed
 * cell draws the MIRRORED window (see drawSeg: it reflects the slice through
 * [windowStart, windowEnd] and hands drawWave `reversed: true`), while the voice
 * still reports a plain forward buffer index counting DOWN. So the segment whose
 * *drawn* audio contains the position is the mirrored one, and within it the
 * fraction runs the other way. Both flips are applied here, once.
 *
 * ⚠️ FLAM: a ratcheted cell draws N compressed copies of the same segment, and
 * the engine does not say which copy is sounding. The mapping ignores the
 * compression, so the mark is approximate on flam cells — deliberately, rather
 * than guessing at a copy and being confidently wrong.
 */
export function sourceMsToCellFrac(wave: CellWaveform, posMs: number): number | null {
  const EPS = 1e-6;
  for (const seg of wave.segments) {
    // The window this segment actually DRAWS — mirrored when the cell is
    // reversed, because that is what drawSeg put on screen.
    const d0 = wave.reversed
      ? wave.windowStartMs + (wave.windowEndMs - seg.audioEndMs)
      : seg.audioStartMs;
    const d1 = wave.reversed
      ? wave.windowStartMs + (wave.windowEndMs - seg.audioStartMs)
      : seg.audioEndMs;
    const span = d1 - d0;
    if (span <= EPS) continue;
    if (posMs < d0 - EPS || posMs > d1 + EPS) continue;
    // Reversed segments read right-to-left inside their own visual span.
    const u = wave.reversed ? (d1 - posMs) / span : (posMs - d0) / span;
    const v = seg.visualStartFrac + clamp(u, 0, 1) * (seg.visualEndFrac - seg.visualStartFrac);
    return clamp(v, 0, 1);
  }
  return null;
}

/**
 * One flam copy's span inside the owner step (P5-PCE).
 *
 * The owner step re-fires N× — but the pre-silence does NOT shrink with the
 * copies. The engine spaces the sub-hit frames evenly across the step
 * (NativeAudioEngineCore :4575) and then hands EVERY sub-hit voice the same
 * `preSilenceFramesRemaining` at its own trigger (:5382), so hit k sounds at
 * `k·slot + preSilence`: the whole flam group moves later by the full lead-in,
 * and the gap in front of each stroke stays the same size. Dividing the lead-in
 * by N (the old draw) showed a shift of only preSilence/N.
 *
 * Maps a segment's owner-step-local range [`local0`,`local1`] (0..1 across the
 * step, lead-in included) into sub-slot `f`, returning the cell-fraction span to
 * draw. Null once the lead-in fills the sub-slot — the hit is choked by the next
 * trigger before it ever sounds, so there is nothing to show.
 */
export function flamCopySpan(
  local0: number,
  local1: number,
  silenceLocal: number,
  stepFrac: number,
  flam: number,
  f: number,
): { v0: number; v1: number } | null {
  const slot = 1 / flam; // sub-slot width, step-local
  const audioW = slot - silenceLocal; // room left after the full-size gap
  const stepAudioW = 1 - silenceLocal; // the step's own audio region
  if (audioW <= 1e-6 || stepAudioW <= 1e-6) return null;
  const u0 = clamp((local0 - silenceLocal) / stepAudioW, 0, 1);
  const u1 = clamp((local1 - silenceLocal) / stepAudioW, 0, 1);
  const base = f * slot + silenceLocal;
  return { v0: (base + u0 * audioW) * stepFrac, v1: (base + u1 * audioW) * stepFrac };
}

/**
 * Pre-silence onset as a fraction of the cell, for note cells — the gap IS the
 * delay before the note-on. Mirrors the native MIDI generator, which clamps the
 * delay inside the cell (NativeAudioEngineCore :1636) and then fans the flam
 * hits from it. (Sample cells get this for free out of the segment mapping.)
 */
export function preSilenceOnsetFrac(
  t: GridTrackState,
  bpm: number,
  owner: number,
  span: number,
): number {
  const speed =
    !Number.isFinite(t.speedMultiplier) || t.speedMultiplier <= 0
      ? 1
      : clamp(t.speedMultiplier, 0.001, 10);
  const cellDurationMs = span * (gridStepMs(bpm) / speed);
  if (cellDurationMs <= 0) return 0;
  const preMs = Math.max(0, t.preSilenceMs + (t.preSilenceMsOffsets[owner] ?? 0));
  return clamp(preMs / cellDurationMs, 0, 0.98);
}

/** Per-step draw amplitude (native waveformPaths: (gain + volOffset) × accent). */
export function stepAmplitude(t: GridTrackState, stepIndex: number, ownerStep: number): number {
  const accent = t.accentLevels[ownerStep] ?? 0;
  const accentMul = accent === 2 ? 1.5 : accent === 1 ? 1.25 : 1;
  const base = t.renderGain + (t.volumeOffsets[stepIndex] ?? 0);
  return clamp(base * accentMul, 0, 2);
}
