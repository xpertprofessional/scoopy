import type { EngineLink } from "../engineLink.ts";
import {
  DEFAULT_WAVEFORM,
  normalizeWaveform,
  type WaveformStyle,
} from "./waveformStyle.ts";
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
} from "./tokens.core.ts";

// The neutral-grey chrome, mono-dominant type scale, shape and base motion are
// the shared suite identity — vendored byte-identical from shared/design (see
// shared/README.md), pinned by tokens.core.test.ts. Re-exported so existing
// importers keep resolving these from "./tokens". Everything below is scoopy's
// own composition and vocabulary (semantic colors, looks, controls, …).
export type { ChromeColors, ShapeTokens, TypeStep };

/**
 * Design tokens — THE single source of truth for every color, font, size
 * and control dimension in the web UI (docs/migration/DESIGN-SYSTEM.md).
 * Nothing outside web/src/design/ may hardcode a color or font; the
 * check:tokens gate enforces it.
 *
 * Identity seeds (2026-07-10, DESIGN-SYSTEM.md §7): mono-dominant type,
 * true-neutral greys, placeholder neutral accent (user picks the real one
 * in the DS-02 token editor), row layout B.
 */

/**
 * Semantic (assignment) colors — the THIRD color category, next to chrome and
 * session data (DESIGN-SYSTEM.md §2b). Chrome says *what kind of thing* this is;
 * a semantic color says *which one of a numbered set* it belongs to, so that two
 * controls far apart on screen read as connected: send 3 and mixer return FX3,
 * an M2 sweep band and the M2 lane, a deck's transport block and its mixer
 * output box.
 *
 * Hue assignment is ZONED (user, 2026-07-13): sends own a cool arc, mods own a
 * warm arc. The two families share a track row, so they are made disjoint by
 * construction — a cool tint is ALWAYS a send, a warm tint is ALWAYS a
 * modulator. Within a family, neighbours are ~35° apart and the S1..S4 / M1..M4
 * labels carry the rest.
 */
export interface SemanticColors {
  /** Master switch. Off → every family falls back to the chrome color it used
      BEFORE this system existed, so the app looks exactly as it did. */
  enabled: boolean;
  /** How hard an identity color tints neutral chrome, 0–100. The color is a code
      to scan, not paint: the default is deliberately low so the neutral-grey
      identity survives. Canvas *objects* (a mod shape) ignore it — strength
      governs TINTS on chrome, not the color of a thing that IS its channel. */
  strengthPct: number;
  /** Send 1–4 ↔ mixer FX return 1–4. Cool arc. */
  send: string[];
  /** Mod channel M1–M4: lane, arm ring, `M<n>·<TGT>` slot, sweep band. Warm arc. */
  mod: string[];
  /** Deck A/B/C: transport block, mixer strip + output box, DJ badge, session
      load buttons. Bold anchors 120° apart — big surfaces only. */
  deck: string[];
  /** The mute group (one per deck): the MUTE latch ↔ its member tracks' M buttons. */
  muteGroup: string;
}

/**
 * The chrome micro-interactions, each independently switchable in Appearance.
 *
 * TWO WERE CUT, and the reasons are the design:
 *
 * `valueSettle` (ease a DragBox's fill when the value changes by keyboard) —
 *   IMPOSSIBLE without breaking a drag. The slider fill is an inline
 *   linear-gradient whose STOP is the value (controls.tsx GeoRange). CSS cannot
 *   distinguish a keyboard change from a pointer drag, so transitioning it would
 *   make every drag lag behind the pointer. A laggy drag is a broken instrument.
 *
 * `focusTravel` (slide the ring between adjacent controls) — IMPOSSIBLE to make
 *   COHERENT. A travelling ring needs one shared element, but the ö/ä cursor
 *   world deliberately crosses the canvas↔DOM boundary (arrows roam grid cells
 *   ⇄ the control band). The ring would glide between drag boxes and teleport
 *   into the grid — worse than always teleporting. Focus also wants to be
 *   instant: it is the answer to "where am I", and an answer should not arrive
 *   late.
 */
export type MotionTrick = "menuEntry" | "hoverLift" | "latchSweep" | "panelEntry";

/**
 * Motion. `scale` is the master lever and works exactly like `semantic.strengthPct`:
 * every duration is emitted as `calc(<n>ms * var(--motion-scale))`, so setting it
 * to 0 collapses the whole app to instant WITHOUT a single rule branching on it —
 * and `prefers-reduced-motion` can therefore be honoured in one line at :root
 * instead of a per-keyframe override.
 *
 * Hard rules (user, 2026-07-13 — "reliable at all times, soft touch"):
 * nothing on the audio path animates, nothing animates during a drag, and
 * dismissal is always instant.
 */
