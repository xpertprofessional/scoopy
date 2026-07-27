/**
 * The contract between the companion page and the DJ-mixer Chrome extension
 * (extension/ at the repo root) — the ONLY thing the two sides share at
 * runtime. The extension never reads the page's DOM: layout can change freely
 * as long as this module's messages keep their meaning.
 *
 * Versioning works like web/protocol/schema.ts, one level smaller:
 * `BRIDGE_VERSION` bumps on any breaking message change, and the handshake
 * (`hello` → `helloAck`) carries it plus a capability list. The extension
 * disables any control whose capability the page did not advertise — that is
 * how an old extension degrades against a newer app instead of breaking.
 *
 * Both sides import THIS file (the extension build reaches into ../web/src),
 * so a shape change is a compile error over there, not a runtime surprise.
 * This is deliberately NOT part of SLPProtocol/BrowserLink — that surface is
 * the native host's, and in browser mode it is a stub.
 */
import { z } from "zod";

export const BRIDGE_VERSION = 1;

/** `source` tag on envelopes the PAGE posts (page → extension). */
export const PAGE_SOURCE = "scoopy-bridge" as const;
/** `source` tag on envelopes the EXTENSION posts (extension → page). */
export const EXT_SOURCE = "scoopy-ext" as const;

/**
 * What this page can do. The mixer gates every control on these strings, so a
 * capability is SHIPPED when the page both advertises and implements it —
 * never advertise ahead of the implementation.
 */
export const CAPABILITIES = [
  "transport", // play / stop
  "tempo", // setBpm — a DOCUMENT edit (autosaves)
  "tempoOverride", // setTempoOverride — a performance gesture (never persisted)
  "mainGain", // setMainGain — per-window master fader
  "levels", // rms/peak stream while subscribed
  "restartAt", // scheduled restart-from-step-0 (dual-deck LAUNCH)
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const finite = z.number().finite();

/** Extension → page. */
export const toPageMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("getState") }),
  z.object({ type: z.literal("subscribe"), levels: z.boolean() }),
  z.object({ type: z.literal("unsubscribe") }),
  z.object({ type: z.literal("play") }),
  z.object({ type: z.literal("stop") }),
  /** Restart from step 0 at a shared wall-clock deadline (epoch ms — compare
   * against `performance.timeOrigin + performance.now()` on arrival). */
  z.object({ type: z.literal("restartAt"), epochMs: finite }),
  /** Document tempo edit — autosaves, exactly like typing in the BPM box. */
  z.object({ type: z.literal("setBpm"), bpm: finite.min(1).max(999) }),
  /** Performance tempo — what the engine hears while syncing/nudging. `null`
   * hands the clock back to the document bpm. Never touches the session. */
  z.object({ type: z.literal("setTempoOverride"), bpm: finite.min(0.001).max(999).nullable() }),
  /** Final per-window gain (the mixer computes the crossfade law itself). */
  z.object({ type: z.literal("setMainGain"), value: finite.min(0).max(4) }),
]);
export type ToPageMessage = z.infer<typeof toPageMessage>;

export const engineStatus = z.enum(["idle", "starting", "running", "failed"]);
export type EngineStatusWire = z.infer<typeof engineStatus>;

/** Page → extension. */
export const fromPageMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("helloAck"),
    bridgeVersion: z.number().int(),
    // Plain strings, not the enum: a NEWER page may advertise capabilities
    // this build has never heard of, and that must parse, not reject.
    capabilities: z.array(z.string()),
  }),
  z.object({
    type: z.literal("state"),
    sessionName: z.string().nullable(),
    /** Document bpm (null until a session is open). */
    bpm: finite.nullable(),
    playing: z.boolean(),
    engine: engineStatus,
    /** Echo of the last setMainGain accepted — the e2e probe for the gain path. */
    lastMainGain: finite,
    tempoOverride: finite.nullable(),
  }),
  z.object({ type: z.literal("levels"), rms: finite, peak: finite }),
]);
export type FromPageMessage = z.infer<typeof fromPageMessage>;

/** Envelopes as they cross window.postMessage. */
export interface ToPageEnvelope {
  source: typeof EXT_SOURCE;
  msg: ToPageMessage;
}
export interface FromPageEnvelope {
  source: typeof PAGE_SOURCE;
  msg: FromPageMessage;
}
