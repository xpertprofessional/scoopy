import { expect, test } from 'vitest'
import {
  FONT_MONO,
  FONT_UI,
  SHARED_CHROME,
  SHARED_MOTION,
  SHARED_SHAPE,
  SHARED_TYPE,
} from './tokens.core'

/**
 * Portability fixture. These assertions PIN the suite identity byte-for-byte;
 * this file is vendored into every app so each one's CI fails the moment its
 * copy of the shared identity drifts from any sibling. Changing a value here is
 * a cross-app product decision, never a local preference.
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

test('shared shape is the sharp instrument default', () => {
  expect(SHARED_SHAPE).toEqual({ radiusPx: 0, hairlinePx: 1 })
})

test('shared base motion is the suite tempo + ease', () => {
  expect(SHARED_MOTION).toEqual({ fastMs: 90, baseMs: 120, ease: 'cubic-bezier(0.2, 0, 0.2, 1)' })
})

test('shared font stacks are mono-dominant SF Mono over system UI', () => {
  expect(FONT_MONO).toBe('"SF Mono", ui-monospace, Menlo, monospace')
  expect(FONT_UI).toBe('-apple-system, system-ui, sans-serif')
})
