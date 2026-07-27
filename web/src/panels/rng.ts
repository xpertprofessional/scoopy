/**
 * Tiny seedable PRNG for pattern generation (RND-1).
 *
 * The pattern reducers (`applyRandomizePattern`) take an INJECTED `() => number`
 * rather than calling `Math.random()` themselves, so they stay pure and their
 * output is byte-reproducible in a unit test (feed a fixed seed → assert the
 * exact pattern). At runtime GridPanel seeds a fresh stream per click from
 * `Math.random()`, so every RND press is a new roll.
 *
 * `mulberry32` is the standard 32-bit generator: one multiply/xorshift chain,
 * period 2^32, good enough distribution for placing drum hits and picking scale
 * degrees. Not cryptographic — deliberately.
 */

/** A stateful uniform generator in [0, 1). Seed is coerced to uint32. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh uint32 seed from `Math.random()` — the runtime "new roll" source. */
export function randomSeed(): number {
  return (Math.random() * 0x1_0000_0000) >>> 0;
}