export interface MotionTokens extends MotionBase {
  /** 0 = off · 1 = crisp (default) · 2 = full. Governs the CHROME tricks only. */
  scale: number;
  /**
   * Period of the transport STATE pulses (armed quantized launch, scheduled
   * scene). Deliberately NOT multiplied by `scale`.
   *
   * These are readouts, not decoration: the launch pulse means "the engine is
   * holding, not yet" and a static mark would read as a settled state. Killing
   * them with the motion lever would be the same category error as freezing the
   * playhead because a user asked for less animation. `prefers-reduced-motion`
   * is what silences them — and it swaps in a static mark rather than removing
   * the information (grid.css, scenes.css).
   */
  pulseMs: number;
  easeOut: string;
  tricks: Record<MotionTrick, boolean>;
}

/** Ambient depth. 0 = flat: --elev-1/-2 resolve to `none` and the app refuses to
    pretend it is physical. */
export interface ElevationTokens {
  ambientAlpha: number;
}

/**
 * Canvas surface tokens.
 *
 * Canvas cannot resolve CSS vars, so every alpha it draws with used to be a
 * magic number sitting in GridPanel.tsx — which is precisely why a light look
 * was not a re-skin but a rewrite. These reach canvas through `currentTokens()`,
 * the same route `trackDisplayColor()` and `semanticColor()` already take.
 *
 * WHAT IS *NOT* HERE, DELIBERATELY: the ~14 individual alphas of the grid's
 * quiet field (group shading 0.03, gridlines 0.35, the bar rule 0.7, step
 * numbers 0.6, the hover ghosts 0.12/0.15/0.2 …). Their RATIOS are design, not
 * theme — a 2px flam dot needs more alpha than a full-width band to read as
 * equally present, and letting a look re-weight that would let a look break the
 * grid's legibility. They live as named constants in GridPanel (`FIELD`), and
 * the theme scales all of them together with `chromeInk`. The theme sets the
 * LEVEL; the code keeps the balance.
 */
export interface SurfaceTokens {
  /**
   * How present the grid's chrome is — one multiplier over the whole quiet
   * field. This is the knob a light ground actually needs: ink on paper reads
   * heavier than light on black at the same alpha, so BENCH turns it down.
   */
  chromeInk: number;
  /** The cell's whisper track-colour tint (the ground; the waveform is the figure). */
  cellTintAlpha: number;
  /** A wrap continuation is the same audio, quieter — it did not start here. */
  wrapTintAlpha: number;
  /** An OWN voice still ringing past its cell's end — same data, low presence. */
  ghostTailAlpha: number;
  /** The live playhead. */
  playheadAlpha: number;
  /** Selection tint. */
  selectionAlpha: number;
  /**
   * Static noise over the app ground, 0–0.04. Kills the banding a near-black
   * ground gets on an 8-bit panel and gives the surface tooth — a material
   * rather than a void. Never animates; costs one composited layer.
   */
  grainAlpha: number;
}

/**
 * Which way the ground goes. Drives the derive-mode mix direction (LOOK-3) and
 * `color-scheme` on :root — without the latter a light look ships with dark
 * native scrollbars, which is exactly the kind of leak that makes a re-skin
 * "break" even when every token is right.
 */
export type Polarity = "dark" | "light";

/**
 * Derive-mode colour seeds.
 *
 * The nine chrome colours are nine independent hex values, which makes trying a
 * new palette nine careful edits — and nine chances to break the contrast
 * relationships that hold the UI together. In derive mode you set THREE, and the
 * greys between them are computed.
 *
 * The ratios below reproduce today's palette almost exactly from
 * ground #141414 + ink #d8d8d8, which is the point: this is not a new look, it
 * is the existing look expressed as what it always was — a ground, an ink, and
 * fixed steps between them.
 *
 * The derivation is polarity-free BY CONSTRUCTION: every step mixes the ground
 * TOWARD the ink, so "raised" is lighter on a dark ground and darker on a light
 * one without a single branch. That is what makes a light look a re-skin rather
 * than a rewrite.
 */
export interface ColorSeeds {
  enabled: boolean;
  /** The app background. */
  ground: string;
  /** Primary text. Everything between ground and ink is a mix of the two. */
  ink: string;
  /** Selection, focus, active. */
  accent: string;
}

/** Distance from the ground toward the ink, per role. Tuned to reproduce the
    established greys (#1e1e1e / #2e2e2e / #7f7f7f) from #141414 → #d8d8d8. */
const SEED_STEPS = { raised: 0.055, line: 0.133, textDim: 0.454 } as const;

const hex2rgb = (h: string): [number, number, number] => {
  const s = h.replace("#", "");
  const n =
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  return [
    parseInt(n.slice(0, 2), 16),
    parseInt(n.slice(2, 4), 16),
    parseInt(n.slice(4, 6), 16),
  ];
};

const rgb2hex = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("");

/** Linear sRGB mix, `t` of the way from `a` to `b`. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex2rgb(a);
  const [br, bg, bb] = hex2rgb(b);
  return rgb2hex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/**
 * Seeds → the five greys. `signal`/`warn`/`hot` are NOT derived: they are state
 * colours (live / clipping / recording), not palette. A look may retune them,
 * but they must never be a by-product of picking a background.
 */
