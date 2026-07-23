import { expect, test } from 'vitest'
import { DEFAULT_TOKENS, SHARED_CHROME, tokenVars } from './tokens'

/**
 * The suite-identity VALUE pins now live in tokens.core.test.ts (vendored from
 * shared/), which runs in this app's vitest too. What stays here is Wizard's own
 * side of the contract: that DEFAULT_TOKENS actually wears the shared identity,
 * that the emitter produces the expected vars, and that Wizard's local accents
 * are complete. The one tie-assertion below is the belt-and-suspenders local pin
 * — if the vendored core is ever deleted, this still fails loudly on drift.
 */
test('DEFAULT_TOKENS wears the shared identity, sharp instrument default', () => {
  expect(DEFAULT_TOKENS.polarity).toBe('dark')
  expect(DEFAULT_TOKENS.chrome).toEqual(SHARED_CHROME)
  expect(DEFAULT_TOKENS.chrome.bg).toBe('#141414')
  expect(DEFAULT_TOKENS.shape).toEqual({ radiusPx: 0, hairlinePx: 1 })
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
