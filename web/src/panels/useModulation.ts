import { useEffect, useRef, useState } from "react";
import { HotFrameLayout, ModulationUiState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { semanticColor } from "../design/tokens.ts";
import type { ModLive } from "./ModCanvas.tsx";
import type { ShapeChannel } from "./modShape.ts";

/**
 * The modulation domain, subscribed once (MOD-6).
 *
 * Two channels of data, deliberately kept apart:
 *
 *  - **State** (`ModulationUiState`) arrives on the "modulation" topic at human rate and DOES
 *    drive React. Swift has already resolved the M1/M2-legacy vs M3/M4-generic split, so what
 *    lands here is flat — nothing below derives a channel's type or reads a legacy field.
 *
 *  - **Live values** (channel output + shape phase) arrive on the 30 Hz HotFrame and must NEVER
 *    touch React: they'd re-render the whole grid 30×/second. They land in a ref that the canvases
 *    poll from inside their own rAF loop. Same discipline as every other hot surface.
 */
export interface Modulation {
  state: ModulationUiState | null;
  /** Poll the live value+phase for a channel. Safe to call from inside a rAF loop. */
  getLive: (channelIndex: number) => ModLive;
  /** Send a modChannel command. */
  send: (op: string, index: number, extra?: Record<string, unknown>) => void;
}

const IDLE: ModLive = { value: 0, phase: -1 };

export function useModulation(link: EngineLink | null): Modulation {
  const [state, setState] = useState<ModulationUiState | null>(null);
  const live = useRef<ModLive[]>([{ ...IDLE }, { ...IDLE }, { ...IDLE }, { ...IDLE }]);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("modulation", (raw) => {
      const parsed = ModulationUiState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "modulation" }).catch(() => {});
    return off;
  }, [link]);

  useEffect(() => {
    if (!link) return;
    const VAL = [
      HotFrameLayout.modChannel0,
      HotFrameLayout.modChannel1,
      HotFrameLayout.modChannel2,
      HotFrameLayout.modChannel3,
    ];
    const PHASE = [
      HotFrameLayout.modChannelPhase0,
      HotFrameLayout.modChannelPhase1,
      HotFrameLayout.modChannelPhase2,
      HotFrameLayout.modChannelPhase3,
    ];
    return link.onHotFrame((frame) => {
      for (let i = 0; i < 4; i++) {
        const slot = live.current[i]!;
        slot.value = frame[VAL[i]!] ?? 0;
        slot.phase = frame[PHASE[i]!] ?? -1;
      }
    });
  }, [link]);

  return {
    state,
    getLive: (i: number) => live.current[i] ?? IDLE,
    send: (op, index, extra) => {
      link?.command("modChannel", { op, index, ...extra }).catch(() => {});
    },
  };
}

/** Adapt the wire state to the shape math's structural input (modShape.ts). */
export function toShapeChannel(
  ch: ModulationUiState["channels"][number],
  channelIndex = 0,
  lcmSteps = 0,
): ShapeChannel {
  return {
    type: ch.type,
    waveform: ch.waveform,
    symmetry: ch.symmetry,
    phaseOffset: ch.phaseOffset,
    depth: ch.depth,
    slant: ch.slant,
    ease: ch.ease,
    jitter: ch.jitter,
    cyclic: ch.cyclic,
    // MOD-12 AGITATION timing — the segment length + LCM period the random step-ramp draws over.
    stepsPerCycle: ch.stepsPerCycle,
    lcmSteps,
    envelopeNodes: ch.envelopeNodes,
    sustainNodeIndex: ch.sustainNodeIndex,
    bipolar: ch.bipolar,
    channelIndex,
  };
}

/**
 * M1–M4 identity colour — the same hue carries the arm button, the mapped-control
 * rings, the `M<n>·<TGT>` slots and the sweep bands, so a glance at a track row
 * tells you WHICH modulator owns each parameter.
 *
 * This used to be a hardcoded `rgb()` array here (it only passed check:tokens
 * because the gate greps for HEX). It is now one family of the SEMANTIC colour
 * system (DESIGN-SYSTEM §2b), which means the four hues are editable in
 * Appearance, switchable off with everything else, and — the point of the
 * system — chosen from an arc that cannot collide with the SEND colours the mod
 * bands sit next to in a track row.
 *
 * A FUNCTION, not a const: tokens are edited live, so the colour must be read at
 * paint time. Canvas surfaces get a real colour string here (they cannot resolve
 * CSS vars); DOM surfaces spend it through `--mod-color`.
 */
export function modColor(index: number): string {
  return semanticColor("mod", index);
}

export const MOD_NAMES = ["M1", "M2", "M3", "M4"];
