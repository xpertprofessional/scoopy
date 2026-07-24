// Turns the spike's probe log into the verdict table.
//
//   node spike/summarize-probe.mjs [path]        (default ~/wizard-spike-probe.jsonl)
//
// The log is JSONL because the run appends across two windows concurrently and
// a partial line must never destroy the whole record.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const path = process.argv[2] ?? join(homedir(), 'wizard-spike-probe.jsonl')
const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const of = (kind) => rows.filter((r) => r.payload?.kind === kind)
// A window is one that BOOTED. Deriving this from distinct log sources instead
// would count the `slParam/<panel>` records as windows of their own and report
// twice as many as exist — which read as a multi-window failure.
const panels = [...new Set(of('boot').map((r) => r.source))]

const verdict = (ok, unknown = false) => (unknown ? 'NEEDS HUMAN' : ok ? 'PASS' : 'FAIL')
const line = (q, name, v, detail) =>
  console.log(`${q.padEnd(4)} ${name.padEnd(22)} ${v.padEnd(12)} ${detail}`)

console.log(`\nspike probe — ${path}`)
console.log(`windows: ${panels.join(', ')}  ·  records: ${rows.length}\n`)
console.log('Q    QUESTION                VERDICT      EVIDENCE')
console.log('-'.repeat(96))

// Boot — not one of the four questions, but everything below is worthless if
// the real bundle did not mount against a real backend.
const boots = of('boot')
const booted = boots.filter((b) => b.payload.hasJuceBackend && b.payload.rootChildren > 0)
line('Q0', 'bundle + backend', verdict(booted.length === boots.length && boots.length > 0),
  boots.map((b) => `${b.source}: backend=${b.payload.hasJuceBackend} reactRoots=${b.payload.rootChildren}`).join(' · '))

// Q1 — key fidelity. Only real keystrokes can answer it.
const keys = of('keydown')
const repeats = keys.filter((k) => k.payload.repeat)
const codesOk = keys.length > 0 && keys.every((k) => typeof k.payload.code === 'string' && k.payload.code.length > 0)
const ups = of('keyup')
line('Q1', 'key-event fidelity', verdict(codesOk && ups.length > 0, keys.length === 0),
  keys.length === 0
    ? 'no keystrokes captured — press keys in the window during the run'
    : `${keys.length} keydown (${repeats.length} repeat) / ${ups.length} keyup · codes=${[...new Set(keys.map((k) => k.payload.code))].slice(0, 8).join(',')}`)

// Q2 — multi-window. Two DocumentWindows, each a live independent page.
const lanes = of('lanes')
// Judged PER DISTINCT WINDOW, not by record count: a page that reloads boots
// again and reports its lanes again, and counting records would read that as a
// window that failed to start. Reloads are reported separately because they are
// a finding in their own right, not noise to smooth over.
const liveByPanel = new Map()
for (const l of lanes)
  liveByPanel.set(l.source, Math.max(liveByPanel.get(l.source) ?? 0, l.payload.slHotFrame))
const multi = panels.length > 1 && [...liveByPanel.values()].filter((n) => n > 0).length === panels.length
const reloads = of('boot').length - panels.length
line('Q2', 'multi-window', verdict(multi),
  `${panels.length} windows · ${[...liveByPanel].map(([p, n]) => `${p}: ${n} hotframes`).join(' · ')}` +
  (reloads > 0 ? `  ⚠ ${reloads} page reload(s) — see below` : ''))

// Q3 — drag-in. Which SIDE receives the drop is the answer, so both are logged.
const webDrop = of('web-drop')
const nativeDrop = of('native-filesDropped')
line('Q3', 'file drag-in', verdict(webDrop.length + nativeDrop.length > 0, webDrop.length + nativeDrop.length === 0),
  webDrop.length + nativeDrop.length === 0
    ? 'no drop captured — drag an audio file onto the window during the run'
    : `web-side drops=${webDrop.length} (files: ${webDrop.flatMap((d) => d.payload.files).join(',') || 'none'}) · native-side drops=${nativeDrop.length}`)

