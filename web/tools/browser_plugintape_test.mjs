/**
 * SCOOPY TAPE's layout, MEASURED — the one requirement most easily lost.
 *
 * The brief for this plugin is "the UI needs to be centered around the display
 * so we have enough ground to do more precise scrubbing." That is a LAYOUT
 * claim, and layout claims are exactly what vitest cannot answer and what a
 * snapshot will happily agree with while being wrong. The deck's face shipped
 * three geometry regressions found only by a person opening a DAW; this gate
 * exists so this face does not repeat that.
 *
 * The claims:
 *   1. The wave field is the ONLY flexible box — it takes the remainder, and
 *      every other child sits at the one control height. A row added later
 *      that steals the remainder fails here rather than in someone's session.
 *   2. The field is genuinely LARGE (a majority of the window), because a 48px
 *      lane is a strip on the plane, not this product.
 *   3. Nothing overflows the window horizontally or vertically (L1: the box is
 *      authoritative; a narrow row scrolls, it never wraps).
 *   4. The transport speaks the four glyphs ⟳ ▸ ↻ ◼ and NOT the ■/▶ dialect.
 *   5. There are 8 slot pads — A4's snapshot bank, which is also the line's
 *      "Scoopy plugin signature" count.
 *   6. The canvas backing store is at DEVICE resolution, not CSS pixels. This
 *      is the §4 contract stated early: "a blurry ruler reads as a broken one."
 *
 *   node tools/browser_plugintape_test.mjs [dist]
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
await new Promise((r) => server.listen(4602, r))

const { browser, cleanup } = await openEngine()
// The editor's own default (ScoopyTapeEditor): wider than tall, because a
// waveform wants horizontal ground more than it wants height.
const page = await browser.newPage({ viewport: { width: 900, height: 420 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

// `?host=browser` so the face boots with no native bridge. The LAYOUT does not
// depend on which host answers, which is the whole point of measuring it here.
// ⚠️ The engine-backed behaviour deliberately is NOT asserted: slTape is a
// NATIVE method, so in this host it reaches BrowserLink and answers nothing.
// The box is the claim; the sound is owed a real-host check.
await page.goto('http://localhost:4602/?panel=plugintape&host=browser')
await page.waitForSelector('.plugin-tape-field', { timeout: 20000 })
await page.waitForTimeout(600)

const m = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }
  }
  const canvas = document.querySelector('.plugin-tape-field canvas')
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    pane: box('.plugin-tape-pane'),
    field: box('.plugin-tape-field'),
    bars: [...document.querySelectorAll('.plugin-tape-bar')].map((e) => {
      const r = e.getBoundingClientRect()
      return { h: Math.round(r.height), top: Math.round(r.top) }
    }),
    slots: box('.plugin-tape-slots'),
    pads: document.querySelectorAll('.plugin-tape-slots .ds-button').length,
    glyphs: [...document.querySelectorAll('.plugin-tape-bar .ds-button')].map((e) =>
      e.textContent.trim(),
    ),
    canvas: canvas
      ? {
          cssW: Math.round(canvas.getBoundingClientRect().width),
          cssH: Math.round(canvas.getBoundingClientRect().height),
          bufW: canvas.width,
          bufH: canvas.height,
          dpr: window.devicePixelRatio || 1,
        }
      : null,
    // L1: the window itself must never scroll.
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    ranges: document.querySelectorAll('.plugin-tape-bar .ds-geo').length,
    // Rule 7 evidence: nothing disabled is on screen, because unbuilt verbs are
    // ABSENT here rather than drawn inert.
    disabled: document.querySelectorAll('.plugin-tape-pane [disabled]').length,
  }
})

check('the pane exists', !!m.pane, JSON.stringify(m))
check('the wave field exists', !!m.field, JSON.stringify(m.field))

// 1 + 2 — the display is the product.
const rowsH = m.bars.reduce((a, b) => a + b.h, 0) + (m.slots?.h ?? 0)
check(
  'the field is the biggest box on screen',
  m.field && m.field.h > rowsH,
  `field h=${m.field?.h} vs rows total ${rowsH}`,
)
check(
  'the field takes the majority of the window',
  m.field && m.field.h > m.viewportH * 0.5,
  `field h=${m.field?.h} of ${m.viewportH}`,
)
check(
  'the field is far taller than the plane strip lane it came from (48px)',
  m.field && m.field.h > 48 * 2,
  `field h=${m.field?.h}`,
)

// The rows stay at the one control height — they must NOT have absorbed slack.
for (const [i, b] of m.bars.entries())
  check(`row ${i} sits at the control height, not stretched`, b.h <= 28, `h=${b.h}`)

// 3 — L1.
check('the window does not scroll horizontally', m.scrollW <= m.viewportW, `${m.scrollW}`)
check('the window does not scroll vertically', m.scrollH <= m.viewportH + 1, `${m.scrollH}`)

// 4 — the transport vocabulary (DESIGN.md §3).
for (const g of ['⟳', '▸', '↻', '◼'])
  check(`the transport carries ${g}`, m.glyphs.includes(g), JSON.stringify(m.glyphs))
check(
  'and NOT the ■/▶ dialect',
  !m.glyphs.some((g) => g === '■' || g === '▶'),
  JSON.stringify(m.glyphs),
)
check('REC is reachable', m.glyphs.includes('REC'), JSON.stringify(m.glyphs))

// 5 — the snapshot bank.
check('there are 8 slot pads', m.pads === 8, `pads=${m.pads}`)

// 6 — the canvas truth contract, asserted from day one so §4 inherits it green.
check(
  'the canvas backing store is at DEVICE resolution',
  m.canvas && m.canvas.bufW === Math.round(m.canvas.cssW * m.canvas.dpr),
  JSON.stringify(m.canvas),
)
check(
  'the canvas fills the field it was measured into',
  m.canvas && Math.abs(m.canvas.cssH - (m.field?.h ?? 0)) <= 2,
  `canvas ${m.canvas?.cssH} vs field ${m.field?.h}`,
)

// Both parameter controls are GeoRange, never a bare range (DESIGN.md §1).
check('LEVEL and RATE are GeoRanges', m.ranges === 2, `ds-geo count=${m.ranges}`)
check(
  'nothing inert is on screen — unbuilt verbs are absent, not disabled',
  m.disabled === 0,
  `disabled=${m.disabled}`,
)

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

await cleanup()
server.close()

// PRINT THE NUMBERS: a layout gate whose output is only "OK" cannot be told
// apart from one whose selectors quietly stopped matching anything.
console.log(
  `  window ${m.viewportW}×${m.viewportH} · field ${m.field?.w}×${m.field?.h} ` +
    `(rows total ${rowsH}) · canvas ${m.canvas?.cssW}×${m.canvas?.cssH} css → ` +
    `${m.canvas?.bufW}×${m.canvas?.bufH} buf @${m.canvas?.dpr}x · ` +
    `${m.pads} slots · transport ${m.glyphs.join(' ')}`,
)

if (failures.length) {
  console.error('browser_plugintape_test FAILED:')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('browser_plugintape_test OK — the display is the product, and it is at device resolution')
