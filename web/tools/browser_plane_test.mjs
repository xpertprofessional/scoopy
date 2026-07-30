/**
 * The plane's layout, MEASURED (merge P2 step 4).
 *
 * `Strip.test.tsx` asserts which elements exist; nothing asserted how big they
 * are, and the strip's whole design rests on a pixel budget that closes exactly
 * at 340 × 196 (wizard docs/archive/pd-strip-anatomy.md §4.1). A CSS change that
 * puts one row a few pixels over does not fail any unit test — it silently
 * pushes the last row out of a box with `overflow: hidden`, and the control is
 * simply gone.
 *
 * So this drives the BUILT bundle in a real engine and measures bounding boxes.
 * It is the same species as the other browser_*_test.mjs harnesses here: a
 * headless check for the things only a layout engine can answer.
 *
 *   node tools/browser_plane_test.mjs [dist]
 */
import { openEngine } from "./lib/engines.mjs"
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
await new Promise((r) => server.listen(4599, r))

const { browser, cleanup } = await openEngine()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

await page.goto('http://localhost:4599/?panel=plane')
await page.waitForTimeout(500)
await page.click('.plane-add')
await page.waitForTimeout(400)

const m = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) }
  }
  const strip = document.querySelector('.plane-strip')
  return {
    fatalBlocks: document.querySelectorAll('.fatal-error').length,
    strip: box('.plane-strip'),
    kindbar: box('.strip-kindbar'),
    head: box('.strip-head'),
    wavefield: box('.strip-wavefield'),
    meter: box('.strip-meter'),
    transport: box('.strip-transport'),
    rec: box('.strip-rec'),
    mon: box('.strip-mon button'),
    // How much room is left between the switches group's right edge and the
    // transport row's. A control that overruns here is not "slightly wrong":
    // the strip is `overflow: hidden`, so it is simply GONE — which is exactly
    // how a 1px border deleted the rate control in increment 1.
    switchesSlack: (() => {
      const sw = document.querySelector('.strip-switches')
      const tr = document.querySelector('.strip-transport')
      if (!sw || !tr) return null
      return Math.round(tr.getBoundingClientRect().right - sw.getBoundingClientRect().right)
    })(),
    status: box('.strip-status'),
    out: box('.strip-out'),
    rows: [...document.querySelectorAll('.plane-strip .strip-row')].map((el) =>
      Math.round(el.getBoundingClientRect().height),
    ),
    // Does the content actually FIT the box, or is the last row being clipped?
    // IN-FLOW children only: the kind bar is absolutely positioned to the full
    // height by design, so including it would measure the box against itself
    // and the check would pass no matter how far the rows overran.
    contentBottom: strip
      ? Math.round(
          Math.max(
            ...[...strip.children]
              .filter((c) => getComputedStyle(c).position !== 'absolute')
              .map((c) => c.getBoundingClientRect().bottom),
          ) - strip.getBoundingClientRect().top,
        )
      : null,
    padBottom: strip ? parseFloat(getComputedStyle(strip).paddingBottom) : null,
    // The plane must own the window regardless of what is prepended to <body>.
    panelPos: getComputedStyle(document.querySelector('.plane-panel')).position,
  }
})