// Q4 — OPFS. Main thread and worker are different answers to different questions.
const opfs = of('opfs')
const opfsW = of('opfs-worker')
const opfsOk = opfsW.length > 0 && opfsW.every((o) => o.payload.syncWrote)
line('Q4', 'OPFS', verdict(opfsOk),
  `api=${opfs[0]?.payload.hasApi} mainThreadWrite=${opfs[0]?.payload.wrote} workerSyncWrite=${opfsW.map((o) => o.payload.syncWrote).join('/')}`)

console.log('-'.repeat(96))

// The JuceLink contract, lane by lane — the spike's core deliverable.
console.log('\nJuceLink lanes (per window):')
for (const l of lanes) {
  const p = l.payload
  console.log(`  ${l.source.padEnd(8)} slHotFrame=${String(p.slHotFrame).padStart(4)} (len ${p.firstFrameLen}, counter ${p.lastFrameCounter})  slEvent=${p.slEvent} (${p.eventType})  slUiState=${p.slUiState} (${p.uiStateTopic})`)
}
const params = rows.filter((r) => r.source.startsWith('slParam/'))
console.log(`  slParam (web→native): ${params.length} write(s) received${params[0] ? ' · ' + JSON.stringify(params[0].payload) : ''}`)
const cmds = {}
for (const r of rows.filter((r) => r.payload?.kind === 'slCommand')) cmds[r.payload.method] = (cmds[r.payload.method] ?? 0) + 1
console.log(`  slCommand (web→native): ${Object.entries(cmds).map(([m, n]) => `${m}×${n}`).join(', ') || 'none'}`)

// A reload mid-run means the page navigated away and came back — the webview
// left the app. Correlated against drops because an unprevented file drop is
// the known way to cause it.
if (reloads > 0) {
  console.log(`\n⚠ ${reloads} page reload(s) during the run:`)
  const order = rows.map((r, i) => ({ r, i }))
  const seen = new Set()
  for (const { r, i } of order) {
    if (r.payload?.kind !== 'boot') continue
    if (!seen.has(r.source)) { seen.add(r.source); continue }
    const prior = order.slice(0, i).reverse()
      .find(({ r: p }) => String(p.payload?.kind).includes('drop') && p.source === r.source)
    console.log(`  [${r.source}] rebooted` +
      (prior ? ` — ${i - prior.i} records after a ${prior.r.payload.kind} of ${JSON.stringify(prior.r.payload.files ?? [])}` : ''))
  }
}

// The navigation guard (the Q3 defect's fix). Reported whether or not a drop
// happened, because the guard is what stops a drop from taking the shell away
// from the app — and a guard that quietly stopped working would otherwise look
// exactly like a run where nobody dragged anything.
const refused = of('nav-REFUSED')
const guard = of('nav-guard')
if (guard.length > 0 || refused.length > 0) {
  const held = guard.length > 0 && guard.every((g) => g.payload.survived && g.payload.rootsAfter > 0)
  console.log(`\nnavigation guard: ${guard.length > 0 ? (held ? 'HOLDS' : 'LEAKED') : 'untested'}` +
    ` · ${refused.length} refused, ${of('nav-allowed').length} allowed`)
  for (const r of refused.slice(0, 5)) console.log(`  refused [${r.source}] ${r.payload.url}`)
  if (guard.length > 0 && !held)
    console.log('  ⚠ a probe navigation SUCCEEDED — the shell can be navigated away from the app')
}

const errs = [...of('pageerror'), ...of('rejection')]
console.log(`\npage errors / unhandled rejections: ${errs.length}`)
for (const e of errs.slice(0, 10)) console.log(`  [${e.source}] ${e.payload.message ?? e.payload.reason}`)
console.log()
