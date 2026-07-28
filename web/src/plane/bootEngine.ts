/**
 * P3-U1 — the plane starts the engine sink itself.
 *
 * `companionEngine.play/publish` early-return on `!audio.running`, and the only
 * caller of `startEngine()` used to be the companion panel's start button — in a
 * DIFFERENT WebView with its own store, which can never start this window's
 * sink. So in the plane window a grid strip's transport, its scene pads and
 * every tempo intent were enabled and silently inert.
 *
 * On the NATIVE host `NativeWorldSink.start()` is gestureless by design (the
 * shell's engine is already rendering; there is no AudioContext to unlock), so
 * the plane may start it on boot. In the BROWSER the click stays mandatory:
 * `AudioContext` is gesture-gated, and an auto-started context sits `suspended`
 * while every call "succeeds" — the exact silent failure companionEngine's
 * header warns about. That asymmetry is this function's whole job.
 */

import type { EngineStatus } from "../store/companionEngine.ts";

/** The slice of the companion store this needs — injected so the decision and
    the failure surfacing are testable without a DOM or a JUCE host. */
export interface EngineStarter {
  startEngine(): Promise<void>;
  engine: EngineStatus;
  error: string | null;
}

/**
 * Start the engine sink if this host needs no gesture for it.
 * Returns a message for the plane's note line on failure, else null.
 */
export async function autoStartEngine(
  hasNativeEngine: boolean,
  getStore: () => EngineStarter,
): Promise<string | null> {
  if (!hasNativeEngine) return null; // browser: the companion's button, a real click
  await getStore().startEngine();
  const s = getStore();
  if (s.engine === "failed")
    return s.error ?? "engine failed to start — grid strips will not play";
  return null;
}