// THE BUDGET (pd-strip-anatomy §4.1). Each of these is a row that must not move.
check('no unhandled rejections on boot', m.fatalBlocks === 0, `${m.fatalBlocks} error block(s)`)
check('strip box is 340 × 196', m.strip?.w === 340 && m.strip?.h === 196, JSON.stringify(m.strip))
check('kind bar is 3px and full height', m.kindbar?.w === 3, JSON.stringify(m.kindbar))
check('head row is 16px', m.head?.h === 16, JSON.stringify(m.head))
check('wave field is 308 × 48', m.wavefield?.w === 308 && m.wavefield?.h === 48, JSON.stringify(m.wavefield))
check('meter is 10 × 48', m.meter?.w === 10 && m.meter?.h === 48, JSON.stringify(m.meter))
check('transport row is 22px', m.transport?.h === 22, JSON.stringify(m.transport))
check('REC is 56 × 22 and dominates', m.rec?.w === 56 && m.rec?.h === 22, JSON.stringify(m.rec))
// MON (the split tap, P2-5). It carries a WORD rather than a glyph, so it is
// the one control in this row wide enough to push the group off the end.
check('MON is 34 × 22 — wide enough for the word', m.mon?.w === 34 && m.mon?.h === 22, JSON.stringify(m.mon))
check(
  'the switches group still fits the transport row',
  typeof m.switchesSlack === 'number' && m.switchesSlack >= 0,
  `slack ${m.switchesSlack}px`,
)
check('the OUT chip is present and does not grow the head', m.out !== null && m.head?.h === 16, JSON.stringify(m.out))
check('status line is a reserved 12px', m.status?.h === 12, JSON.stringify(m.status))
check('three param rows at 18px', m.rows.length === 3 && m.rows.every((h) => h === 18), JSON.stringify(m.rows))
// The budget closing is the whole claim: content must fit inside 196 with the
// 8px bottom padding, or `overflow: hidden` eats the last row.
check('content fits the box', m.contentBottom !== null && m.contentBottom <= 196 - 8, `bottom=${m.contentBottom}`)
check('panel is fixed to the window', m.panelPos === 'fixed', m.panelPos)
check('no page errors', pageErrors.length === 0, pageErrors[0])

// ── A GRID STRIP IS THE SAME OBJECT ──────────────────────────────────────────
// The one-species claim, measured. A grid strip swaps what fills the wave rect
// and the last param row; if it were a different SIZE the claim would be false
// on sight, and the box would clip whichever row overran.
await page.evaluate(() => {
  const st = window.__planeStore
  if (!st) return
  st.setState((s) => ({
    map: {
      ...s.map,
      strips: s.map.strips.map((x) => ({
        ...x,
        // SYNCED, so the tempo mode renders in its lit state — that is the one
        // that has to fit, since it is the state a performing strip is in.
        element: {
          kind: 'grid',
          deck: 0,
          sessionId: 'test',
          bpm: 120,
          syncToMaster: true,
          tempoMode: 'timeStretch',
          pulseRelation: 'auto',
          transpose: 0,
        },
      })),
    },
  }))
})
await page.waitForTimeout(300)

const g = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  const strip = document.querySelector('.plane-strip')
  return {
    strip: box('.plane-strip'),
    scenefield: box('.strip-scenefield'),
    pads: document.querySelectorAll('.strip-pad').length,
    gridrow: box('.strip-gridrow'),
    tempomode: box('.strip-tempomode'),
    // Does the control row OVERFLOW its own width? The vertical budget has
    // always been checked; the horizontal one only became a risk when P3-2 put
    // a fourth control (the tempo mode) into an 18 px row that already held
    // SYNC, a number box and COMPOSE. A row that overflows does not grow the
    // box — it clips or wraps, which the height checks would not see.
    gridrowOverflow: (() => {
      const row = document.querySelector('.strip-gridrow')
      if (!row) return null
      const r = row.getBoundingClientRect()
      const last = [...row.children].map((c) => c.getBoundingClientRect().right)
      return Math.round(Math.max(...last) - r.right)
    })(),
    // Every row a TAPE strip has must still be here — presence never changes.
    rows: ['strip-kindbar','strip-head','strip-waverow','strip-meter','strip-transport','strip-rec','strip-status','strip-params']
      .filter((c) => !document.querySelector('.' + c)),
    contentBottom: strip
      ? Math.round(
          Math.max(
            ...[...strip.children]
              .filter((c) => getComputedStyle(c).position !== 'absolute')
              .map((c) => c.getBoundingClientRect().bottom),
          ) - strip.getBoundingClientRect().top,
        )
      : null,
  }
})