export function deriveChrome(seeds: ColorSeeds, base: ChromeColors): ChromeColors {
  if (!seeds.enabled) return base;
  return {
    ...base,
    bg: seeds.ground,
    bgRaised: mixHex(seeds.ground, seeds.ink, SEED_STEPS.raised),
    line: mixHex(seeds.ground, seeds.ink, SEED_STEPS.line),
    text: seeds.ink,
    textDim: mixHex(seeds.ink, seeds.ground, SEED_STEPS.textDim),
    accent: seeds.accent,
  };
}

export interface DesignTokens {
  polarity: Polarity;
  /** Optional 3-seed derivation of the greys. Off → the 9 swatches are manual. */
  seeds: ColorSeeds;
  chrome: ChromeColors;
  shape: ShapeTokens;
  motion: MotionTokens;
  elevation: ElevationTokens;
  surface: SurfaceTokens;
  /** Identity colors for numbered assignments (sends, mods, decks, mute group). */
  semantic: SemanticColors;
  /** Palette that session data colors (tracks) draw from. */
  dataPalette: string[];
  /** Appearance-test override: when enabled, EVERY track renders `universalHex`
      instead of its session color (one universal color toggle). */
  trackColor: { universalEnabled: boolean; universalHex: string };
  fontMono: string;
  fontUI: string;
  /**
   * `display` is the app's ONE typographic voice — panel titles, and nothing
   * else. Every other step is 10–11px, which is a size at which no typeface says
   * anything: you cannot judge Futura against Didot at 11px, so a font picker
   * without a display step is a font picker you cannot use.
   *
   * One accessory, worn once (DESIGN-SYSTEM §7).
   */
  type: {
    display: TypeStep;
    title: TypeStep;
    label: TypeStep;
    value: TypeStep;
    caption: TypeStep;
  };
  control: {
    /** `barHeightPx` is THE control height: sliders, drag boxes, buttons,
        selects and steppers all render at it (see --control-h). Never give a
        control its own height token — that is what let boxes and sliders
        drift apart when "Bar height" was changed. */
    slider: { barHeightPx: number; fillMixPct: number; markerWidthPx: number };
    dragBox: {
      dragSensitivity: number;
      fineStepMultiplier: number;
      doubleClickReset: boolean; // boxes only — sliders NEVER
    };
    focus: { ringWidthPx: number };
    density: { cellPx: number; rowHeightPx: number };
  };
  /** Background image style. RENDERED NATIVELY (the window layer behind the
      transparent webviews paints ground + image×opacity); these tokens are the
      web-side controls, mirrored to Swift via the setBackgroundStyle command.
      The page never applies imageOpacity itself — that would veil twice. */
  background: {
    imageOpacity: number;
    imageMode: "fill" | "fit" | "stretch" | "tile" | "tileMirror";
    /** How a tiled background sizes each tile (tile modes only). "scale" = a
        percent of the image's natural size; "count" = N copies span the window
        width (the "repeat the image N times across" control). */
    tileSizing: "scale" | "count";
    /** Tile size, percent of the image's natural size ("scale" sizing). */
    tileScalePct: number;
    /** How many copies span the window width ("count" sizing). */
    tileCountPerRow: number;
    /** Compositor-only ambient motion on the image layer; disabled under
        reduced motion. */
    motion: "none" | "drift" | "breathe";
    /** Bass shake: the native layer nudges with the low band (≤~120 Hz) of the
        master output. Off by default; a meter-driven transform, never DSP. */
    shakeEnabled: boolean;
    shakeIntensityPct: number;
  };
  /** How every waveform surface DRAWS the true peak data (waveformStyle.ts). */
  waveform: WaveformStyle;
}

