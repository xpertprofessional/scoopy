import { expect, test } from 'vitest'
import { DEFAULT_TOKENS, SHARED_CHROME, SHARED_TYPE, tokenVars } from './tokens'

/**
 * Portability fixture (PD-05 style, D-WZ-DESIGN-01). Wizard is the third wearer
 * of the shared suite identity; these assertions PIN the shared chrome + type
 * scale byte-for-byte. If a value drifts from the sibling apps, this fails —
 * the fixture is the compatibility gate, not a preference.
 */
test('shared chrome hexes are the exact suite identity', () => {
  expect(SHARED_CHROME).toEqual({
    bg: '#141414',
    bgRaised: '#1e1e1e',
    line: '#2e2e2e',
    text: '#d8d8d8',
    textDim: '#7f7f7f',
    accent: '#ef8b9a',
    signal: '#57c07a',
    warn: '#d9a13f',
    hot: '#d95c5c',
  })
})

test('shared type scale is mono-dominant with the suite step sizes', () => {
  expect(SHARED_TYPE.display).toMatchObject({ sizePx: 16, family: 'ui', uppercase: true })
  expect(SHARED_TYPE.title).toMatchObject({ sizePx: 11, family: 'mono', uppercase: true })
  expect(SHARED_TYPE.value).toMatchObject({ sizePx: 11, family: 'mono', uppercase: false })
  // Mono dominates: title/label/value are mono; only display + caption are UI.
  const monoSteps = Object.values(SHARED_TYPE).filter((s) => s.family === 'mono')
  expect(monoSteps.length).toBe(3)
})

test('DEFAULT_TOKENS is the sharp instrument default', () => {
  expect(DEFAULT_TOKENS.shape).toEqual({ radiusPx: 0, hairlinePx: 1 })
  expect(DEFAULT_TOKENS.polarity).toBe('dark')
  expect(DEFAULT_TOKENS.chrome).toEqual(SHARED_CHROME)
})

test('tokenVars emits the core chrome, shape, motion and type vars', () => {
  const v = tokenVars(DEFAULT_TOKENS)
  expect(v['--bg']).toBe('#141414')
  expect(v['--accent']).toBe('#ef8b9a')
  expect(v['--radius']).toBe('0px')
  expect(v['--radius-sm']).toBe('calc(var(--radius) * 0.5)')
  // Durations ride the motion lever so reduced-motion collapses them.
  expect(v['--dur-fast']).toContain('var(--motion-scale)')
  expect(v['--type-title-family']).toBe('var(--font-mono)')
  expect(v['color-scheme']).toBe('dark')
})

test('Wizard-local accents cover every channel kind plus both lamps', () => {
  const v = tokenVars(DEFAULT_TOKENS)
  for (const k of ['--chan-device', '--chan-app-tap', '--chan-deck', '--chan-virtual', '--chan-bus'])
    expect(v[k]).toMatch(/^#[0-9a-f]{6}$/i)
  expect(v['--rec-lamp']).toBe('#d95c5c')
  expect(v['--feedback-lamp']).toBe('#d9a13f')
})
