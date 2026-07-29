/**
 * P3-C1 — the compose window's address must SURVIVE THE SANITIZER.
 *
 * `MergedMain.cpp` injects `__slPanelArg` through `retainCharacters(A–Za–z0–9_-)`;
 * any character outside that set is silently EATEN, and a half-eaten address
 * decodes to the wrong deck or not at all. So the codec's central property is
 * not round-tripping — it is that every encoded byte is already in the
 * retained set (unpadded base64url, no `=` to lose).
 */
import { describe, expect, it } from 'vitest'
import { decodeComposeArg, encodeComposeArg } from './composeArg.ts'

const SANITIZER = /^[A-Za-z0-9_-]*$/

describe('composeArg', () => {
  it('round-trips, including the "Untitled 2" name class', () => {
    const arg = { deck: 2, session: 'Untitled 2' }
    expect(decodeComposeArg(encodeComposeArg(arg))).toEqual(arg)
  })

  it('round-trips unicode session names through UTF-8', () => {
    const arg = { deck: 0, session: 'Straße · 夜景 🌃' }
    expect(decodeComposeArg(encodeComposeArg(arg))).toEqual(arg)
  })

  it('every encoded address survives the shell sanitizer verbatim', () => {
    // Names chosen to force '+', '/' and '=' in naive base64.
    const names = ['a', 'ab', 'abc', '>>>???', '~~~', 'Untitled 2', '夜', 'x'.repeat(97)]
    for (const session of names) {
      for (const deck of [0, 1, 2]) {
        const enc = encodeComposeArg({ deck, session })
        expect(enc).toMatch(SANITIZER)
        expect(decodeComposeArg(enc)).toEqual({ deck, session })
      }
    }
  })

  it('refuses garbage rather than guessing a deck', () => {
    expect(decodeComposeArg(undefined)).toBeNull()
    expect(decodeComposeArg('')).toBeNull()
    expect(decodeComposeArg('not-base64-json')).toBeNull()
    // Well-formed base64url of the WRONG shape.
    expect(decodeComposeArg(encodeComposeArg({ deck: 1, session: 's' }).slice(0, 4))).toBeNull()
  })
})
