/**
 * faces:check — a FACE composes blocks; it never rebuilds one (D-SL-STUDIO-01 L1).
 *
 * WHY THIS EXISTS. Six products share one bundle and differ only in three
 * places: which blocks a face mounts, what `getCapabilities` answers, and
 * `viewDensity`. Nothing mechanical held that, and the cost is already on the
 * record twice — `PluginDeckPanel`'s first cut hand-wired the deck rows and PERF
 * did nothing (PERF has to reach the grid BACKEND, not a React prop), and
 * `CompanionPanel` carried a hand-written save lifecycle that had quietly lost
 * half its job.
 *
 * ⚠️ WHAT IT DELIBERATELY DOES NOT CHECK, because a gate that needs an allowlist
 * on the day it ships is not a gate. "Does this face re-declare the transport?"
 * looked like the obvious rule and was measured to be unusable: the four glyphs
 * appear legitimately in tooltips (`'Q OFF — ⟳ starts this deck immediately'`),
 * in prose, and as `PluginTapePanel`'s OWN transport, which is a different scope
 * rather than a copy. Every rule below is one with no known false positive.
 *
 * ITS RULE SET GROWS WITH THE BLOCKS. Today three exist (`studio/Transport.tsx`,
 * the FILES drawer, and `blocks/TapeRow.tsx`); as S2 extracts the rest, each
 * lands here with the marker that would mean somebody rebuilt it. R5 is
 * TapeRow's, and its marker was measured before it was written — see the rule.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string) => readFileSync(resolve(webRoot, p), 'utf8')

/** Comments stripped. Every rule here is about what SHIPS, and each of these
 *  files documents the traps it avoids — matching prose would fail a file for
 *  warning about the very thing the rule forbids. Learned twice while writing
 *  the tests these rules came from. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * THE FACES. A face is a top-level surface `App.tsx` routes to by `__slPanel`.
 * `editsSession` marks the ones that own a session document and therefore owe
 * the save lifecycle; `PluginTapePanel` is a face but edits tapes, not sessions.
 */
const FACES = [
  { file: 'src/studio/StudioPanel.tsx', route: 'studio', editsSession: true },
  { file: 'src/plane/ComposeWindow.tsx', route: 'compose', editsSession: true },
  { file: 'src/plane/PluginDeckPanel.tsx', route: 'plugindeck', editsSession: true },
  { file: 'src/panels/CompanionPanel.tsx', route: 'companion', editsSession: true },
  { file: 'src/plane/PluginTapePanel.tsx', route: 'plugintape', editsSession: false },
  { file: 'src/plane/PlanePanel.tsx', route: 'plane', editsSession: false },
] as const

const APP = read('src/App.tsx')
const errors: string[] = []

for (const face of FACES) {
  let src: string
  try {
    src = read(face.file)
  } catch {
    errors.push(
      `${face.file} is registered as the "${face.route}" face but does not exist.\n` +
        `  Either restore it or remove it from FACES in scripts/checkFaces.ts.`,
    )
    continue
  }
  const body = code(src)

  // R1 — a face must be ROUTED. An unrouted face is the defect class this repo
  // keeps hitting from the other side: built, green, and reachable by nobody.
  if (!APP.includes(`panel === "${face.route}"`)) {
    errors.push(
      `${face.file}: App.tsx has no route for panel "${face.route}".\n` +
        `  A face nothing routes to cannot be opened — the fourth of the four rules.`,
    )
  }

  // R2 — DESIGN.md §1: a parameter with a value is `GeoRange`, NEVER a bare
  // range input. The rule exists because that shipped once; `controls.tsx` is
  // where the one legitimate range input lives, and a face is never that file.
  if (/type=["']range["']/.test(body)) {
    errors.push(
      `${face.file}: hand-rolled <input type="range">.\n` +
        `  DESIGN.md §1: use GeoRange (design/controls.tsx). A raw range also carries a\n` +
        `  real trap — a mousedown on the track fires \`change\` BEFORE \`click\` exists.`,
    )
  }

  // R3 — the save lifecycle belongs to `useComposeLifecycle`. A face reaching
  // for `flushAutosave` itself is rebuilding it, which is how CompanionPanel
  // ended up listening for `pagehide` alone and having no ⌘S at all.
  if (body.includes('flushAutosave')) {
    errors.push(
      `${face.file}: calls flushAutosave directly.\n` +
        `  That is useComposeLifecycle's job — a face that rolls its own drifts from\n` +
        `  the others silently, and the drift is only visible by losing work.`,
    )
  }
  if (face.editsSession && !body.includes('useComposeLifecycle(')) {
    errors.push(
      `${face.file}: edits a session but does not call useComposeLifecycle.\n` +
        `  It owes ⌘S (D-SL-SAVE-01) and the pagehide/visibilitychange flush.`,
    )
  }

  // R5 — the LOOPER is `blocks/TapeRow.tsx`. A face that speaks the tape wire
  // itself is rebuilding it, which is the exact state this block was carved out
  // of: `PluginTapePanel` WAS the looper, so the looper existed in one product
  // and Studio's S8 would have written a second one.
  //
  // ⚠️ `scrubBegin` is the marker BECAUSE IT WAS MEASURED, per this file's own
  // rule that a gate needing an allowlist on day one is not a gate. It appears
  // in exactly two files in the tree — `PluginTapePanel` (now a mount, so it no
  // longer says it) and `plane/Strip.tsx`, which is NOT a face: it is a
  // component of `PlanePanel`, the frozen plane's 48 px lane, a different scope
  // rather than a copy. No face legitimately says this word.
  if (/\bscrubBegin\b/.test(body) && !body.includes('TapeRow')) {
    errors.push(
      `${face.file}: drives the tape scrub wire directly.\n` +
        `  The looper is a BLOCK — mount blocks/TapeRow.tsx (D-SL-STUDIO-01 L1).\n` +
        `  A face that re-speaks slTape drifts from the other faces silently, and the\n` +
        `  drift is only visible by one product growing a feature the others cannot get.`,
    )
  }
}

if (errors.length === 0) {
  console.log(`faces:check ok — ${FACES.length} faces`)
  process.exit(0)
}
console.error(`faces:check RED — ${errors.length} violation(s):\n`)
for (const e of errors) console.error(`  ${e}\n`)
process.exit(1)
