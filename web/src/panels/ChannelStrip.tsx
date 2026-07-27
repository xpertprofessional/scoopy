import { useRef, useEffect, type ReactNode } from "react";
import { HotFrameLayout } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, GeoRange } from "../design/controls.tsx";
import { useLearnMenu, useLearnStatus } from "../design/DragBox.tsx";
import { semanticColor } from "../design/tokens.ts";
import type { LearnTarget } from "../state/midiLearn.ts";

// The per-channel X-MIX side picker (XMIX_SIDES + the `side` prop) LEFT this strip
// (mixer overhaul, 2026-07-14): sides are fixed policy — deck A→a, deck B→b, the
// rest own — until the X-MIX matrix. The CarveMeter went with it: with no picker
// there is no per-channel carve state to explain, and on the deck strips it read
// as a mystery artifact.

/** One inline send: an FX-bus tap on a source channel. */
export type ChannelSend = {
  value: number;
  /** aria/title text, e.g. "Input send to FX1". */
  label: string;
  /** No native path for this source→bus pair — render an inert placeholder. */
  disabled?: boolean;
  onChange: (v: number) => void;
};

/**
 * ChannelStrip — the unified mixer block (MIXER-CONCEPT.md):
 * every channel (deck / input / FX return) renders as the same bordered
 * block — TOP: level bar (inside-label) + M/S (+ optional aux toggle);
 * MID: inline micro-sends (INPUT only, post-overhaul) and any extra control
 * rows (`mid` — the FX strips' mode/plugin rows); BOTTOM: routing picker.
 * All strips flex to ONE equal width (deckmixer.css), so their faders have
 * mutual lengths — precise mixing needs comparable travel.
 */
export function ChannelStrip(props: {
  label: string;
  /** Top-row level control. */
  level: {
    value: number;
    min: number;
    max: number;
    onChange: (v: number) => void;
    display?: string;
    /** Makes the fader a MIDI-learn target (CM-6); omit = not learnable. */
    learn?: LearnTarget;
  } | null; // null = no level (e.g. EXT-mode FX has no return volume)
  muted?: { on: boolean; disabled?: boolean; onToggle: () => void };
  soloed?: { on: boolean; onToggle: () => void };
  /**
   * A solo is engaged on ANOTHER channel of this family — this one is currently
   * silenced by it. The whole strip recedes so the console visibly collapses to
   * the soloed channel(s): the "why did the mix go quiet?" answer, read app-wide.
   */
  soloDimmed?: boolean;
  /** Extra top-row toggle beside M/S (INPUT uses it for monitor). */
  aux?: { label: string; title?: string; on: boolean; onToggle: () => void };
  /**
   * Inline micro-sends → FX buses. Post-overhaul this is the INPUT strip only:
   * the deck master sends moved to the master track row (the deck header IS the
   * deck's master track), where they render as regular horizontal sends.
   */
  sends?: ChannelSend[];
  /**
   * Extra control rows between the meter/sends tier and the bottom routing
   * picker (the FX strips' HOST/EXT · PRE/POST and plugin · view rows). The
   * bottom row stays the ROUTING row on every channel, so all output pickers
   * land on one shared baseline.
   */
  mid?: ReactNode;
  /** Bottom row content (routing picker: OUT dest / IN source / plugin). */
  bottom: ReactNode;
  meter?: ReactNode;
  /** Level is currently inert — show it, grey it. */
  levelInert?: boolean;
  /**
   * This channel's semantic identity color (deck A/B/C, FX return 1..4) — from
   * semanticColor(). Tints the strip's border and its level fill, so a deck's
   * mixer block reads as the same object as its transport block, and FX3 as the
   * same object as every track's send 3. Omit for channels that are not a
   * member of a numbered family (INPUT).
   */
  identity?: string;
}) {
  const learnMenu = useLearnMenu(props.level?.learn);
  const learnTint = useLearnStatus(props.level?.learn);
  return (
    <section
      className={`channel${props.identity ? " sem sem-fill sem-edge" : ""}${
        props.soloDimmed ? " solo-dimmed" : ""
      }${props.soloed?.on ? " solo-on" : ""}`}
      style={props.identity ? ({ "--sem-color": props.identity } as React.CSSProperties) : undefined}
    >
      <div className={`ch-top${props.levelInert ? " ch-level-inert" : ""}`}>
        {props.level ? (
          // The fader carries the menu (and the armed/bound tint) itself —
          // native puts them on the crossfader BAR, not on a companion box.
          <span className={`ch-level${learnTint}`} onContextMenu={learnMenu}>
            <GeoRange
              label={props.label}
              display={props.level.display}
              value={props.level.value}
              min={props.level.min}
              max={props.level.max}
              step={0.01}
              onChange={props.level.onChange}
            />
          </span>
        ) : (
          <span className="ch-label-only">{props.label}</span>
        )}
        {props.muted && (
          <Button label="M" active={props.muted.on} disabled={props.muted.disabled} onClick={props.muted.onToggle} />
        )}
        {props.soloed && (
          <Button label="S" tone="solo" active={props.soloed.on} onClick={props.soloed.onToggle} />
        )}
        {props.aux && (
          <Button
            label={props.aux.label}
            title={props.aux.title}
            active={props.aux.on}
            onClick={props.aux.onToggle}
          />
        )}
      </div>

      {/* Meter gets its own full-width strip rather than a sliver beside the
          fader: as a flex item it stole horizontal room from the fader (the
          scarce axis) to show a 5px bar that reads as empty at rest. */}
      {props.meter && <div className="ch-meter-row">{props.meter}</div>}

      {props.sends && props.sends.length > 0 && (
        <div className="ch-sends" role="group" aria-label={`${props.label} FX sends`}>
          <span className="ch-send-label dim mono">SND</span>
          {props.sends.map((s, i) =>
            s.disabled ? (
              <span key={i} className="ch-micro-cell ch-micro-empty" title={s.label} />
            ) : (
              <MicroSend key={i} bus={i} value={s.value} label={s.label} onChange={s.onChange} />
            ),
          )}
        </div>
      )}

      {props.mid}

      <div className="ch-bottom">{props.bottom}</div>
    </section>
  );
}