export const DEFAULT_TOKENS: DesignTokens = {
  polarity: "dark",
  seeds: { enabled: false, ground: "#141414", ink: "#d8d8d8", accent: "#ef8b9a" },
  // The neutral-grey chrome is the shared suite identity (accent = the app
  // icon's pink, softened to a selection voice — DS-02, 2026-07-14).
  chrome: { ...SHARED_CHROME },
  // Sharp + hairline: the INSTRUMENT default. The SOFTBOX look raises radiusPx.
  shape: { ...SHARED_SHAPE },
  motion: {
    scale: 1, // crisp
    ...SHARED_MOTION, // fastMs 90, baseMs 120, ease — the shared tempo
    pulseMs: 600, // the launch-pending period, as it has always been
    easeOut: "cubic-bezier(0.2, 0, 0, 1)",
    tricks: { menuEntry: true, hoverLift: true, latchSweep: true, panelEntry: true },
  },
  elevation: { ambientAlpha: 0.45 }, // matches the shadow the menus already wore
  // Every value here is the one the grid has always drawn with — this group is a
  // no-op hoist, not a restyle. What changes is that a look can now reach them.
  surface: {
    chromeInk: 1,
    cellTintAlpha: 0.12,
    wrapTintAlpha: 0.08,
    ghostTailAlpha: 0.4,
    playheadAlpha: 0.25,
    selectionAlpha: 0.18,
    grainAlpha: 0, // INSTRUMENT is a void; PHOSPHOR gives it tooth
  },
  semantic: {
    enabled: true,
    strengthPct: 30,
    // SEM-NORM (2026-07-14): same zoned hues as confirmed 2026-07-13, re-tuned
    // to EQUAL perceptual weight per family (OKLCH, constant L and C), so S2
    // never shouts over S4. Mods sit a step deeper than the accent (L0.71 vs
    // 0.75) — a selection ring and an M3 tint stay two different pinks.
    // Cool arc — blue-cyan → violet. L0.70 C0.125.
    send: ["#3caae0", "#729eec", "#9792e9", "#b588d9"],
    // Warm arc — gold → rose. Disjoint from `send` by construction. L0.71 C0.135.
    mod: ["#d0952a", "#e48650", "#e97c84", "#dd7db3"],
    // Bold anchors, 120° apart — tightened (ΔL halved), not flattened: yellow
    // needs more L than magenta to carry the same weight (Helmholtz–Kohlrausch).
    deck: ["#53c980", "#e2b93a", "#ce78d5"],
    muteGroup: "#65b5ad",
  },
  dataPalette: [
    "#d95c5c", "#d9a13f", "#c9c95a", "#57c07a",
    "#5ab6c9", "#6f8fd9", "#a97fd9", "#d97fb1",
  ],
  trackColor: { universalEnabled: false, universalHex: "#bfbfbf" },
  fontMono: FONT_MONO,
  fontUI: FONT_UI,
  type: {
    display: { ...SHARED_TYPE.display },
    title: { ...SHARED_TYPE.title },
    label: { ...SHARED_TYPE.label },
    value: { ...SHARED_TYPE.value },
    caption: { ...SHARED_TYPE.caption },
  },
  control: {
    slider: { barHeightPx: 18, fillMixPct: 55, markerWidthPx: 2 },
    dragBox: {
      dragSensitivity: 1.0,
      fineStepMultiplier: 0.1,
      doubleClickReset: true,
    },
    focus: { ringWidthPx: 2 },
    density: { cellPx: 4, rowHeightPx: 26 },
  },
  background: {
    imageOpacity: 1.0,
    imageMode: "fill",
    tileSizing: "scale",
    tileScalePct: 100,
    tileCountPerRow: 4,
    motion: "none",
    shakeEnabled: false,
    shakeIntensityPct: 50,
  },
  waveform: DEFAULT_WAVEFORM,
};

const THEME_KEY = "theme.tokens";

/**
 * The RESOLVED ground, republished as a flat hex string for the native host.
 *
 * Every panel is an OPAQUE webview filling itself with `--bg`, and the window
 * they sit in is painted by AppKit from its own palette. Two grounds and no
 * channel between them is why the panels read as cards laid on a canvas rather
 * than as the app. This is the channel.
 *
 * It cannot be theme.tokens: with `seeds.enabled` the chrome is DERIVED, so the
 * stored `chrome.bg` is not the color on screen. Publishing the resolved value
 * keeps deriveChrome the only deriver — the host never re-implements it.
 */
export const GROUND_KEY = "theme.chrome.ground";

/**
 * Which shipped look is loaded. Deliberately SEPARATE from theme.tokens, which
 * stays the resolved active token set — so every other panel's
 * loadAndApplyTokens is untouched and knows nothing about looks. The switcher is
 * a convenience over the same one theme, not a second source of truth.
 */
export const ACTIVE_LOOK_KEY = "theme.activeLook";

/**
 * User-saved looks: a JSON array of `{ name, tokens }`, sitting beside the
 * shipped four in the Appearance pane's Look picker (TOOL-LOOKS, 2026-07-14).
 * Before this, an experiment only existed as clipboard JSON — close the app
 * and it was gone. Each entry's tokens pass through `mergeTokens` on load, so
 * a look saved before a token group existed lands on the defaults rather than
 * leaving holes.
 */
export const CUSTOM_LOOKS_KEY = "theme.customLooks";

function typeVars(prefix: string, step: TypeStep): Record<string, string> {
  return {
    [`--${prefix}-size`]: `${step.sizePx}px`,
    [`--${prefix}-weight`]: `${step.weight}`,
    [`--${prefix}-tracking`]: `${step.trackingEm}em`,
    [`--${prefix}-family`]: step.family === "mono" ? "var(--font-mono)" : "var(--font-ui)",
    [`--${prefix}-transform`]: step.uppercase ? "uppercase" : "none",
  };
}

/** A trick's duration: its own ms scaled by the master lever, or a hard 0ms when
    the trick is switched off. Never a `none` — an existing 0ms transition is what
    lets the CSS stay branch-free. */
