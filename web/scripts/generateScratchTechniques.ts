/**
 * SCRATCH TECHNIQUES — one authority, two emitted mirrors.
 *
 *   node --experimental-strip-types scripts/generateScratchTechniques.ts          (write)
 *   node --experimental-strip-types scripts/generateScratchTechniques.ts --check  (CI gate)
 *
 * WHY: the engine EXECUTES the technique table (per-sample phase and gate in
 * `sl_tape.cpp`) and the UI NAMES it (a `Select` in `blocks/TapeRow.tsx`). Two
 * hand-written copies of the same eleven figures is precisely the shape this
 * codebase has a standing law against — `generateTrackParams.ts`'s header puts
 * it plainly: a mis-mapped field is written into the WRONG parameter, which is
 * worse than one not carried at all. Here the equivalent failure is quiet and
 * nasty: pick "crab" in the UI, get an orbit's gate, and nothing anywhere is
 * red. The index IS the contract between the two files, so the index is
 * generated.
 *
 * AUTHORITY: `slengine/scratch-techniques.json`, whose own header carries the
 * model and its provenance (docs/specs/scratching.md §2 — our encoding of
 * publicly documented behaviour, nothing transcribed).
 *
 * IT REFUSES RATHER THAN EMITS SOMETHING PLAUSIBLE. Every constraint below is
 * one that would otherwise produce a table that compiles, runs, and is wrong:
 * a duplicate id (the UI and the engine would disagree about which is which), a
 * click at `at >= 1` (falls in the next stroke), a `span` of 0 (a gesture that
 * does not move), a rest state that is neither open nor closed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const srcPath = resolve(appRoot, 'slengine/scratch-techniques.json')
const incPath = resolve(appRoot, 'slengine/generated/sl_scratch_table.inc')
const tsPath = resolve(appRoot, 'web/src/blocks/scratchTechniques.ts')

class GenerationRefused extends Error {}

type Click = { stroke: 'both' | 'forward' | 'back'; at: number }
interface Technique {
  id: string
  label: string
  hint: string
  strokeRest: [string, string]
  clicks: Click[]
  clickWidthMs: number
  strokeShape: string
  span: number
  periodBeats: number
}

const REST = { closed: 0, open: 1 } as const
const SHAPE = { sine: 0, asymmetric: 1 } as const
const STROKE = { forward: 0, back: 1, both: 2 } as const

function parse(): Technique[] {
  const raw = JSON.parse(readFileSync(srcPath, 'utf8')) as { techniques?: unknown }
  const list = raw.techniques
  if (!Array.isArray(list) || list.length === 0)
    throw new GenerationRefused(`${srcPath} has no "techniques" array`)

  const seen = new Set<string>()
  return list.map((entry, i) => {
    const t = entry as Technique
    const where = `techniques[${i}]${t.id ? ` ("${t.id}")` : ''}`
    if (typeof t.id !== 'string' || !/^[a-z][a-z0-9]*$/.test(t.id))
      throw new GenerationRefused(`${where}: id must be lowercase alphanumeric — it becomes a C enumerator`)
    if (seen.has(t.id)) throw new GenerationRefused(`${where}: duplicate id "${t.id}"`)
    seen.add(t.id)
    if (typeof t.label !== 'string' || t.label.length === 0)
      throw new GenerationRefused(`${where}: needs a label — it is what a person picks`)
    if (typeof t.hint !== 'string' || t.hint.length === 0)
      throw new GenerationRefused(`${where}: needs a hint — DESIGN.md, a control says what it does`)
    if (!Array.isArray(t.strokeRest) || t.strokeRest.length !== 2)
      throw new GenerationRefused(`${where}: strokeRest must be [forward, backward]`)
    for (const r of t.strokeRest)
      if (!(r in REST)) throw new GenerationRefused(`${where}: strokeRest "${r}" is not open|closed`)
    if (!(t.strokeShape in SHAPE))
      throw new GenerationRefused(`${where}: strokeShape "${t.strokeShape}" is not sine|asymmetric`)
    if (!Array.isArray(t.clicks))
      throw new GenerationRefused(`${where}: clicks must be an array (empty is meaningful — see baby)`)
    for (const c of t.clicks) {
      if (!(c.stroke in STROKE))
        throw new GenerationRefused(`${where}: click stroke "${c.stroke}" is not forward|back|both`)
      // >= 1 would land in the NEXT stroke, which is a different figure.
      if (!(typeof c.at === 'number') || !(c.at >= 0 && c.at < 1))
        throw new GenerationRefused(`${where}: click at=${c.at} must be in [0,1) — a position WITHIN the stroke`)
    }
    // The signed exception is 1-3 ms of RAMP; this is the width of the whole
    // excursion, measured at 30-70 ms. A click narrower than the ramp could
    // never open, and one wider than a stroke is not a click.
    if (!(t.clickWidthMs >= 5 && t.clickWidthMs <= 200))
      throw new GenerationRefused(`${where}: clickWidthMs=${t.clickWidthMs} outside 5..200 (measured clicks run 30-70)`)
    if (!(t.span > 0 && t.span <= 1))
      throw new GenerationRefused(`${where}: span=${t.span} must be in (0,1] — a fraction of the loop, and 0 does not move`)
    if (!(t.periodBeats > 0 && t.periodBeats <= 8))
      throw new GenerationRefused(`${where}: periodBeats=${t.periodBeats} must be in (0,8]`)
    if (t.clicks.length === 0 && t.strokeRest[0] === 'closed' && t.strokeRest[1] === 'closed')
      throw new GenerationRefused(`${where}: rest closed on both strokes with no clicks is SILENCE`)
    return t
  })
}

const BANNER = (tool: string) =>
  `// GENERATED by web/scripts/generateScratchTechniques.ts — DO NOT EDIT.\n` +
  `// Authority: slengine/scratch-techniques.json (its header carries the model).\n` +
  `// Regenerate: npm run scratch:generate   ·   Gate: npm run ${tool}\n`

function emitInc(ts: Technique[]): string {
  const clicks: string[] = []
  const offsets: number[] = []
  let n = 0
  for (const t of ts) {
    offsets.push(n)
    for (const c of t.clicks) {
      clicks.push(`    { ${STROKE[c.stroke]}, ${c.at.toFixed(6)} },`)
      n++
    }
  }
  const rows = ts.map((t, i) => {
    const rest = `{ ${REST[t.strokeRest[0] as keyof typeof REST]}, ${REST[t.strokeRest[1] as keyof typeof REST]} }`
    return (
      `    { "${t.id}", ${rest}, ${offsets[i]}, ${t.clicks.length}, ` +
      `${t.clickWidthMs.toFixed(1)}, ${SHAPE[t.strokeShape as keyof typeof SHAPE]}, ` +
      `${t.span.toFixed(6)}, ${t.periodBeats.toFixed(6)} }, /* ${t.label} */`
    )
  })
  return (
    BANNER('scratch:check') +
    `\n#define SL_SCRATCH_TECHNIQUE_COUNT ${ts.length}\n` +
    `#define SL_SCRATCH_CLICK_COUNT ${Math.max(n, 1)}\n` +
    `\n/* stroke: 0 forward · 1 back · 2 both. "at" is within the stroke, [0,1). */\n` +
    `typedef struct { int stroke; double at; } SlScratchClick;\n` +
    `\n/* rest: 0 closed · 1 open, per [forward, back]. shape: 0 sine · 1 asymmetric. */\n` +
    `typedef struct {\n` +
    `    const char* id;\n` +
    `    int rest[2];\n` +
    `    int clickFirst;   /* index into kSlScratchClicks */\n` +
    `    int clickCount;\n` +
    `    double clickWidthMs;\n` +
    `    int shape;\n` +
    `    double span;      /* fraction of the loop */\n` +
    `    double periodBeats;\n` +
    `} SlScratchTechnique;\n` +
    `\nstatic const SlScratchClick kSlScratchClicks[SL_SCRATCH_CLICK_COUNT] = {\n` +
    (clicks.length > 0 ? clicks.join('\n') : '    { 0, 0.0 }, /* none: no technique has clicks */') +
    `\n};\n` +
    `\nstatic const SlScratchTechnique kSlScratchTechniques[SL_SCRATCH_TECHNIQUE_COUNT] = {\n` +
    rows.join('\n') +
    `\n};\n`
  )
}

