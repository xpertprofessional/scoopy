/**
 * check:tokens — fails if any file under web/src (excluding src/design/)
 * hardcodes a visual constant. Everything visual must come from the token
 * system (docs/migration/DESIGN-SYSTEM.md §1).
 *
 * WHY THIS GATE IS BROADER THAN "COLORS AND FONTS":
 * it used to check only those two, and the cost was three live bugs that sat in
 * the tree unnoticed, all of the same species — a var that was referenced but
 * never defined, so the declaration was invalid at computed-value time and
 * silently rendered as nothing:
 *
 *   --radius-sm       (nudge.css, djmode.css)  → corners silently rendered at 0
 *   --border          (grid.css ×2)            → `border` shorthand dropped ENTIRELY
 *   --dragbox-radius  (modulation.css ×3)      → masked by its 3px fallback
 *
 * A token that nothing enforces is a token that rots. So: every new token group
 * ships with the rule that protects it, and DANGLING_VAR below is the rule that
 * would have caught all three on the day they were written.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TOKENS, tokenVars } from "../src/design/tokens.ts";

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const designRoot = join(srcRoot, "design");

/**
 * LITERALS THAT ARE A RECORDED DECISION, not an oversight — the same discipline
 * as ALLOWED_ORPHANS below, and it carries a reason for the same purpose.
 *
 * ⚠️ THIS IS A GAP IN THE RULE, NOT AN ESCAPE HATCH FOR THE CODE, and that
 * distinction is the entire justification for the mechanism.
 *
 * The rule says everything visual comes from tokens, which is right because the
 * tokens ARE the look: change the theme and the app follows. But a USER-FACING
 * PALETTE is not styling — it is DATA a person picks from and then owns. If
 * "Red" came from the theme, changing look would change what colour someone's
 * track is, and a track they coloured deliberately would come back different
 * with nothing to undo. That is a worse outcome than the literal.
 *
 * The bar for an entry: the value is data a user chose, or a foreign system
 * defined, and NOT a value the look should be able to reach. "It was awkward to
 * tokenise" is not a reason and never will be.
 */
const ALLOWED_LITERALS: Record<string, { rules: readonly string[]; why: string }> = {
  "panels/trackControls.ts": {
    // SCOPED TO COLOUR, not to the file. Exempting the whole file would also
    // stop the gate noticing a hardcoded font-size or duration that wandered in
    // later — an exemption should cost exactly the rule it was argued for.
    rules: ["hardcoded color"],
    why:
      "TRACK_PALETTE mirrors BeatSequencer.palette — the 8 identity colours a USER picks " +
      "from and then owns on their track. Theming them would change what colour someone's " +
      "track is when they change look, which is data loss wearing a stylesheet.",
  },
};

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
const FONT_LITERAL = /font(-family)?\s*:\s*[^;}]*(["'][A-Za-z]|serif|sans-serif|monospace)/;
const FONT_VAR_OK = /font(-family)?\s*:\s*var\(/;

/** A px/% radius literal. Corners are a token (`shape.radiusPx`) so ONE number
    softens the whole app — a stray literal is a corner that ignores the look. */
const RADIUS_LITERAL = /border-radius\s*:\s*[^;}]*\d/;

/** Depth must come from the --z-* scale, or stacking becomes a guessing game. */
const Z_LITERAL = /z-index\s*:\s*-?\d/;

/** A duration that is not a --dur-* var would survive prefers-reduced-motion,
    because the motion lever MULTIPLIES (calc(<n>ms * var(--motion-scale)));
    it does not branch. A literal `90ms` is therefore unkillable. */
const DURATION_LITERAL = /(transition|animation)(-duration)?\s*:\s*[^;}]*\d+m?s\b/;

/** A px font-size is a size no look can reach (TOOL-TYPE, 2026-07-14 — there
    were ~40 of them, some at 7-8px, under the system's own 9px label floor).
    Sizes come from the --type-*-size scale (incl. the derived micro/mini/nano
    small-text family). Relative units (em/%) are fine: they ride whatever
    token sizes their parent. */
const FONT_SIZE_LITERAL = /font-size\s*:\s*[^;}]*\d+px/;

