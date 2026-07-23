/**
 * Design tokens — THE single source of truth for every color, font, size and
 * radius in the Wizard web UI. Nothing outside web/src/design/ may hardcode a
 * visual constant; the check:tokens gate enforces it.
 *
 * Wizard is one wearer of the shared suite identity (with ScoopyLoops and
 * Parlante). The neutral-grey chrome, the mono-dominant type scale, shape and
 * base motion are NOT defined here — they are vendored, byte-identical across
 * the line, from `shared/design/tokens.core.ts` (see shared/README.md) and
 * re-exported below so existing importers are unaffected. The value pins live
 * in tokens.core.test.ts, vendored alongside; drift from a sibling fails CI.
 *
 * This file adds only Wizard's own composition and vocabulary: DEFAULT_TOKENS,
 * the WIZARD_ACCENTS group (channel-kind tints + the record/feedback lamps),
 * and the tokenVars()/applyTokens() emitter.
 */
import {
  FONT_MONO,
  FONT_UI,
  SHARED_CHROME,
  SHARED_MOTION,
  SHARED_SHAPE,
  SHARED_TYPE,
  type ChromeColors,
  type MotionBase,
  type ShapeTokens,
  type TypeStep,
  // Explicit .ts extension: the check:tokens gate loads this module under raw
  // `node --experimental-strip-types`, which (unlike Vite) will not resolve an
  // extensionless relative import.
} from './tokens.core.ts'

// Re-export the shared identity so existing importers (and tokens.test.ts)
// keep resolving these from './tokens'.
export { SHARED_CHROME, SHARED_TYPE }
export type { ChromeColors, ShapeTokens, TypeStep }

export interface MotionTokens extends MotionBase {
  /** Master lever: 0 collapses every duration to instant, no rule branching. */
  scale: number
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

export const DEFAULT_TOKENS: DesignTokens = {
  polarity: 'dark',
  chrome: { ...SHARED_CHROME },
  shape: { ...SHARED_SHAPE },
  motion: {
    scale: 1,
    ...SHARED_MOTION,
  },
  fontMono: FONT_MONO,
  fontUI: FONT_UI,
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