function emitTs(ts: Technique[]): string {
  const rows = ts.map(
    (t, i) =>
      `  /** ${i} — ${t.hint} */\n` +
      `  { id: '${t.id}', label: '${t.label}', hint: ${JSON.stringify(t.hint)},\n` +
      `    clickCount: ${t.clicks.length}, clickWidthMs: ${t.clickWidthMs}, ` +
      `strokeShape: '${t.strokeShape}',\n` +
      `    restOpen: ${t.strokeRest[0] === 'open'}, span: ${t.span}, periodBeats: ${t.periodBeats} },`,
  )
  return (
    BANNER('scratch:check') +
    `\n/** A scratch technique, as the UI needs it. THE INDEX IS THE WIRE: the engine's\n` +
    ` *  kSlScratchTechniques is emitted from the same authority in the same order, so\n` +
    ` *  \`sl_tape_scratch_start\` takes the position of an entry in this array. */\n` +
    `export interface ScratchTechnique {\n` +
    `  readonly id: string\n` +
    `  readonly label: string\n` +
    `  readonly hint: string\n` +
    `  readonly clickCount: number\n` +
    `  readonly clickWidthMs: number\n` +
    `  readonly strokeShape: 'sine' | 'asymmetric'\n` +
    `  /** Whether the fader RESTS open on the forward stroke — an open-fader\n` +
    `   *  technique is one whose direction change is heard. */\n` +
    `  readonly restOpen: boolean\n` +
    `  readonly span: number\n` +
    `  readonly periodBeats: number\n` +
    `}\n` +
    `\nexport const SCRATCH_TECHNIQUES: readonly ScratchTechnique[] = [\n` +
    rows.join('\n') +
    `\n] as const\n`
  )
}

const check = process.argv.includes('--check')
try {
  const ts = parse()
  const outputs: Array<[string, string]> = [
    [incPath, emitInc(ts)],
    [tsPath, emitTs(ts)],
  ]
  if (check) {
    for (const [path, text] of outputs) {
      if (!existsSync(path)) {
        console.error(`scratch:check FAILED — ${path} does not exist; run npm run scratch:generate`)
        process.exit(1)
      }
      if (readFileSync(path, 'utf8') !== text) {
        console.error(`scratch:check FAILED — ${path} is stale.`)
        console.error('slengine/scratch-techniques.json changed; run npm run scratch:generate and review the diff.')
        process.exit(1)
      }
    }
    console.log(`scratch:check OK — ${ts.length} techniques, both mirrors in sync`)
  } else {
    for (const [path, text] of outputs) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      console.log(`wrote ${path}`)
    }
  }
} catch (e) {
  if (e instanceof GenerationRefused) {
    console.error('REFUSED to generate the scratch technique table:')
    console.error('  ' + e.message)
    process.exit(1)
  }
  throw e
}
