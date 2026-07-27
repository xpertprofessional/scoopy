/**
 * THE TYPEFACE CATALOGUE — one list, usable for BOTH roles.
 *
 * It used to be two lists (a mono list and a prose list), and that was a
 * mistake the user hit immediately: the prose face reaches only captions and
 * panel titles, because this app is mono-dominant — labels AND values are mono
 * (DESIGN-SYSTEM §7). So picking Futura for "prose" changed almost nothing on
 * screen, while picking it for "mono" wasn't even offered. You could not
 * actually TEST a typeface.
 *
 * Now there is ONE list, and either role may take any face. If you want Didot
 * everywhere, put Didot on the role that owns the labels.
 *
 * The `mono` flag is a WARNING, not a restriction (see Typeface.mono).
 *
 * Every face here ships with macOS — nothing is vendored, no licence has to be
 * cleared. Each carries a note, because "Optima" tells you nothing and "flared
 * humanist — a serif's elegance without the serifs" tells you everything.
 *
 * ⚠️ A font that is NOT installed falls back SILENTLY: the app looks unchanged
 * and the picker reads as broken. `isAvailable()` labels those instead.
 */

export interface Typeface {
  /** What it is called in the picker. */
  name: string;
  /** The CSS stack, with a category fallback so a missing face still lands nearby. */
  stack: string;
  /** The one thing this face says. Shown as the picker's hint. */
  note: string;
  /**
   * Are the glyphs fixed-width?
   *
   * NOT a restriction — every face here can be used for EITHER role. It is a
   * warning: a proportional face on the labels+values role means the digits are
   * different widths, so a column of numbers JITTERS as it counts. That is a real
   * cost and it is the reason this app is mono-dominant. It is also the user's
   * call, so the picker states the cost rather than removing the option.
   */
  mono: boolean;
}

export const FACES: Typeface[] = [
  // ── Fixed-width ───────────────────────────────────────────────────────────
  {
    name: "SF Mono",
    mono: true,
    stack: '"SF Mono", ui-monospace, Menlo, monospace',
    note: "the system default — neutral, engineered for small sizes",
  },
  {
    name: "Menlo",
    mono: true,
    stack: "Menlo, ui-monospace, monospace",
    note: "wider, rounder counters; the friendliest of the system monos",
  },
  {
    name: "Monaco",
    mono: true,
    stack: "Monaco, ui-monospace, monospace",
    note: "the classic Mac terminal face — quirky, has real character",
  },
  {
    name: "PT Mono",
    mono: true,
    stack: '"PT Mono", ui-monospace, monospace',
    note: "humanist mono — warmer, slightly narrow; reads as a tool, not a terminal",
  },
  {
    name: "Andale Mono",
    mono: true,
    stack: '"Andale Mono", ui-monospace, monospace',
    note: "wide and open, very high legibility; eats horizontal space",
  },
  {
    name: "Courier New",
    mono: true,
    stack: '"Courier New", Courier, monospace',
    note: "typewriter — light, sparse, deliberately un-digital",
  },

  // ── Proportional ──────────────────────────────────────────────────────────
  {
    name: "System",
    mono: false,
    stack: "-apple-system, system-ui, sans-serif",
    note: "SF Pro — invisible by design; the app looks like the OS",
  },
  {
    name: "DIN Alternate",
    mono: false,
    stack: '"DIN Alternate", "Helvetica Neue", sans-serif',
    note: "the engineering face — road signs, meters, instruments. The obvious one here",
  },
  {
    name: "DIN Condensed",
    mono: false,
    stack: '"DIN Condensed", "Avenir Next Condensed", sans-serif',
    note: "the same, compressed — technical and urgent; superb for big numbers",
  },
  {
    name: "Helvetica Neue",
    mono: false,
    stack: '"Helvetica Neue", Helvetica, sans-serif',
    note: "the grotesk — neutral, Swiss, endlessly safe",
  },
  {
    name: "Avenir Next",
    mono: false,
    stack: '"Avenir Next", Avenir, sans-serif',
    note: "geometric humanist — Futura's warmth-corrected descendant; easy to live with",
  },
  {
    name: "Avenir Next Condensed",
    mono: false,
    stack: '"Avenir Next Condensed", "DIN Condensed", sans-serif',
    note: "narrow geometric — fits dense rows without shouting",
  },
  {
    name: "Futura",
    mono: false,
    stack: 'Futura, "Avenir Next", sans-serif',
    note: "geometric — circles and triangles; confident, a little cold, very 1927",
  },
  {
    name: "Gill Sans",
    mono: false,
    stack: '"Gill Sans", "Gill Sans MT", sans-serif',
    note: "humanist — a calligrapher's sans; British, dry, opinionated",
  },
  {
    name: "Optima",
    mono: false,
    stack: 'Optima, "Gill Sans", sans-serif',
    note: "flared humanist — a serif's elegance without the serifs",
  },
  {
    name: "Seravek",
    mono: false,
    stack: 'Seravek, "Avenir Next", sans-serif',
    note: "soft humanist — quiet and warm; the least clinical option here",
  },
  {
    name: "Trebuchet MS",
    mono: false,
    stack: '"Trebuchet MS", "Lucida Grande", sans-serif',
    note: "screen humanist — friendly, slightly quirky; holds up small",
  },
  {
    name: "Arial Rounded MT Bold",
    mono: false,
    stack: '"Arial Rounded MT Bold", "Avenir Next", sans-serif',
    note: "rounded terminals, one weight (bold) — cartoon energy without a novelty face",
  },
  {
    name: "Verdana",
    mono: false,
    stack: "Verdana, Tahoma, sans-serif",
    note: "wide screen sans — maximum legibility, zero elegance",
  },
  {
    name: "Didot",
    mono: false,
    stack: 'Didot, "Bodoni 72", serif',
    note: "didone — hairline serifs, extreme contrast. Fashion-magazine drama",
  },
  {
    name: "Bodoni 72",
    mono: false,
    stack: '"Bodoni 72", Didot, serif',
    note: "the other didone — a touch sturdier; still pure editorial",
  },
  {
    name: "Baskerville",
    mono: false,
    stack: 'Baskerville, "Iowan Old Style", serif',
    note: "transitional serif — classical, calm, literary",
  },
  {
    name: "Charter",
    mono: false,
    stack: "Charter, Georgia, serif",
    note: "screen serif — Matthew Carter; sturdy at small sizes, bookish",
  },
  {
    name: "Iowan Old Style",
    mono: false,
    stack: '"Iowan Old Style", Charter, serif',
    note: "warm old-style serif — a book page, not a screen",
  },
  {
    name: "Rockwell",
    mono: false,
    stack: 'Rockwell, Superclarendon, serif',
    note: "slab — industrial, blunt, mechanical. Reads as machinery",
  },
  {
    name: "Superclarendon",
    mono: false,
    stack: "Superclarendon, Rockwell, serif",
    note: "slab with a wink — sturdier, warmer, a little Western",
  },
  {
    name: "American Typewriter",
    mono: false,
    stack: '"American Typewriter", "Courier New", monospace',
    note: "slab typewriter — not truly fixed-width, but sets numbers with weight",
  },
  {
    name: "Copperplate",
    mono: false,
    stack: 'Copperplate, "Gill Sans", sans-serif',
    note: "engraved caps — a nameplate, not a paragraph. Uppercase only",
  },
  {
    name: "Phosphate",
    mono: false,
    stack: 'Phosphate, "DIN Condensed", sans-serif',
    note: "condensed display — poster-loud; best kept to the display step",
  },
  {
    name: "Impact",
    mono: false,
    stack: 'Impact, "DIN Condensed", sans-serif',
    note: "heavy condensed display — the loudest face here. Titles only",
  },
];

