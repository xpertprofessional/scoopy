import { faceByName } from "./typefaces.ts";
import { DEFAULT_SPECTRUM } from "./waveformStyle.ts";
import { DEFAULT_TOKENS, type DesignTokens } from "./tokens.ts";

/**
 * LOOKS — complete, named token sets you can switch between in one click.
 *
 * The point is not six themes. The point is that the token system is now
 * complete enough that six genuinely different identities can be expressed as
 * DATA, with no component, no stylesheet and no canvas call changed between
 * them. If a look below needed a code change, the token system would still have
 * a hole in it — so these six double as the system's own test.
 *
 * They deliberately span the axes: corners (0 → 7), polarity (dark → light),
 * material (void → grain), optics (occlude → screen), motion (0 → 1.3),
 * line weight (hairline → ink outline), colour (measurement → none at all).
 */

/** A look, and the one-line reason it exists. */
export interface Look {
  name: string;
  blurb: string;
  tokens: DesignTokens;
}

const D = DEFAULT_TOKENS;

/** A look's typography, by catalogue NAME — so a look can never name a face that
    doesn't exist (typefaces.test.ts pins it) and the picker opens on the right
    entry rather than "Custom". */
const face = (values: string, prose: string) => ({
  fontMono: faceByName(values)!.stack,
  fontUI: faceByName(prose)!.stack,
});

/**
 * INSTRUMENT — the house look, and the app's actual identity.
 *
 * Near-black, true-neutral, hairline-ruled, sharp-cornered, flat. The discipline
 * that makes it a position rather than a default: THE CHROME CARRIES NO COLOUR
 * AT ALL. Every colour on screen is a measurement — the waveform's spectrum, a
 * send's identity, the playhead's signal green. Most DAWs colour their chrome and
 * then have to fight it for the eye's attention; refusing to is the whole idea.
 */
const INSTRUMENT: DesignTokens = D;

/**
 * SOFTBOX — the same app, rounded and lifted.
 *
 * This is the "soft corners on all items" test as one preset click, and it is
 * the honest counter-argument to INSTRUMENT: some people read a rounded, shadowed
 * UI as calmer and less clinical. One number does the corners (radiusPx), one
 * does the depth (ambientAlpha), one does the liveliness (motion.scale). The
 * greys lift slightly so the shadows have something to fall on.
 */
const SOFTBOX: DesignTokens = {
  ...D,
  // Studio: humanist throughout. A rounded, shadowed UI set in a clinical face
  // would be arguing with itself.
  ...face("PT Mono", "Seravek"),
  type: { ...D.type, display: { ...D.type.display, weight: 400, trackingEm: 0.06 } },
  seeds: { enabled: true, ground: "#181818", ink: "#dcdcdc", accent: "#ef8b9a" },
  shape: { radiusPx: 6, hairlinePx: 1 },
  elevation: { ambientAlpha: 0.5 },
  motion: { ...D.motion, scale: 1.3 },
};

/**
 * BENCH — the light one, and the aesthetic risk.
 *
 * A cool lab-bench grey with graphite ink: a Braun instrument face, a scope
 * bezel, a bench meter. Deliberately NOT the warm cream + serif + terracotta that
 * every light UI defaults to — this is a machine you work at, not a magazine you
 * read.
 *
 * It is also the proof that LOOK-2 worked. Every value here that ISN'T a colour
 * is the thing that makes light possible at all:
 *   · polarity      → `color-scheme: light`, so native scrollbars follow.
 *   · chromeInk 0.7 → ink on paper reads heavier than light on black at the same
 *                     alpha, so the whole quiet field steps back together.
 *   · spectrum      → the default ramp's cyan mid (#18ffd5) is near-invisible on
 *                     a light ground. The measurement is the same; the ink that
 *                     draws it has to be darker to stay true.
 */
const BENCH: DesignTokens = {
  ...D,
  // The engineering face, on the engineering ground. DIN is what a meter, a road
  // sign and a mixing desk are already set in — this is the pairing the whole
  // look is arguing for.
  ...face("SF Mono", "DIN Alternate"),
  polarity: "light",
  // Accent: the same brand pink as everywhere, deepened for paper (a pastel
  // ring vanishes on a light ground the way cyan does).
  seeds: { enabled: true, ground: "#e6e8ea", ink: "#1b1e21", accent: "#c94f66" },
  chrome: {
    ...D.chrome,
    // State colours are NOT derived from the ground (see deriveChrome) — they
    // are re-tuned by hand, because "clipping" has to shout on any ground.
    signal: "#1f7a4d",
    warn: "#a8701a",
    hot: "#b83227",
  },
  shape: { radiusPx: 2, hairlinePx: 1 },
  elevation: { ambientAlpha: 0.16 },
  surface: { ...D.surface, chromeInk: 0.7, cellTintAlpha: 0.14 },
  waveform: {
    ...D.waveform,
    spectrum: { low: "#2438c8", mid: "#0f8f7a", high: "#a8248a" },
  },
  semantic: {
    ...D.semantic,
    // The dark palette's tints wash out on paper: same hues, more saturation.
    send: ["#1f7fb5", "#3560c0", "#5a4fbe", "#8446ad"],
    mod: ["#b57616", "#b8531f", "#b23348", "#a83381"],
    deck: ["#1f9a58", "#b08c14", "#a13fa8"],
    muteGroup: "#3f8f88",
  },
};