function trickDur(_t: DesignTokens, on: boolean, base: "--dur-fast" | "--dur-base"): string {
  return on ? `var(${base})` : "0ms";
}

/**
 * Depth for a surface at `scale` elevation, or `none` when the look is flat.
 * (A 0-alpha shadow still costs a paint, so flat means flat.)
 *
 * ⚠️ A DROP SHADOW ALONE IS INVISIBLE ON A DARK GROUND. Black-on-near-black is
 * the mistake this function used to make: the Depth slider moved and nothing
 * happened, because #000 at 45% over #141414 is very nearly #141414. Depth on a
 * dark UI is carried by the LIT EDGE, not the shadow — a hairline catching light
 * on the top edge is what says "this is above the surface", exactly as it does on
 * a physical panel.
 *
 * So elevation is two parts: a rim on top, and a shadow below. On a light ground
 * the rim would be wrong (light on light says nothing) and the shadow does the
 * work by itself, so polarity picks which half carries it.
 */
function elevationShadow(t: DesignTokens, y: number, blur: number, scale: number): string {
  const a = t.elevation.ambientAlpha * scale;
  if (a <= 0) return "none";
  const drop = `0 ${y}px ${blur}px rgb(0 0 0 / ${Math.round(a * 100)}%)`;
  if (t.polarity === "light") return drop;
  const rim = Math.round(t.elevation.ambientAlpha * 14); // 0…~7% white
  return `inset 0 1px 0 rgb(255 255 255 / ${rim}%), ${drop}`;
}

let current: DesignTokens = DEFAULT_TOKENS;

/** Live tokens for behavior (drag sensitivity etc.) — CSS vars cover visuals. */
export function currentTokens(): DesignTokens {
  return current;
}

/** The colour a track wears when its settings row carries none (Swift
    `colorHex` is a `String?`). A DATA fallback, not chrome — it must stay a
    fixed neutral so an uncoloured track looks identical on every look. Minted
    here because design/ is the one place allowed to hold a literal. */
export const UNSET_TRACK_HEX = "#888888";

/** Session track color → display color. Canvas surfaces (which can't react to
    CSS vars) resolve every track color through this so the universal-color
    test toggle covers them too. */
export function trackDisplayColor(sessionHex: string): string {
  const tc = current.trackColor;
  return tc.universalEnabled ? tc.universalHex : sessionHex;
}

/** The numbered semantic families. `muteGroup` is a single color, not a family:
    the group is one latched set per deck (schema: `muteGroupMember: boolean`,
    not a group index), so there is exactly one identity to share. */
export type SemanticFamily = "send" | "mod" | "deck";

/**
 * OFF fallback: the chrome color each family used BEFORE the semantic system.
 * Switching semantic colors off therefore restores the app's previous look
 * exactly, rather than flattening everything to one arbitrary neutral.
 */
function semanticFallback(t: DesignTokens, family: SemanticFamily | "muteGroup"): string {
  switch (family) {
    case "mod":
      return t.chrome.signal; // the multi-routing sweep band was already --signal
    case "muteGroup":
      return t.chrome.warn; // member rings were --warn (grid.css)
    default:
      return t.chrome.accent; // sends and decks carried no color at all
  }
}

/**
 * Identity color for one member of a semantic family, resolved against an
 * explicit token set. Pure — the DOM-free half of `semanticColor`, so the
 * fallback behavior can be tested without a document.
 */
export function resolveSemanticColor(
  t: DesignTokens,
  family: SemanticFamily | "muteGroup",
  index = 0,
): string {
  const s = t.semantic;
  if (!s.enabled) return semanticFallback(t, family);
  if (family === "muteGroup") return s.muteGroup;
  return s[family][index] ?? semanticFallback(t, family);
}

/**
 * Identity color for one member of a semantic family — a REAL color string, so
 * canvas surfaces (which cannot resolve CSS vars) can use it directly.
 *
 * Returns the chrome fallback when the system is off, so NO caller branches on
 * `enabled`: a surface always has a color, it just stops being an identity.
 */
export function semanticColor(family: SemanticFamily, index: number): string {
  return resolveSemanticColor(current, family, index);
}

/** The mute group's identity color (see SemanticFamily — the group is a set, not a family). */
export function muteGroupColor(): string {
  return resolveSemanticColor(current, "muteGroup");
}

/**
 * A chrome alpha, scaled by the look's ink level — the canvas route to
 * `surface.chromeInk`, since canvas cannot read CSS vars.
 *
 * ONLY for CHROME: gridlines, group shading, step numbers, hover ghosts,
 * affordance marks. NEVER for SIGNAL — a waveform, a meter, a live playhead.
 * Turning the grid's ink down to read a light ground must not dim the audio;
 * the chrome is the paper, the signal is the ink that matters.
 */
export function inkAlpha(a: number): number {
  return a * current.surface.chromeInk;
}

type TokensListener = (t: DesignTokens) => void;
const tokensListeners = new Set<TokensListener>();