check('grid strip is the SAME 340 × 196 box', g.strip?.w === 340 && g.strip?.h === 196, JSON.stringify(g.strip))
check('scene field takes the wave rect exactly (308 × 48)', g.scenefield?.w === 308 && g.scenefield?.h === 48, JSON.stringify(g.scenefield))
check('all 8 scene pads fit at 340px', g.pads === 8, `${g.pads} pads`)
check('grid control row is 18px', g.gridrow?.h === 18, JSON.stringify(g.gridrow))
check('tempo mode button is 34 × 18', g.tempomode?.w === 34 && g.tempomode?.h === 18, JSON.stringify(g.tempomode))
check('grid control row does not overflow its width', g.gridrowOverflow !== null && g.gridrowOverflow <= 0, `overflow=${g.gridrowOverflow}px`)
check('grid strip keeps every row a tape strip has', g.rows.length === 0, `missing: ${g.rows.join(', ')}`)
check('grid content fits the box', g.contentBottom !== null && g.contentBottom <= 196 - 8, `bottom=${g.contentBottom}`)

// ── RIGHT-CLICK ON A STRIP OPENS THE STRIP'S MENU ───────────────────────────
//
// ⚠️ A REAL BUTTON-2 GESTURE, and it has to be. The plane's `onPointerDown` ran
// for every button and called `setPointerCapture` on pointer-DOWN, which
// suppresses the browser's `contextmenu` event — so every right-click on a strip
// was swallowed before the header's handler could see it, and the desktop app
// showed the WebView's native "Reload" menu instead.
//
// It hid because a SYNTHETIC `dispatchEvent('contextmenu')` opens the menu fine
// (there is no pointer sequence to capture), so the handler tested as working
// while the real gesture never fired. Anything less than a true mouse press here
// re-admits the bug.
//
// What it cost: the strip header's menu is the ONLY route to loading a scoopy
// session, which is the only route to a grid deck — and every control P3-1 and
// P3-2 built lives on a grid strip. This one line of missing button-guard made
// two phases of work unreachable.
{
  // THE VISIBLE DOOR FIRST. Right-click is the fast path, but it is a gesture a
  // HOST CAN SWALLOW — the JUCE WKWebView did, which made the session-load menu
  // (and therefore every grid control) unreachable in the shipped app while
  // every gate here stayed green. The only route to a feature may not depend on
  // it, so the `⋯` button is what this checks first.
  await page.click('.strip-menu')
  await page.waitForTimeout(250)
  const byButton = await page.evaluate(() => document.querySelector('[role="menu"]')?.textContent ?? null)
  check('the ⋯ button opens the strip menu', byButton !== null, 'no [role=menu] after clicking .strip-menu')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)

  const head = await page.locator('.strip-head').first().boundingBox()
  await page.mouse.click(head.x + head.width / 2, head.y + head.height / 2, { button: 'right' })
  await page.waitForTimeout(250)
  const menu = await page.evaluate(() => document.querySelector('[role="menu"]')?.textContent ?? null)
  check('right-click on a strip opens the app menu', menu !== null, 'no [role=menu] after button-2')
  // The section that names the grid gesture must be THERE even with an empty
  // library — it used to render only when sessions existed, so an empty library
  // silently removed the only hint that sessions are how a deck arrives.
  check('the menu names the session gesture', !!menu && /load a session/.test(menu), menu?.slice(0, 120))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)

  // And the PRIMARY button must still drag, or the guard traded one bug for another.
  const before = await page.evaluate(() => document.querySelector('.plane-strip').getBoundingClientRect().left)
  await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2)
  await page.mouse.down()
  await page.mouse.move(head.x + 200, head.y + 40, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const after = await page.evaluate(() => document.querySelector('.plane-strip').getBoundingClientRect().left)
  // THAT it moved, not how far: the plane snaps placement to a grid, so the
  // distance is quantised and asserting a magnitude would be asserting the
  // snap size. Zero movement is the regression (the guard suppressing the drag
  // it was only supposed to suppress for button 2).
  check('left-drag still moves a strip', after !== before, `${Math.round(before)} -> ${Math.round(after)}`)
}