/**
 * PHOSPHOR — the oscilloscope.
 *
 * The only look that changes the OPTICS rather than the palette: `screen` blend
 * makes two signals sharing a cell ADD light, the way they do on a scope and the
 * way they do in the audio. Grain gives the ground tooth so the black is a
 * surface rather than a hole. And the accent is lifted straight out of the
 * spectrum's mid — the one place in the app where chrome is allowed to borrow a
 * colour from the signal, because here that IS the thesis.
 *
 * It also ships with `colorMode: "spectrum"` on, since a look about light should
 * open with the waveform already carrying its timbre.
 */
const PHOSPHOR: DesignTokens = {
  ...D,
  // Console: everything technical and tight. Condensed display, wide mono — a
  // machine talking to itself.
  ...face("Andale Mono", "DIN Condensed"),
  type: { ...D.type, display: { ...D.type.display, sizePx: 20, trackingEm: 0.18 } },
  seeds: { enabled: true, ground: "#0b0d0c", ink: "#cfe6df", accent: DEFAULT_SPECTRUM.mid },
  chrome: { ...D.chrome, signal: DEFAULT_SPECTRUM.mid },
  shape: { radiusPx: 0, hairlinePx: 1 },
  elevation: { ambientAlpha: 0 },
  surface: { ...D.surface, grainAlpha: 0.07, chromeInk: 0.9 },
  waveform: { ...D.waveform, colorMode: "spectrum", blend: "screen" },
};

/**
 * SCOOPY — the mascot's look.
 *
 * The app icon is a cel-animation rat: bold ink outlines, rounded shapes, flat
 * fills. This look translates that language STRUCTURALLY, never through a
 * novelty font — the 2px hairline IS the ink line, the 7px radius IS the cel
 * curve, the accent IS the rat's pink. Arial Rounded MT Bold has the rounded
 * terminals of a cartoon with the discipline of a grotesk; Monaco is the mono
 * with the most character in the catalogue. The ground warms a few degrees so
 * the pink has somewhere to live, but it stays near-black: this is still a
 * performance instrument, not a comic page.
 */
const SCOOPY: DesignTokens = {
  ...D,
  ...face("Monaco", "Arial Rounded MT Bold"),
  // One weight is all the face has — own it. Tracking eases because rounded
  // bold caps set wide already.
  type: { ...D.type, display: { ...D.type.display, weight: 700, trackingEm: 0.08 } },
  seeds: { enabled: true, ground: "#1a1517", ink: "#e8ddd8", accent: "#ef8b9a" },
  // Record-red leans toward the icon's nose; still shouts on the warm ground.
  chrome: { ...D.chrome, hot: "#d9536b" },
  shape: { radiusPx: 7, hairlinePx: 2 },
  elevation: { ambientAlpha: 0.55 }, // sticker lift
  motion: { ...D.motion, scale: 1.15 },
};

/**
 * DOCUMENT — the app as an unstyled page.
 *
 * The origin is a real experiment (2026-07-23): we disabled every stylesheet in
 * the companion to see what ScoopyLoops would be as raw HTML. The grid survived
 * — it is canvas, and canvas reads these tokens, not CSS — but the layout did
 * not, which is the whole finding. You cannot get the plain-document LOOK by
 * removing CSS, because CSS is what arranges the panels. You get it by moving
 * every token to where an unstyled browser already sits.
 *
 * So this look is the honest version of that idea: white ground, black text,
 * grey button faces, browser blue, a serif for prose and a typewriter for
 * values. Nothing is animated, nothing is lifted, nothing is tinted.
 *
 * The four decisions worth arguing with, each one line to undo in Appearance:
 *   · accent    → native browser blue, NOT the house pink (DS-02). A document's
 *                 only colour is its link colour; a pink ring would be the one
 *                 styled thing on an unstyled page. Flip it back and the look
 *                 still holds.
 *   · semantic  → OFF. Every tint resolves to pure chrome (see tokenVars), so
 *                 sends, mods and decks stop colour-coding. That is what "raw
 *                 data" means, and it IS a real information channel switched
 *                 off — the reason it is a look and not the default.
 *   · lines     → almost gone. `line` sits 7% off the ground, so rules read as
 *                 the faintest possible seam rather than structure. What
 *                 separates a button from the page is its grey FACE, exactly as
 *                 in a browser's default form controls.
 *   · cellTint  → UP (0.12 → 0.18). Consequence of the line above: with the
 *                 rules gone, a step cell's fill is the only thing left holding
 *                 the grid together, so it has to carry more.
 *
 * Track colours are deliberately LEFT ALONE. A true raw page has one ink, and
 * `trackColor.universalEnabled` would give it one — but row identity is how you
 * read a grid, and the brief was explicitly that the cells still have to work.
 */