/** Fires after every applyTokens — canvas surfaces subscribe to repaint,
    since CSS-var changes alone don't reach them. */
export function onTokensApplied(cb: TokensListener): () => void {
  tokensListeners.add(cb);
  return () => tokensListeners.delete(cb);
}

/**
 * Every token as a CSS custom property — the pure, DOM-free half of
 * `applyTokens` (same split as `resolveSemanticColor` vs `semanticColor`), so
 * the derivations can be tested without a document. This is the function that
 * decides, e.g., that every role radius derives from one number and that every
 * duration is a calc() against the motion lever; those are the claims worth
 * pinning, and they live here rather than in the DOM write.
 */
export function tokenVars(tIn: DesignTokens): Record<string, string> {
  // Resolve the seeds ONCE, here, and let everything downstream — CSS vars,
  // canvas via currentTokens(), the Appearance preview — read the same resolved
  // chrome. If derivation happened per-consumer, canvas and CSS could disagree.
  const t: DesignTokens =
    tIn.seeds.enabled
      ? { ...tIn, chrome: deriveChrome(tIn.seeds, tIn.chrome) }
      : tIn;
  current = t;
  // Tint strength. Disabled → 0%, which makes every color-mix in semantic.css
  // resolve to pure chrome: the tints vanish without a single rule branching.
  // (Solid identity surfaces — a deck badge — go through semanticColor()
  // instead, which returns the chrome fallback. Both paths, one switch.)
  const mix = t.semantic.enabled ? t.semantic.strengthPct : 0;
  const vars: Record<string, string> = {
    // Native scrollbars, form controls and default focus rings follow this. A
    // light look without it ships with dark scrollbars — every token correct,
    // and the app still looks broken.
    "color-scheme": t.polarity,
    "--grain-alpha": `${t.surface.grainAlpha}`,
    "--bg": t.chrome.bg,
    "--bg-raised": t.chrome.bgRaised,
    "--line": t.chrome.line,
    "--text": t.chrome.text,
    "--text-dim": t.chrome.textDim,
    "--accent": t.chrome.accent,
    "--signal": t.chrome.signal,
    "--warn": t.chrome.warn,
    "--hot": t.chrome.hot,
    // --fill-neutral is the untinted slider fill; --fill is the one controls
    // actually read, so a `.sem` subtree can re-point it at a tinted mix and
    // every GeoRange/MicroSend inside inherits the identity color with no
    // component change (their gradients already say `var(--fill)`).
    "--fill-neutral": `color-mix(in srgb, ${t.chrome.accent} ${t.control.slider.fillMixPct}%, ${t.chrome.bgRaised})`,
    "--fill": "var(--fill-neutral)",
    "--sem-mix": `${mix}%`,
    "--sem-mix-soft": `${Math.round(mix * 0.5)}%`,
    "--sem-mix-strong": `${Math.min(100, Math.round(mix * 2.2))}%`,
    "--sem-mute-group": muteGroupColor(),
    // Shape. Role radii DERIVE from the one number, so a look sets `radiusPx`
    // and every corner in the app follows — including canvas (ctx.roundRect),
    // which reads t.shape.radiusPx directly since it cannot resolve CSS vars.
    "--radius": `${t.shape.radiusPx}px`,
    "--radius-sm": "calc(var(--radius) * 0.5)",
    "--radius-lg": "calc(var(--radius) * 2)",
    "--radius-pill": "999px",
    "--hairline": `${t.shape.hairlinePx}px`,
    // Motion. One lever: at scale 0 every calc() below resolves to 0ms and the
    // app is instant, with no rule anywhere testing whether motion is enabled.
    // base.css forces this to 0 under prefers-reduced-motion.
    "--motion-scale": `${t.motion.scale}`,
    "--dur-fast": `calc(${t.motion.fastMs}ms * var(--motion-scale))`,
    "--dur-base": `calc(${t.motion.baseMs}ms * var(--motion-scale))`,
    // NOT scaled — see MotionTokens.pulseMs. A transport state pulse is a
    // readout; the motion lever only governs chrome.
    "--dur-pulse": `${t.motion.pulseMs}ms`,
    // One duration per trick. A disabled trick emits 0ms, so its transition
    // still exists and simply takes no time — which means NO CSS rule anywhere
    // tests whether a trick is on, and toggling one can never leave a surface
    // in a half-styled state. Same shape as the --motion-scale lever above.
    "--dur-menu": trickDur(t, t.motion.tricks.menuEntry, "--dur-fast"),
    "--dur-hover": trickDur(t, t.motion.tricks.hoverLift, "--dur-fast"),
    "--dur-latch": trickDur(t, t.motion.tricks.latchSweep, "--dur-base"),
    "--dur-panel": trickDur(t, t.motion.tricks.panelEntry, "--dur-base"),
    "--ease": t.motion.ease,
    "--ease-out": t.motion.easeOut,
    // Elevation. ambientAlpha 0 → both shadows are `none`: the app stops
    // pretending to have depth rather than rendering an invisible blur.
    "--elev-1": elevationShadow(t, 2, 6, 0.6),
    "--elev-2": elevationShadow(t, 4, 14, 1),
    // Depth order, 1:1 with the raw values these replace — no restacking.
    "--z-base": "2",
    "--z-raised": "3",
    "--z-float": "4",
    "--z-overlay": "10",
    "--z-popover": "20",
    "--z-menu": "50",
    "--z-entry": "51",
    "--font-mono": t.fontMono,
    "--font-ui": t.fontUI,
    "--cell": `${t.control.density.cellPx}px`,
    "--row-height": `${t.control.density.rowHeightPx}px`,
    // Uniform control height (DESIGN-SYSTEM §7): one value for every inline
    // control. --slider-bar-h stays as the established alias panels already
    // reference; both resolve to the same px so nothing can drift.
    "--control-h": `${t.control.slider.barHeightPx}px`,
    "--slider-bar-h": `${t.control.slider.barHeightPx}px`,
    "--slider-marker-w": `${t.control.slider.markerWidthPx}px`,
    "--focus-ring-w": `${t.control.focus.ringWidthPx}px`,
    // HIT GROUND (user, 2026-07-17). Heavy-traffic controls wear `.ds-hot`,
    // which claims an invisible margin of clickable ground around the painted
    // box (controls.css). DERIVED from --cell, not a step of its own: the slop
    // is HALF the standard block-row gutter, so two hot neighbours meet at the
    // gap's midline and a click is never routed to the farther target. A
    // context with a tighter gutter must scope --hit-slop down (scene-pads),
    // never the other way around.
    "--hit-slop": "calc(var(--cell) / 2)",
    // The generous vertical variant, for a control with open air above and
    // below it — the master TEMPO slider's grab band, nothing else yet.
    "--hit-slop-y": "calc(var(--cell) * 2)",
    // The heavy-traffic control height: a performance surface (the DJ deck
    // transport rows) scopes --control-h to this, exactly like .dj-master-box
    // scopes itself to 1.5× — every control in the surface rescales together,
    // so nothing inside it can drift out of line.
    "--control-h-hot": "calc(var(--slider-bar-h) * 1.25)",
    ...typeVars("type-display", t.type.display),
    ...typeVars("type-title", t.type.title),
    ...typeVars("type-label", t.type.label),
    ...typeVars("type-value", t.type.value),
    ...typeVars("type-caption", t.type.caption),
    // The small-text family below caption (TOOL-TYPE, 2026-07-14). These were
    // ~40 hardcoded px scattered through panel CSS — sizes no look could reach.
    // DERIVED, not steps of their own: they ride the caption slider at fixed
    // ratios (10 → 9/8/7px at the default), so the whole small end scales as
    // one family and there is nothing extra to edit. They size GLYPH CHROME
    // (step numbers, badges, drag-box caps) — never labels, which have a 9px
    // floor (§4b); micro is that floor's edge, mini/nano are below it and must
    // stay classified as glyphs.
    "--type-micro-size": "calc(var(--type-caption-size) * 0.9)",
    "--type-mini-size": "calc(var(--type-caption-size) * 0.8)",
    "--type-nano-size": "calc(var(--type-caption-size) * 0.7)",
  };
  // Root-level identity vars, for surfaces whose family member is fixed at
  // author time (a routing-matrix row is always SEND 3). Surfaces whose member
  // is dynamic (a track's mod slot) set --sem-color inline from semanticColor().
  for (const family of ["send", "mod", "deck"] as const) {
    t.semantic[family].forEach((_, i) => {
      vars[`--sem-${family}-${i + 1}`] = semanticColor(family, i);
    });
  }
  return vars;
}