// ── THE CABLE LAYER ─────────────────────────────────────────────────────────
// A fresh plane draws ZERO cables — the 40 boot routes are all terminal, so
// every cable you see is one you made. Then one strip→strip route must produce
// exactly one, BEHIND the strips and click-through everywhere except the path.
const c = await page.evaluate(() => {
  const st = window.__planeStore
  const before = document.querySelectorAll('.plane-cable').length
  st.setState((s) => ({
    map: {
      ...s.map,
      strips: [
        { ...s.map.strips[0], key: 'a', channel: 0, cell: { x: 0, y: 0, w: 340, h: 196 } },
        { ...s.map.strips[0], key: 'b', channel: 1, cell: { x: 600, y: 0, w: 340, h: 196 } },
      ],
      routes: [
        ...s.map.routes,
        { src: { kind: 'channelOut', index: 0, sub: null }, dst: { kind: 'channelIn', index: 1 }, gain: 1, feedback: false },
      ],
    },
  }))
  return { before }
})
await page.waitForTimeout(300)

const cable = await page.evaluate(() => {
  const svg = document.querySelector('.plane-cables')
  const line = document.querySelector('.plane-cable-line')
  const strip = document.querySelector('.plane-strip')
  return {
    count: document.querySelectorAll('.plane-cable').length,
    svgEvents: svg ? getComputedStyle(svg).pointerEvents : null,
    lineEvents: line ? getComputedStyle(line).pointerEvents : null,
    hitEvents: document.querySelector('.plane-cable-hit')
      ? getComputedStyle(document.querySelector('.plane-cable-hit')).pointerEvents
      : null,
    // The cable must paint BEHIND the strips: an instrument first, a diagram
    // second. Compared as rendered stacking, not as a class name.
    svgZ: svg ? getComputedStyle(svg).zIndex : null,
    stripZ: strip ? getComputedStyle(strip).zIndex : null,
    // The path must actually span the two strips, not collapse to a point.
    d: line?.getAttribute('d') ?? '',
  }
})

check('a fresh plane draws NO cables (boot defaults are terminal)', c.before === 0, `${c.before} cables`)
check('one strip→strip route draws exactly one cable', cable.count === 1, `${cable.count} cables`)
check('the cable sheet is click-through', cable.svgEvents === 'none', cable.svgEvents)
check('the visible line is click-through', cable.lineEvents === 'none', cable.lineEvents)
check('the hit stroke IS clickable', cable.hitEvents === 'stroke', cable.hitEvents)
check('the cable spans both strips', /^M 340 /.test(cable.d) && cable.d.includes('600'), cable.d.slice(0, 60))

// ── THE INSPECTOR ───────────────────────────────────────────────────────────
// Always visible, and NOT blank with nothing selected — 260 px of dead space
// teaches that the panel is usually useless. Selecting a strip must swap the
// content without changing the panel's width, or the plane resizes under the
// pointer every time you click something.
const insEmpty = await page.evaluate(() => {
  const el = document.querySelector('.plane-inspector')
  return {
    present: Boolean(el),
    w: el ? Math.round(el.getBoundingClientRect().width) : 0,
    title: document.querySelector('.ins-title')?.textContent ?? '',
    rows: document.querySelectorAll('.ins-rows .ins-row').length,
    planeW: Math.round(document.querySelector('.plane').getBoundingClientRect().width),
  }
})
check('the Inspector is always visible', insEmpty.present)
check('with nothing selected it shows the PLANE summary, not a blank', insEmpty.title === 'PLANE' && insEmpty.rows > 0, `"${insEmpty.title}" ${insEmpty.rows} rows`)

