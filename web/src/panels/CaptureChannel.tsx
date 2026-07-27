import { useEffect, useState } from "react";
import { CaptureState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button } from "../design/controls.tsx";
import { OutputMeter } from "../design/OutputMeter.tsx";

/**
 * CAPTURE — the recorder, as a mixer channel (MIXER-CONCEPT: "record = a
 * capture channel"; CAP-3).
 *
 * It is the console's one SINK. Capture takes the FULL PROGRAM off the main
 * bus — what you hear is what you capture (ToolbarRecorder.swift:6) — so it has
 * no level, no sends, no M/S and nothing to route out. To capture a subset you
 * mute the other channels, which is exactly what a mixer is for.
 *
 * The whole interaction is ONE button: press to record (no arm step), press to
 * stop — at which point the take window presents itself with the crop. The
 * bottom row rides the console's routing-picker baseline (MIX-R7) so the block
 * still aligns with every other channel.
 */
export function CaptureChannel({ link }: { link: EngineLink | null }) {
  const [state, setState] = useState<CaptureState | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("capture", (raw) => {
      const parsed = CaptureState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "capture" }).catch(() => {});
    return off;
  }, [link]);

  // The elapsed clock is derived HERE rather than pushed: it is a pure function
  // of "when did phase become recording", so putting it on the wire would mean
  // a 30 Hz push carrying a number the page can count by itself.
  const recording = state?.phase === "recording";
  useEffect(() => {
    if (!recording) {
      setElapsedMs(0);
      return;
    }
    const startedAt = performance.now();
    const t = setInterval(() => setElapsedMs(performance.now() - startedAt), 250);
    return () => clearInterval(t);
  }, [recording]);

  return (
    <CaptureChannelView
      phase={state?.phase ?? "idle"}
      elapsedMs={elapsedMs}
      meter={<OutputMeter link={link} className="ch-output-meter" />}
      onOp={(op) => void link?.command("capture", { op }).catch(() => {})}
    />
  );
}

/** The pure view — what the render tests target. */
export function CaptureChannelView(props: {
  phase: CaptureState["phase"];
  elapsedMs: number;
  meter?: React.ReactNode;
  onOp: (op: string) => void;
}) {
  const { phase, elapsedMs, onOp } = props;
  const recording = phase === "recording";

  return (
    <section className="channel channel-capture">
      <div className="ch-top">
        <span className="ch-label-only">CAPTURE</span>
        <Button
          label={recording ? "■" : "●"}
          title={
            recording
              ? "Stop — the take opens for cropping"
              : "Record the full program (what you hear is what you capture)"
          }
          active={phase !== "idle"}
          onClick={() => onOp("toggle")}
        />
      </div>

      {/* The app's OUTPUT meter, and it belongs here (TB-1): capture records the
          main bus, so the level you are metering is literally the level you are
          recording — one bar, no second field on the wire carrying the same
          number. Recording state is carried by the ●/■ button and the clock
          below, which frees the meter to be a plain, honest output read
          (peak-hold, dB scale, clip latch) instead of a red activity light. */}
      <div className="ch-meter-row">{props.meter}</div>

      <div className="ch-bottom">
        {phase === "recorded" ? (
          <Button label="TAKE…" title="Crop the take and send it" onClick={() => onOp("openWindow")} />
        ) : (
          <span className="ch-out dim mono">{recording ? `● ${clock(elapsedMs)}` : "READY"}</span>
        )}
      </div>
    </section>
  );
}

/** mm:ss — a take is minutes long at most, so no hours field. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