/**
 * A micro send fader: thin vertical fill, click/drag to set 0..1,
 * double-click to zero. Deliberately NOT an ö/ä focus target — a click on a
 * slider also moves its value, so it can't acquire focus without a jump
 * (MIXER-CONCEPT "Deferred/rejected"). Carries an aria-label instead.
 *
 * The bus identity used to be purely positional (left→right = FX1..FXn), which
 * is unreadable on a 6px-wide fader. It now carries the SEND identity color —
 * the same one the track row's S<n> slider and the FX<n> return channel wear.
 */
function MicroSend({
  bus,
  value,
  label,
  onChange,
}: {
  /** 0-based FX bus index — picks the send identity color. */
  bus: number;
  value: number;
  label: string;
  onChange: (v: number) => void;
}) {
  return (
    <span
      className="ch-micro-cell sem sem-fill"
      style={{ "--sem-color": semanticColor("send", bus) } as React.CSSProperties}
    >
      <input
        className="ch-micro"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label={label}
        title={label}
        style={{
          background: `linear-gradient(to top, var(--fill) ${value * 100}%, var(--bg-raised) ${value * 100}%)`,
        }}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
      />
    </span>
  );
}

/** Live mic-input meter (a full-width strip under the fader). */
export function MicMeter({ link }: { link: EngineLink | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !link) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let level = 0;
    let raf = 0;
    const off = link.onHotFrame((frame) => {
      level = frame[HotFrameLayout.micInputLevel] ?? 0;
    });
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = css("--bg-raised");
      ctx.fillRect(0, 0, w, h);
      // Fills left→right: the meter is now a full-width strip under the fader,
      // not a vertical sliver beside it.
      ctx.fillStyle = css("--signal");
      ctx.fillRect(0, 0, Math.min(level, 1) * w, h);
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, [link]);
  return <canvas ref={canvasRef} className="mic-meter" />;
}
