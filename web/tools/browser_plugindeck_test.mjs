/**
 * SCOOPY DECK's layout, MEASURED — the gate this face kept needing.
 *
 * The plugin face is built out of PLANE pieces (`DeckFace`, `GridScenes`,
 * `.compose-window-body`) and every one of them assumes the geometry a strip
 * would have given it. Mounted anywhere else they do not error, they do not
 * fail a unit test, and they do not look wrong in a snapshot — they resolve
 * their `height: 100%` and `flex: 1 1 auto` against whatever ancestor happens
 * to be there. Three separate regressions shipped that way, each found only by
 * a person opening the plugin in a DAW and sending a screenshot:
 *
 *   1. FILES stacked UNDER the grid — `.compose-window-body` (the flex ROW)
 *      had been dropped, so the drawer had nothing putting it beside anything.
 *   2. The grid stretched past the bottom of the window — `.strip-deckface`
 *      needs a bounded flex COLUMN parent, and without one `GridPanel` falls
 *      back to sizing itself as a window root at 100vh.
 *   3. The scene pads swallowed the ENTIRE UI — `.strip-scenes` is
 *      `height: 100%` because in a strip it fills the wave field's rect.
 *
 * All three are questions only a layout engine can answer, which is why they
 * belong here and not in vitest. Same species as browser_plane_test.mjs.
 *
 *   node tools/browser_plugindeck_test.mjs [dist]
 */
import { openEngine } from './lib/engines.mjs'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const dist = process.argv[2] ?? 'dist'
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
}

const failures = []
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  let p = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!existsSync(p)) p = join(dist, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
  res.end(readFileSync(p))
})
await new Promise((r) => server.listen(4601, r))

const { browser, cleanup } = await openEngine()
// A plugin window, not a desktop: roughly what a DAW gives an instrument.
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

// `?host=browser` so the face boots without a native bridge; the LAYOUT is the
// same either way, which is the whole point — the geometry does not depend on
// which host is answering.
await page.goto('http://localhost:4601/?panel=plugindeck&host=browser')
// It creates a session on boot before it renders anything, so this waits on
// the real ready state rather than a fixed guess.
await page
  .waitForSelector('.plugin-deck-scenes', { timeout: 15000 })
  .catch(() => {})
await page.waitForTimeout(800)

const m = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      left: Math.round(r.left),
      right: Math.round(r.right),
    }
  }
  return {
    fatalBlocks: document.querySelectorAll('.fatal-error').length,
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    root: box('.compose-window'),
    bar: box('.compose-window-bar'),
    scenes: box('.plugin-deck-scenes'),
    pads: document.querySelectorAll('.plugin-deck-scenes .strip-pad:not(.strip-pad-add)').length,
    padW: (() => {
      const p = document.querySelector('.plugin-deck-scenes .strip-pad')
      return p ? Math.round(p.getBoundingClientRect().width) : null
    })(),
    body: box('.compose-window-body'),
    pane: box('.plugin-deck-pane'),
    deckface: box('.strip-deckface'),
    files: box('.compose-files'),
    grid: box('.grid-panel'),
    // Rows that must exist for the deck to be operable at all.
    rows: {
      toolbar: box('.deckrow-toolbar'),
      sync: box('.deckrow-sync'),
      scene: box('.deckrow-scene'),
      view: box('.deckrow-view'),
    },
    // Does anything overflow the window? A control pushed below the fold in a
    // plugin is simply unreachable — there is no page to scroll.
    docScrollH: document.documentElement.scrollHeight,
  }
})

check('no unhandled rejections on boot', m.fatalBlocks === 0, `${m.fatalBlocks} error block(s)`)
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
check('the face mounted', m.root !== null, 'no .compose-window')

// ── REGRESSION 3: the pads must be a ROW, not the whole window ──────────────
check('scene row exists', m.scenes !== null, 'no .plugin-deck-scenes')
// Bounded on BOTH sides, and tightly. The first cut allowed 20…80 and a
// negative test showed it happily passing a row COLLAPSED to 24 px — pads that
// are technically present and practically unhittable. The row is 56 px by
// design; the band is only wide enough for font/DPI variation.
check(
  'scene row is a row — neither collapsed nor swallowing the window',
  m.scenes !== null && m.scenes.h >= 44 && m.scenes.h <= 72,
  `h=${m.scenes?.h}, expected ~56 (viewport ${m.viewportH})`,
)
// The pads must be TALLER than the deck rows they sit above (they are the
// performance surface) and each wide enough to hit.
check(
  'each pad is big enough to hit',
  m.padW !== null && m.padW >= 40,
  `pad width ${m.padW}`,
)
check('all eight scene pads render', m.pads === 8, `${m.pads} pads`)

// ── REGRESSION 1: FILES BESIDE the grid, not under it ──────────────────────
check('files drawer exists', m.files !== null, 'no .compose-files')
check(
  'files sits BESIDE the deck, not below it',
  m.files !== null && m.pane !== null && m.files.left >= m.pane.right - 2,
  `files.left=${m.files?.left} pane.right=${m.pane?.right}`,
)

// ── REGRESSION 2: the deck must FIT, not size itself to the viewport ───────
check('deck pane exists', m.pane !== null, 'no .plugin-deck-pane')
check(
  'the deck face fits inside the window',
  m.deckface !== null && m.root !== null && m.deckface.bottom <= m.root.bottom + 2,
  `deckface.bottom=${m.deckface?.bottom} root.bottom=${m.root?.bottom}`,
)
check(
  'the grid does not size itself to the viewport',
  m.grid !== null && m.grid.h <= m.viewportH,
  `grid.h=${m.grid?.h} viewport=${m.viewportH}`,
)
check(
  'nothing overflows the window',
  m.docScrollH <= m.viewportH + 2,
  `scrollHeight=${m.docScrollH} viewport=${m.viewportH}`,
)

// ── The deck rows are the controls; a missing one is a dead deck ───────────
for (const [name, b] of Object.entries(m.rows))
  check(`deck row "${name}" is present and has height`, b !== null && b.h > 0, JSON.stringify(b))

await cleanup()
server.close()

// PRINT THE NUMBERS. A layout gate whose output is only "OK" cannot be
// distinguished from one whose selectors quietly stopped matching anything —
// which is exactly what this run looked like against a stale bundle.
console.log(
  `  window ${m.viewportW}×${m.viewportH} · scenes h=${m.scenes?.h} (${m.pads} pads) · ` +
    `deck pane ${m.pane?.w}×${m.pane?.h} · files w=${m.files?.w} at x=${m.files?.left} · ` +
    `grid h=${m.grid?.h} · rows ${Object.entries(m.rows)
      .map(([k, v]) => `${k}=${v?.h}`)
      .join(' ')}`,
)

if (failures.length) {
  console.error('browser_plugindeck_test FAILED:')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('browser_plugindeck_test OK — scene row, deck rows, grid and FILES all in their boxes')