await page.click('.plane-strip')
await page.waitForTimeout(200)
const insSel = await page.evaluate(() => ({
  title: document.querySelector('.ins-title')?.textContent ?? '',
  w: Math.round(document.querySelector('.plane-inspector').getBoundingClientRect().width),
  planeW: Math.round(document.querySelector('.plane').getBoundingClientRect().width),
  hasRemove: Boolean(document.querySelector('.ins-remove')),
}))
check('selecting a strip swaps it to the STRIP view', insSel.title === 'STRIP', insSel.title)
check('the Inspector width does not change on select', insSel.w === insEmpty.w, `${insEmpty.w} → ${insSel.w}`)
check('…and neither does the plane, so nothing moves under the pointer', insSel.planeW === insEmpty.planeW, `${insEmpty.planeW} → ${insSel.planeW}`)
check('remove is in the Inspector, not on the object', insSel.hasRemove)

// ── THE MASTER SECTION ──────────────────────────────────────────────────────
const mst = await page.evaluate(() => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }
  return {
    present: Boolean(document.querySelector('.plane-master')),
    fader: box('.master-fader'),
    meter: box('.master-meter'),
    lamp: document.querySelector('.master-lamp')?.textContent ?? '',
    lampEngaged: document.querySelector('.master-lamp')?.classList.contains('engaged') ?? null,
    bpm: Boolean(document.querySelector('.plane-master input[type=number]')),
  }
})
check('the master section is in the bar', mst.present)
check('the master fader has real travel', (mst.fader?.w ?? 0) >= 100, JSON.stringify(mst.fader))
check('the output meter is present', mst.meter?.h === 10, JSON.stringify(mst.meter))
check('the limiter lamp is present and NOT engaged at rest', mst.lamp === 'LIM' && mst.lampEngaged === false, `"${mst.lamp}" engaged=${mst.lampEngaged}`)
check('master tempo is in the master section', mst.bpm)

// ── THE ROUTING LEDGER ──────────────────────────────────────────────────────
// Summoned on ⌘R, hides the boot wiring by default (40 rows of correct default
// wiring would bury the one cable you came here to find), and shows the render
// ORDER — the thing nothing else on the plane can show.
await page.keyboard.press('Meta+r')
await page.waitForTimeout(300)
const mx = await page.evaluate(() => {
  const t = document.querySelector('.plane-matrix')
  const rows = [...document.querySelectorAll('.plane-matrix-table tbody tr')]
  return {
    open: Boolean(t),
    rows: rows.length,
    defaultRows: rows.filter((r) => r.classList.contains('is-default')).length,
    order: document.querySelector('.plane-matrix-order')?.textContent ?? '',
    empty: document.querySelector('.plane-matrix-empty')?.textContent ?? '',
  }
})
check('⌘R summons the ledger', mx.open, 'not open')
check('default wiring is hidden by default', mx.defaultRows === 0, `${mx.defaultRows} default rows shown`)
// NOT checked here: the render order and the cable rows. Both come from the
// ENGINE (`slRouteList`), and this gate drives the built bundle in a plain
// browser where `createEngineLink()` correctly returns null. Asserting on them
// would either fail forever or force a fake engine into a LAYOUT gate. The
// engine-derived half is `plane_audio_test`'s job; this one owns what a layout
// engine can answer.
check(
  'with no engine it says so, rather than showing an empty table as fact',
  mx.rows === 0 && /no cables|nothing is patched|reading the engine/.test(mx.empty),
  `${mx.rows} rows · "${mx.empty}"`,
)

await page.keyboard.press('Escape')
await page.waitForTimeout(200)
const closed = await page.evaluate(() => !document.querySelector('.plane-matrix'))
check('Escape closes it', closed)

await cleanup()
server.close()

if (failures.length) {
  console.error('browser_plane_test FAILED:')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('browser_plane_test OK — tape and grid strips both close to 340 × 196')