/** rgb()/hsl() with only numeric args — the loophole HEX_COLOR never closed.
    An interpolated `rgb(${r} ${g} ${b})` (waveRender computes spectrum hues
    FROM tokens) is legitimate and must not trip. */
const COLOR_FUNC_LITERAL = /\b(rgba?|hsla?)\s*\([^)$]*\d[^)$]*\)/;

/**
 * A canvas alpha that is a bare number.
 *
 * Canvas cannot resolve CSS vars, so `ctx.globalAlpha = 0.12` is a value NO look
 * can ever reach — which is exactly what made a light theme impossible to build:
 * ~30 of them, each hand-tuned for a near-black ground, sitting in GridPanel.
 * They now come from `tokens.surface` (theme-owned levels) or a named ratio
 * const (design-owned balance).
 *
 * `= 1` and `= 0` are exempt: those are the reset-to-opaque / fully-transparent
 * idiom, not a tuned value.
 */
const CANVAS_ALPHA = /globalAlpha\s*=\s*([\d.]+)/;

const violations: string[] = [];
/** Files skipped by ALLOWED_LITERALS, reported so an exemption cannot go quiet.
    An exemption nobody sees is indistinguishable from a rule that stopped
    running. */
const exempted: string[] = [];

/**
 * Custom properties that are legitimately defined.
 *
 * Seeded by ASKING the token system what it emits, rather than grepping for it:
 * several vars are generated from a template (`--${step}-size`), so a static
 * scan cannot see them — and a gate that guesses at the token list is a gate
 * that drifts away from it. Calling tokenVars() means this check is exact by
 * construction and stays correct when a token group is added.
 */
const defined = new Set<string>(Object.keys(tokenVars(DEFAULT_TOKENS)));
const used = new Map<string, string>(); // name → first location

function collectDefs(text: string): void {
  // CSS declaration: `--x: …`
  for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) if (m[1]) defined.add(m[1]);
  // JS/TSX object key or setProperty: `"--x":` / setProperty("--x" — a surface
  // whose semantic family is only known at render time sets --sem-color itself.
  for (const m of text.matchAll(/["'](--[\w-]+)["']/g)) if (m[1]) defined.add(m[1]);
}

function collectUses(text: string, loc: string): void {
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (m[1] && !used.has(m[1])) used.set(m[1], loc);
  }
}

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(entry)) continue;
    // Test fixtures may carry literal colors (e.g. colorHex track fixtures) —
    // tests are not a visual surface (MIGRATION.md P4-09c2 note).
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;

    const text = readFileSync(full, "utf8");
    const rel = relative(srcRoot, full);

    // Definitions are collected from EVERYWHERE, including design/ — that is
    // where the tokens are minted. Only the literal rules skip design/.
    collectDefs(text);
    const lines = text.split("\n");
    collectUses(text, rel);

    // design/ mints the tokens, so it is the one place allowed to hold literals.
    if (full.startsWith(designRoot)) continue;
    // A file may have a RECORDED exemption for specific RULES (see
    // ALLOWED_LITERALS). Keyed by file rather than by line because line numbers
    // move, and an exemption that silently slid onto a different line would be
    // worse than none.
    const allow = ALLOWED_LITERALS[rel];
    if (allow) exempted.push(rel);

    lines.forEach((line, i) => {
      const loc = `${rel}:${i + 1}`;
      const flag = (what: string) => {
        if (allow?.rules.includes(what)) return;
        violations.push(`${loc} ${what}: ${line.trim()}`);
      };
      if (HEX_COLOR.test(line)) flag("hardcoded color");
      if (COLOR_FUNC_LITERAL.test(line)) flag("hardcoded color");
      if (FONT_LITERAL.test(line) && !FONT_VAR_OK.test(line)) flag("hardcoded font");
      if (RADIUS_LITERAL.test(line)) flag("hardcoded radius (use var(--radius*))");
      if (Z_LITERAL.test(line)) flag("hardcoded z-index (use var(--z-*))");
      if (DURATION_LITERAL.test(line)) flag("hardcoded duration (use var(--dur-*))");
      if (FONT_SIZE_LITERAL.test(line)) flag("hardcoded font-size (use var(--type-*-size))");
      const alpha = CANVAS_ALPHA.exec(line);
      if (alpha && alpha[1] !== "1" && alpha[1] !== "0") {
        flag("hardcoded canvas alpha (use tokens.surface / a named ratio)");
      }
    });
  }
}