const DOCUMENT: DesignTokens = {
  ...D,
  // Courier for values, Baskerville for prose: the two faces a browser reaches
  // for when nobody has told it anything. ⚠️ Courier New is a LIGHT mono at
  // 10–11px — it is the faithful choice, not the legible one, and the picker is
  // right there if it reads too thin on your panel.
  ...face("Courier New", "Baskerville"),
  // An unstyled <h1> is large, bold, mixed-case and set in the prose face — not
  // a tracked-out label. The title step follows it down for the same reason:
  // "Untitled" is a document's heading, "UNTITLED" is an instrument's.
  type: {
    ...D.type,
    display: { sizePx: 20, weight: 700, trackingEm: 0, family: "ui", uppercase: false },
    title: { ...D.type.title, family: "ui", trackingEm: 0, uppercase: false },
  },
  polarity: "light",
  // Derive mode OFF: the nine swatches are set by hand here, because the ONE
  // value this look turns on its head — `line`, pulled to within a whisker of
  // the ground — is precisely the one deriveChrome computes for you. The seeds
  // are still filled in so flipping derive on in the panel lands somewhere sane
  // rather than back on the dark palette.
  seeds: { enabled: false, ground: "#ffffff", ink: "#111111", accent: "#0b57d0" },
  chrome: {
    bg: "#ffffff",
    bgRaised: "#f1f1f1", // the native button face, and the only edge there is
    line: "#e4e4e4",
    text: "#111111",
    textDim: "#666666",
    accent: "#0b57d0",
    // Re-tuned for paper, as BENCH established: state colours are never derived,
    // because clipping has to shout on any ground.
    signal: "#1f7a4d",
    warn: "#a8701a",
    hot: "#b83227",
  },
  shape: { radiusPx: 3, hairlinePx: 1 },
  // Flat page — but NOT zero. A menu is not part of the document, and a white
  // menu with no shadow over white content, with the rules this quiet, has
  // nothing left to detach it. This is the minimum that keeps floating surfaces
  // from dissolving into the page.
  elevation: { ambientAlpha: 0.12 },
  // Ink on paper reads heavier than light on black at the same alpha (BENCH),
  // and the cell tint carries the grid now that the rules don't.
  surface: { ...D.surface, chromeInk: 0.7, cellTintAlpha: 0.18 },
  // A document doesn't move.
  motion: { ...D.motion, scale: 0 },
  // Every colour-mix in semantic.css resolves to pure chrome at 0 strength.
  semantic: { ...D.semantic, enabled: false },
  waveform: {
    ...D.waveform,
    // Same measurement, ink that survives white. The default ramp's cyan mid is
    // invisible here, and its low end is a blue bright enough to read as chrome.
    spectrum: { low: "#1731a8", mid: "#0f7b6c", high: "#8f2f86" },
  },
};

export const SHIPPED_LOOKS: Look[] = [
  {
    name: "INSTRUMENT",
    blurb: "The house look. Sharp, flat, true-neutral — every colour on screen is a measurement.",
    tokens: INSTRUMENT,
  },
  {
    name: "SOFTBOX",
    blurb: "Soft corners on everything, lifted greys, drop shadows, livelier motion.",
    tokens: SOFTBOX,
  },
  {
    name: "BENCH",
    blurb: "Light. A cool lab-bench grey with graphite ink — an instrument face, not a magazine.",
    tokens: BENCH,
  },
  {
    name: "PHOSPHOR",
    blurb: "The oscilloscope. Overlapping signals add light; the ground has grain.",
    tokens: PHOSPHOR,
  },
  {
    name: "SCOOPY",
    blurb: "The mascot's look. Ink-outline chrome, cel curves, the rat's pink — structure, not a novelty font.",
    tokens: SCOOPY,
  },
  {
    name: "DOCUMENT",
    blurb: "The app as an unstyled page. White, black, browser blue — no rules, no tints, no motion.",
    tokens: DOCUMENT,
  },
];

export const DEFAULT_LOOK = "INSTRUMENT";

export function lookByName(name: string): Look | undefined {
  return SHIPPED_LOOKS.find((l) => l.name === name);
}
