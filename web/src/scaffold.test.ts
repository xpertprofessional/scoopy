import { expect, test } from 'vitest'

// Smoke: proves the vitest toolchain runs before any real module exists. This
// file is replaced by real protocol/engine tests as P0 progresses; it exists so
// `npm test` is green from the scaffold commit (an empty suite is an error).
test('toolchain runs', () => {
  expect(1 + 1).toBe(2)
})
