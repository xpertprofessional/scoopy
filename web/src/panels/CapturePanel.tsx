import { useCallback, useEffect, useRef, useState } from "react";
import { CaptureState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, Caption, PanelTitle } from "../design/controls.tsx";
import "./capture.css";

/** Audio outside the take's trim is still SIGNAL, just not the part you kept —
    so it de-emphasises at a fixed ratio rather than scaling with chrome ink. */
const TAKE = { outTrim: 0.35 } as const;

/**
 * Capture take window (CAP-3, capture.md §3.2) — crop the recording, audition
 * the crop, then send it to a Track or to Hard Drive.
 *
 * Hosted by CaptureWindowController in a floating NSWindow, not as an in-page
 * popover: the mixer's web view is a ~128px toolbar strip that scrolls
 * horizontally, and per CSS that forces the vertical axis to `auto` too, so
 * anything hanging below a channel is clipped away (MIX-R8). A popover cannot
 * escape its host WKWebView.
 *
 * The window OPENS ITSELF when recording stops — that is what holds capture to
 * two clicks. Everything here is an intent: the export, the recordings-folder
 * write and the crash-marker protocol all stay in Swift's ToolbarRecorder.
 */
export function CapturePanel({ link }: { link: EngineLink | null }) {
  const [state, setState] = useState<CaptureState | null>(null);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("capture", (raw) => {
      const parsed = CaptureState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "capture" }).catch(() => {});
    return off;
  }, [link]);

  if (!state) return <main className="capture mono dim">waiting for capture state…</main>;

  return (
    <CapturePanelView
      state={state}
      onOp={(op, params) => void link?.command("capture", { op, ...params }).catch(() => {})}
      onLocalTrim={(s, e) => setState({ ...state, trimStart: s, trimEnd: e })}
    />
  );
}

/** The pure view — what the render tests target. */
export function CapturePanelView(props: {
  state: CaptureState;
  onOp: (op: string, params?: Record<string, unknown>) => void;
  onLocalTrim: (start: number, end: number) => void;
}) {
  const { state, onOp, onLocalTrim } = props;
  const send = (op: string, params: Record<string, unknown> = {}) => onOp(op, params);
  const { phase, waveform, trimStart, trimEnd } = state;

  return (
    <main className="capture">
      <div className="cap-head">
        <PanelTitle>Capture</PanelTitle>
        <span className="cap-phase mono dim">
          {phase === "idle" ? "READY" : phase === "recording" ? "● REC" : "DONE"}
        </span>
      </div>

      {phase === "recorded" && (
        <>
          <TrimWave
            peaks={waveform}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onTrim={(s, e) => {
              // Optimistic: the drag must track the pointer at pointer rate, not
              // at the ~35ms UiState echo. Swift re-clamps and pushes back.
              onLocalTrim(s, e);
              send("setTrim", { trimStart: s, trimEnd: e });
            }}
          />

          <div className="cap-row">
            <Button
              label={state.previewPlaying ? "■ Stop" : "▶ Play"}
              title="Audition the cropped span only"
              active={state.previewPlaying}
              onClick={() => send("togglePreview")}
            />
            <Button label="Clear" title="Discard this take" onClick={() => send("clear")} />
          </div>

          <Caption>Send this take to…</Caption>
          <div className="cap-row cap-dest">
            <Button
              label="→ Track"
              title="Add the cropped take as a new track in the deck you're editing"
              onClick={() => send("sendToTrack")}
            />
            {state.savedToDisk ? (
              <span className="cap-saved mono">✓ Saved</span>
            ) : (
              <Button
                label="→ Hard Drive"
                title="Save the cropped take as a WAV in the recordings folder"
                onClick={() => send("sendToDisk")}
              />
            )}
          </div>
        </>
      )}

      {phase === "recording" && <Caption>Recording the full program — press ■ in the mixer to stop.</Caption>}
      {phase === "idle" && <Caption>Press ● in the mixer's CAPTURE channel to record.</Caption>}

      {state.error && <p className="cap-error mono">{state.error}</p>}
    </main>
  );
}

/**
 * The take waveform with two draggable trim handles.
 *
 * Ported from WaveformTrimView: one vertical bar per pixel column (top-peak →
 * bottom-peak), in-trim bright and out-of-trim dimmed, and a drag grabs
 * whichever handle is NEARER the press — so you never have to hit a 2px target.
 *
 * Painted in DEVICE-PIXEL space with integer column snapping (the P5-02f
 * crispness lesson): fractional coordinates are what made the first grid
 * waveforms read as blurry and cheap.
 */
function TrimWave(props: {
  peaks: number[];
  trimStart: number;
  trimEnd: number;
  onTrim: (start: number, end: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef<"start" | "end" | null>(null);
  const { peaks, trimStart, trimEnd, onTrim } = props;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.fillStyle = css("--bg-raised");
    ctx.fillRect(0, 0, w, h);

    const mid = Math.round(h / 2);
    // Centre axis — grounds the trace like an instrument scope.
    ctx.fillStyle = css("--line");
    ctx.fillRect(0, mid, w, 1);

    if (peaks.length > 0) {
      const inColor = css("--signal");
      const outColor = css("--text-dim");
      for (let x = 0; x < w; x++) {
        // Column peak: max over the envelope points this device column covers,
        // so a long take doesn't alias its transients away.
        const lo = Math.floor((x * peaks.length) / w);
        const hi = Math.min(peaks.length, Math.floor(((x + 1) * peaks.length) / w) + 1);
        let peak = 0;
        for (let i = lo; i < hi; i++) peak = Math.max(peak, Math.abs(peaks[i] ?? 0));

        const frac = x / Math.max(1, w - 1);
        const inTrim = frac >= trimStart && frac <= trimEnd;
        const half = Math.max(1, Math.round(peak * (mid - 1) * 0.9));
        ctx.fillStyle = inTrim ? inColor : outColor;
        ctx.globalAlpha = inTrim ? 1 : TAKE.outTrim;
        ctx.fillRect(x, mid - half, 1, half * 2);
      }
      ctx.globalAlpha = 1;

      // Handles last, so they sit above the trace.
      ctx.fillStyle = css("--accent");
      for (const frac of [trimStart, trimEnd]) {
        const x = Math.round(frac * (w - 1));
        ctx.fillRect(Math.max(0, Math.min(w - 2, x)), 0, 2, h);
      }
    }
  }, [peaks, trimStart, trimEnd]);

  useEffect(() => {
    paint();
  }, [paint]);

  // Repaint on theme edits + resize — CSS vars alone never reach canvas paint
  // (the DS-02b lesson).
  useEffect(() => {
    const ro = new ResizeObserver(() => paint());
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [paint]);

  const fracAt = (clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (peaks.length === 0) return;
    const f = fracAt(e.clientX);
    // Grab the NEARER handle (WaveformTrimView:87) — a 2px hit target would be
    // unusable, and this is what makes the crop feel like dragging the edge.
    dragging.current = Math.abs(f - trimStart) <= Math.abs(f - trimEnd) ? "start" : "end";
    e.currentTarget.setPointerCapture(e.pointerId);
    applyDrag(f);
  };

  const applyDrag = (f: number) => {
    if (dragging.current === "start") onTrim(Math.min(f, trimEnd - 0.01), trimEnd);
    else if (dragging.current === "end") onTrim(trimStart, Math.max(f, trimStart + 0.01));
  };

  return (
    <canvas
      ref={canvasRef}
      className="cap-wave"
      aria-label="Take waveform — drag the edges to crop"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (dragging.current) applyDrag(fracAt(e.clientX));
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    />
  );
}