walk(srcRoot);

// A token consumed by ANOTHER TOKEN is consumed: `--dur-menu: var(--dur-fast)`,
// `--radius-sm: calc(var(--radius) * 0.5)`, `--fill: var(--fill-neutral)`. Those
// references are built from templates in tokenVars, so no static scan of the
// source can see them — read them off the emitted VALUES instead, which is exact.
for (const [name, value] of Object.entries(tokenVars(DEFAULT_TOKENS))) {
  collectUses(value, `tokens.ts (value of ${name})`);
}

// The rot rule. A var that is referenced but never defined is invalid at
// computed-value time: the browser drops the whole declaration, so the surface
// renders with NOTHING and says nothing about it. This is the check that would
// have caught --radius-sm, --border and --dragbox-radius.
for (const [name, loc] of used) {
  if (!defined.has(name)) {
    violations.push(`${loc} dangling var: ${name} is used but never defined`);
  }
}

// The ORPHAN rule — the inverse, and the one that actually matters for a token
// system's honesty. A var that applyTokens emits but NOTHING consumes is a
// control the user can drag while nothing on screen changes. That is worse than
// a missing feature: it is a lie about what the app can do.
//
// This is what `--elev-1` was (emitted, consumed by zero rules — the "Depth"
// slider moved and nothing happened), and it is the same species as the corner
// radius reaching only the handful of elements that already had one.
//
// A token is not shipped when it is EMITTED. It is shipped when something OBEYS it.
/**
 * Orphans that are a RECORDED DECISION, not an oversight. Each needs a reason —
 * "reserved" with no argument is how a token system fills up with controls that
 * do nothing.
 */
const ALLOWED_ORPHANS: Record<string, string> = {
  "--sem-mix-soft": "reserved by the semantic system; no surface has needed the half-strength mix yet",
  "--sem-send-1": "root identity vars for surfaces whose family member is fixed at author time",
  "--sem-send-2": "see --sem-send-1",
  "--sem-send-3": "see --sem-send-1",
  "--sem-send-4": "see --sem-send-1",
  "--sem-mod-1": "see --sem-send-1",
  "--sem-mod-2": "see --sem-send-1",
  "--sem-mod-3": "see --sem-send-1",
  "--sem-mod-4": "see --sem-send-1",
  "--sem-deck-1": "see --sem-send-1",
  "--sem-deck-2": "see --sem-send-1",
  "--sem-deck-3": "see --sem-send-1",
  // typeVars emits all five axes for every step by construction. A step that
  // exposes only the axes it currently uses would silently drop an axis the
  // moment a look wanted it, which is the opposite of a token system.
  "--type-value-tracking": "typeVars emits all 5 axes per step, by construction",
  "--type-value-transform": "typeVars emits all 5 axes per step, by construction",
  "--type-caption-tracking": "typeVars emits all 5 axes per step, by construction",
  "--type-caption-transform": "typeVars emits all 5 axes per step, by construction",
};

for (const name of Object.keys(tokenVars(DEFAULT_TOKENS))) {
  if (!name.startsWith("--")) continue; // color-scheme is a real property, not a var
  if (used.has(name) || name in ALLOWED_ORPHANS) continue;
  violations.push(
    `orphan token: ${name} is emitted but NOTHING consumes it — ` +
      `a control the user can drag while nothing changes. Wire it up, delete it, ` +
      `or add it to ALLOWED_ORPHANS with a reason.`,
  );
}

if (violations.length) {
  console.error(`check:tokens FAILED — ${violations.length} violation(s):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
for (const rel of exempted) {
  // Printed on SUCCESS too. The point of a recorded exemption is that it stays
  // visible: a silent one rots into "the gate does not cover that file" without
  // anybody deciding it should not.
  const a = ALLOWED_LITERALS[rel];
  console.log(`check:tokens — ${a?.rules.join(", ")} exempt in ${rel}: ${a?.why}`);
}
console.log("check:tokens ok");