/** Writes every token as a CSS custom property on :root. */
export function applyTokens(t: DesignTokens): void {
  const vars = tokenVars(t);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  for (const cb of tokensListeners) cb(t);
}

/** Deep-merges a stored partial over the defaults (one level per group). */
export function mergeTokens(stored: unknown): DesignTokens {
  if (typeof stored !== "object" || stored === null) return DEFAULT_TOKENS;
  const s = stored as Partial<DesignTokens>;
  // A palette is only usable if it has an entry per family member, so a stored
  // array of the wrong length (an older theme, a hand-edited one) falls back
  // whole rather than leaving holes that render as the fallback color.
  const palette = (stored: unknown, fallback: string[]): string[] =>
    Array.isArray(stored) && stored.length === fallback.length
      ? (stored as string[])
      : fallback;
  const sem: Partial<SemanticColors> = s.semantic ?? {};
  return {
    polarity: s.polarity === "light" ? "light" : "dark",
    seeds: { ...DEFAULT_TOKENS.seeds, ...(s.seeds ?? {}) },
    chrome: { ...DEFAULT_TOKENS.chrome, ...(s.chrome ?? {}) },
    surface: { ...DEFAULT_TOKENS.surface, ...(s.surface ?? {}) },
    shape: { ...DEFAULT_TOKENS.shape, ...(s.shape ?? {}) },
    motion: {
      ...DEFAULT_TOKENS.motion,
      ...(s.motion ?? {}),
      // A stored theme from before a trick existed must not leave it undefined —
      // that would read as "off" and silently drop the trick from every look.
      tricks: { ...DEFAULT_TOKENS.motion.tricks, ...(s.motion?.tricks ?? {}) },
    },
    elevation: { ...DEFAULT_TOKENS.elevation, ...(s.elevation ?? {}) },
    semantic: {
      ...DEFAULT_TOKENS.semantic,
      ...sem,
      send: palette(sem.send, DEFAULT_TOKENS.semantic.send),
      mod: palette(sem.mod, DEFAULT_TOKENS.semantic.mod),
      deck: palette(sem.deck, DEFAULT_TOKENS.semantic.deck),
    },
    dataPalette: Array.isArray(s.dataPalette) ? s.dataPalette : DEFAULT_TOKENS.dataPalette,
    trackColor: { ...DEFAULT_TOKENS.trackColor, ...(s.trackColor ?? {}) },
    fontMono: s.fontMono ?? DEFAULT_TOKENS.fontMono,
    fontUI: s.fontUI ?? DEFAULT_TOKENS.fontUI,
    type: {
      display: { ...DEFAULT_TOKENS.type.display, ...(s.type?.display ?? {}) },
      title: { ...DEFAULT_TOKENS.type.title, ...(s.type?.title ?? {}) },
      label: { ...DEFAULT_TOKENS.type.label, ...(s.type?.label ?? {}) },
      value: { ...DEFAULT_TOKENS.type.value, ...(s.type?.value ?? {}) },
      caption: { ...DEFAULT_TOKENS.type.caption, ...(s.type?.caption ?? {}) },
    },
    control: {
      slider: { ...DEFAULT_TOKENS.control.slider, ...(s.control?.slider ?? {}) },
      dragBox: { ...DEFAULT_TOKENS.control.dragBox, ...(s.control?.dragBox ?? {}) },
      focus: { ...DEFAULT_TOKENS.control.focus, ...(s.control?.focus ?? {}) },
      density: { ...DEFAULT_TOKENS.control.density, ...(s.control?.density ?? {}) },
    },
    background: { ...DEFAULT_TOKENS.background, ...(s.background ?? {}) },
    // Range-clamped on the way in: a stored style from an older/edited theme
    // must not be able to wedge the canvas.
    waveform: normalizeWaveform({ ...DEFAULT_WAVEFORM, ...(s.waveform ?? {}) }),
  };
}

