/**
 * Design tokens — THE single source of truth for every color, font, size and
 * radius in the Wizard web UI. Nothing outside web/src/design/ may hardcode a
 * visual constant; the check:tokens gate enforces it.
 *
 * Wizard is the THIRD wearer of the shared suite identity (after ScoopyLoops and
 * Parlante). Per D-WZ-DESIGN-01 this file vendors the shared *token core* only —
 * the neutral-grey chrome, the mono-dominant type scale, shape and motion — with
 * the DEFAULT values byte-identical to the sibling apps (the SHARED_CHROME /
 * SHARED_TYPE constants below; the portability fixture pins them so drift across
 * the three apps fails CI). Scoopy's interaction primitives (DragBox, semantic
 * send/mod/deck arrays, waveform styling) are NOT copied — Wizard's channel and
 * deck anatomy is built app-local. The full shared identity is applied at PD.
 *
 * The one app-local group is WIZARD_ACCENTS: channel-kind tints and the record /
 * feedback lamps, which are Wizard's own vocabulary, not the shared chrome.
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

export interface ShapeTokens {
  /** 0 = sharp (the instrument default). Drives --radius and derived radii. */
  radiusPx: number
  /** Border width. */
  hairlinePx: number
}

export interface MotionTokens {
  /** Master lever: 0 collapses every duration to instant, no rule branching. */
  scale: number
  fastMs: number
  baseMs: number
  ease: string
}

/** Wizard-local accents — channel-kind tints + the record/feedback lamps. Not
    part of the shared chrome; Wizard's own vocabulary (ARCHITECTURE §7.3). */
export interface WizardAccents {
  /** Channel-kind accent by Source kind — a hardware input reads different from
      an app tap, a deck, or the virtual device, at a glance. */
  channelKind: {
    device: string
    appTap: string
    deck: string
    virtualDevice: string
    bus: string
  }
  /** The record-arm / recording lamp and the feedback-watchdog alarm lamp. */
  recLamp: string
  feedbackLamp: string
}

export interface DesignTokens {
  polarity: 'dark' | 'light'
  chrome: ChromeColors
  shape: ShapeTokens
  motion: MotionTokens
  fontMono: string
  fontUI: string
  type: {
    display: TypeStep
    title: TypeStep
    label: TypeStep
    value: TypeStep
    caption: TypeStep
  }
  accents: WizardAccents
}

// --- SHARED IDENTITY (byte-identical across ScoopyLoops / Parlante / Wizard) --
// These values are the suite's neutral-grey instrument identity. The portability
// fixture (tokens.test.ts) pins every hex; changing one here without the sibling
// apps agreeing is exactly the drift the fixture exists to catch.
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

export const SHARED_TYPE = {
  display: { sizePx: 16, weight: 500, trackingEm: 0.12, family: 'ui', uppercase: true },
  title: { sizePx: 11, weight: 600, trackingEm: 0.08, family: 'mono', uppercase: true },
  label: { sizePx: 11, weight: 500, trackingEm: 0.02, family: 'mono', uppercase: true },
  value: { sizePx: 11, weight: 500, trackingEm: 0, family: 'mono', uppercase: false },
  caption: { sizePx: 10, weight: 400, trackingEm: 0, family: 'ui', uppercase: false },
} as const satisfies DesignTokens['type']

export const DEFAULT_TOKENS: DesignTokens = {
  polarity: 'dark',
  chrome: { ...SHARED_CHROME },
  // Sharp + hairline: the instrument default.
  shape: { radiusPx: 0, hairlinePx: 1 },
  motion: {
    scale: 1,
    fastMs: 90,
    baseMs: 120,
    ease: 'cubic-bezier(0.2, 0, 0.2, 1)',
  },
  fontMono: '"SF Mono", ui-monospace, Menlo, monospace',
  fontUI: '-apple-system, system-ui, sans-serif',
  type: {
    display: { ...SHARED_TYPE.display },
    title: { ...SHARED_TYPE.title },
    label: { ...SHARED_TYPE.label },
    value: { ...SHARED_TYPE.value },
    caption: { ...SHARED_TYPE.caption },
  },
  accents: {
    // Cool → warm arc so kinds read apart at a glance; deck echoes the shared
    // signal green (it is live audio), virtual device sits on the accent pink.
    channelKind: {
      device: '#6f8fd9',
      appTap: '#5ab6c9',
      deck: '#57c07a',
      virtualDevice: '#ef8b9a',
      bus: '#7f7f7f',
    },
    recLamp: '#d95c5c',
    feedbackLamp: '#d9a13f',
  },
}

function typeVars(prefix: string, s: TypeStep): Record<string, string> {
  return {
    [`--${prefix}-size`]: `${s.sizePx}px`,
    [`--${prefix}-weight`]: `${s.weight}`,
    [`--${prefix}-tracking`]: `${s.trackingEm}em`,
    [`--${prefix}-family`]: s.family === 'mono' ? 'var(--font-mono)' : 'var(--font-ui)',
    [`--${prefix}-transform`]: s.uppercase ? 'uppercase' : 'none',
  }
}

/**
 * Emits every token as a CSS custom property. The gate (check:tokens) asks this
 * function what it defines rather than grepping, so a var referenced in CSS but
 * never emitted here is caught as a dangling var — and new token groups are
 * covered automatically.
 */
export function tokenVars(t: DesignTokens): Record<string, string> {
  return {
    'color-scheme': t.polarity,
    '--bg': t.chrome.bg,
    '--bg-raised': t.chrome.bgRaised,
    '--line': t.chrome.line,
    '--text': t.chrome.text,
    '--text-dim': t.chrome.textDim,
    '--accent': t.chrome.accent,
    '--signal': t.chrome.signal,
    '--warn': t.chrome.warn,
    '--hot': t.chrome.hot,
    // Shape. Role radii DERIVE from the one number, so a look sets radiusPx and
    // every corner follows.
    '--radius': `${t.shape.radiusPx}px`,
    '--radius-sm': 'calc(var(--radius) * 0.5)',
    '--radius-lg': 'calc(var(--radius) * 2)',
    '--hairline': `${t.shape.hairlinePx}px`,
    // Motion. One lever: at scale 0 every calc() resolves to 0ms and the app is
    // instant, with no rule testing whether motion is enabled. base.css forces
    // this to 0 under prefers-reduced-motion.
    '--motion-scale': `${t.motion.scale}`,
    '--dur-fast': `calc(${t.motion.fastMs}ms * var(--motion-scale))`,
    '--dur-base': `calc(${t.motion.baseMs}ms * var(--motion-scale))`,
    '--ease': t.motion.ease,
    '--font-mono': t.fontMono,
    '--font-ui': t.fontUI,
    // Wizard-local accents.
    '--chan-device': t.accents.channelKind.device,
    '--chan-app-tap': t.accents.channelKind.appTap,
    '--chan-deck': t.accents.channelKind.deck,
    '--chan-virtual': t.accents.channelKind.virtualDevice,
    '--chan-bus': t.accents.channelKind.bus,
    '--rec-lamp': t.accents.recLamp,
    '--feedback-lamp': t.accents.feedbackLamp,
    ...typeVars('type-display', t.type.display),
    ...typeVars('type-title', t.type.title),
    ...typeVars('type-label', t.type.label),
    ...typeVars('type-value', t.type.value),
    ...typeVars('type-caption', t.type.caption),
  }
}

/** Writes every token as a CSS custom property on :root. */
export function applyTokens(t: DesignTokens): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(tokenVars(t))) root.style.setProperty(k, v)
}