/**
 * PAIRINGS — the fast way to test a direction, because a typeface is judged in
 * company, not alone. Each sets BOTH roles at once; you can still mix freely
 * afterwards.
 *
 * `values` = the role that owns labels and numbers (the app's dominant voice).
 * `prose`  = captions and the display step.
 */
export interface TypePairing {
  name: string;
  values: string;
  prose: string;
  note: string;
}

export const TYPE_PAIRINGS: TypePairing[] = [
  {
    name: "System",
    values: "SF Mono",
    prose: "System",
    note: "today. The app looks like the OS and gets out of the way",
  },
  {
    name: "Instrument",
    values: "SF Mono",
    prose: "DIN Alternate",
    note: "the engineering direction — a meter, a mixing desk, a road sign",
  },
  {
    name: "Console",
    values: "Andale Mono",
    prose: "DIN Condensed",
    note: "everything technical and tight; the most machine-like pairing here",
  },
  {
    name: "Swiss",
    values: "SF Mono",
    prose: "Helvetica Neue",
    note: "grotesk neutrality — the safest, most anonymous choice",
  },
  {
    name: "Bauhaus",
    values: "Monaco",
    prose: "Futura",
    note: "geometric — hard circles against a quirky mono. Cold and confident",
  },
  {
    name: "Studio",
    values: "PT Mono",
    prose: "Seravek",
    note: "humanist throughout — warm, quiet, the least clinical direction",
  },
  {
    name: "Editorial",
    values: "Courier New",
    prose: "Didot",
    note: "typewriter against a didone — a magazine, not a machine. The risk",
  },
  {
    name: "Workshop",
    values: "American Typewriter",
    prose: "Rockwell",
    note: "slab on slab — everything looks stamped. Numbers will jitter",
  },
  {
    name: "Bauhaus (all in)",
    values: "Futura",
    prose: "Futura",
    note: "Futura EVERYWHERE — labels, values, titles. Numbers jitter; the look is total",
  },
  {
    name: "Editorial (all in)",
    values: "Didot",
    prose: "Didot",
    note: "Didot EVERYWHERE. Absurd for a sequencer, gorgeous for a screenshot",
  },
];

/**
 * Can this machine actually render the face?
 *
 * A stack that falls through renders in a fallback and the picker LOOKS broken —
 * you change the font and nothing happens. So the picker says so instead. Checks
 * the first family in the stack, which is the one being chosen; the fallbacks
 * exist precisely so a miss still lands nearby.
 */
export function isAvailable(stack: string): boolean {
  if (typeof document === "undefined" || !document.fonts?.check) return true;
  const first = stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "");
  if (!first) return true;
  // Generic families and the system stack always resolve.
  if (/^(ui-monospace|monospace|sans-serif|serif|system-ui|-apple-system)$/.test(first)) {
    return true;
  }
  try {
    return document.fonts.check(`12px "${first}"`);
  } catch {
    return true; // never let a probe failure hide an option
  }
}

export const faceByName = (name: string): Typeface | undefined =>
  FACES.find((f) => f.name === name);

/** The face a stack came from, so the picker can show what is currently set. */
export const nameForStack = (stack: string): string =>
  FACES.find((f) => f.stack === stack)?.name ?? "Custom";