/**
 * Republishes the resolved ground (GROUND_KEY) for the native host.
 *
 * Read-before-write, because EVERY panel loads tokens and a setSetting fans a
 * settingChanged event out to every OTHER webview: an unconditional write would
 * have N panels notifying each other of a value none of them changed.
 */
async function publishGround(link: EngineLink): Promise<void> {
  const ground = currentTokens().chrome.bg;
  try {
    const raw = await link.command("getSetting", { key: GROUND_KEY });
    if ((raw as { value?: unknown })?.value === ground) return;
    await link.command("setSetting", { key: GROUND_KEY, value: ground });
  } catch {
    // No settings store (the browser host) — there is no native window to match.
  }
}

/** Loads persisted tokens (theme.tokens) and applies them; returns them. */
export async function loadAndApplyTokens(link: EngineLink | null): Promise<DesignTokens> {
  applyTokens(DEFAULT_TOKENS); // immediate paint with defaults
  if (!link) return DEFAULT_TOKENS;
  try {
    const raw = await link.command("getSetting", { key: THEME_KEY });
    const tokens = mergeTokens((raw as { value?: unknown })?.value);
    applyTokens(tokens);
    void publishGround(link);
    return tokens;
  } catch {
    return DEFAULT_TOKENS;
  }
}

/** Re-fetches persisted tokens and applies them WITHOUT the defaults
    pre-paint — live sync when ANOTHER webview (the Appearance editor) saved
    theme.tokens; a defaults flash here would strobe every open panel. */
export async function refreshTokens(link: EngineLink): Promise<void> {
  try {
    const raw = await link.command("getSetting", { key: THEME_KEY });
    applyTokens(mergeTokens((raw as { value?: unknown })?.value));
  } catch {
    // keep the currently applied tokens
  }
}

/** Persists tokens and applies them live. */
export function saveAndApplyTokens(link: EngineLink | null, tokens: DesignTokens): void {
  applyTokens(tokens);
  link?.command("setSetting", { key: THEME_KEY, value: tokens }).catch(() => {});
  // applyTokens has already resolved the derivation, so currentTokens() (inside)
  // is the ground that is now on screen — the host window follows it from here.
  if (link) void publishGround(link);
}
