/**
 * tokens.core.ts — THE pinned suite identity, shared byte-for-byte across the
 * xpert product line (parlante / wizard / scoopy). This file holds only the
 * VALUES and the interfaces that describe them — the neutral-grey chrome, the
 * mono-dominant type scale, shape, base motion and the font stacks. It emits
 * nothing and reads no DOM: each app keeps its own tokenVars()/applyTokens()
 * emitter and layers its own app-local groups (channel accents, semantic
 * colors, looks, …) on top.
 *
 * Vendored, not linked (see shared/README.md): edit here, `npm run shared:sync`
 * in each app, commit. Never edit an app's vendored copy directly. The value
 * pins in tokens.core.test.ts (vendored alongside) fail if any app's identity
 * drifts from this file.
 *
 * Formatting note: this file is intentionally semicolon-free to match the app
 * that first documented the shared-identity contract; it is hashed byte-for-byte
 * so do not reformat a vendored copy.
 */

export interface ChromeColors {
  bg: string
  bgRaised: string
  line: string
  text: string
  textDim: string
  /** ONE accent: selection, focus, active. */
  accent: string
  /** Meters, playhead, live activity. */
  signal: string
  warn: string
  hot: string
}

export interface TypeStep {
  sizePx: number
  weight: number
  trackingEm: number
  family: 'mono' | 'ui'
  uppercase: boolean
}

/** The five-step, mono-dominant scale. */
export interface TypeScale {
  display: TypeStep
  title: TypeStep
  label: TypeStep
  value: TypeStep
  caption: TypeStep
}

export interface ShapeTokens {
  /** 0 = sharp (the instrument default). Drives --radius and derived radii. */
  radiusPx: number
  /** Border width. */
  hairlinePx: number
}

/** The motion values every app shares. Each app's own MotionTokens interface
    extends this with app-specific fields (scale, easeOut, tricks, pulseMs…). */
export interface MotionBase {
  fastMs: number
  baseMs: number
  ease: string
}

// --- THE SUITE IDENTITY (byte-identical across every app) --------------------
// Changing a value here without every sibling agreeing is exactly the drift the
// vendored tokens.core.test.ts exists to catch.

export const SHARED_CHROME: ChromeColors = {
  bg: '#141414',
  bgRaised: '#1e1e1e',
  line: '#2e2e2e',
  text: '#d8d8d8',
  textDim: '#7f7f7f',
  accent: '#ef8b9a',
  signal: '#57c07a',
  warn: '#d9a13f',
  hot: '#d95c5c',
}

export const SHARED_TYPE: TypeScale = {
  display: { sizePx: 16, weight: 500, trackingEm: 0.12, family: 'ui', uppercase: true },
  title: { sizePx: 11, weight: 600, trackingEm: 0.08, family: 'mono', uppercase: true },
  label: { sizePx: 11, weight: 500, trackingEm: 0.02, family: 'mono', uppercase: true },
  value: { sizePx: 11, weight: 500, trackingEm: 0, family: 'mono', uppercase: false },
  caption: { sizePx: 10, weight: 400, trackingEm: 0, family: 'ui', uppercase: false },
}

/** Sharp + hairline: the instrument default. */
export const SHARED_SHAPE: ShapeTokens = { radiusPx: 0, hairlinePx: 1 }

/** Base durations + primary ease. Apps spread this into their own motion group
    (adding scale, easeOut, tricks, …). */
export const SHARED_MOTION: MotionBase = {
  fastMs: 90,
  baseMs: 120,
  ease: 'cubic-bezier(0.2, 0, 0.2, 1)',
}

export const FONT_MONO = '"SF Mono", ui-monospace, Menlo, monospace'
export const FONT_UI = '-apple-system, system-ui, sans-serif'
