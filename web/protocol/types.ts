/**
 * The command-table contract every xpert app's protocol schema follows, plus the
 * type helpers derived from it. Sharing these means the SHAPE of a command
 * registry is defined once; the vocabulary (which methods exist) stays per-app.
 *
 * Each app's schema.ts declares its own `COMMANDS` and aliases the helpers:
 *
 *   export type Method = MethodOf<typeof COMMANDS>
 *   export type Params<M extends Method> = ParamsOf<typeof COMMANDS, M>
 *   export type Result<M extends Method> = ResultOf<typeof COMMANDS, M>
 *
 * Vendored, not linked — see shared/README.md.
 */
import type { z } from 'zod'

/** One command: a zod schema for its params and one for its result. */
export interface CommandSpec {
  params: z.ZodTypeAny
  result: z.ZodTypeAny
}

/** A registry of commands keyed by JSON-RPC style method name. */
export type CommandTable = Record<string, CommandSpec>

export type MethodOf<T extends CommandTable> = keyof T

export type ParamsOf<T extends CommandTable, M extends keyof T> = z.infer<T[M]['params']>

export type ResultOf<T extends CommandTable, M extends keyof T> = z.infer<T[M]['result']>
