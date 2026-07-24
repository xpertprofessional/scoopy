/**
 * The command envelope — the wire format every JUCE-hosted xpert app speaks
 * between the web UI and the native shell. These two schemas were already
 * byte-identical across the line; this is now the one definition.
 *
 * The shell's C++ dispatcher mirrors CommandReplySchema exactly ({ok, result?,
 * error?}), so a change here is a wire-format change requiring both sides to
 * move together.
 *
 * All three apps speak this envelope. ScoopyLoops converged in phase 5
 * (shared/ROLLOUT.md; P0-A of the wizard×scoopy merge): its WKWebView shell
 * emits the same `{id, ok, result?, error?}` reply the JUCE dispatchers do.
 *
 * Vendored, not linked — see shared/README.md.
 */
import { z } from 'zod'

export const CommandEnvelopeSchema = z
  .object({
    id: z.number().int().nonnegative(),
    method: z.string(),
    params: z.unknown(),
  })
  .strict()

export const CommandReplySchema = z
  .object({
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict()
