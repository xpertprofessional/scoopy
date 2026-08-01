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

// ── THE EMPTY BOOT IS A DOOR (real-host report, 2026-08-01) ────────────────
//
// The panel used to call `newSession()` here, and `createSession` ends in
// `saveSession` — so EVERY insert wrote a fresh `Untitled N` folder into the
// user's shared library ("open session shows loads of untitled"). It no longer
// creates anything: an instance with nothing to restore comes up empty, and
// that emptiness has to be a way IN rather than the broken-looking grid the
// auto-create was papering over.
//
// This host has no chunk to restore from, so the walk always takes that path —
// which makes it the natural place to prove it.
await page.waitForSelector('.compose-session-menu', { timeout: 20000 }).catch(() => {})
const emptyBoot = await page.evaluate(() => ({
  label: document.querySelector('main')?.getAttribute('aria-label') ?? '',
  says: /no session open/i.test(document.body.innerText),
  menu: !!document.querySelector('.compose-session-menu'),
  decks: document.querySelectorAll('.plugin-deck-scenes').length,
}))
check('a fresh instance boots with NO session', emptyBoot.decks === 0, JSON.stringify(emptyBoot))
check('…and says so, rather than showing an empty grid', emptyBoot.says)
check('…with the session menu right there', emptyBoot.menu)

// Now go in through that door: session ▾ → new. Everything below tests the
// ready face, exactly as before.
await page.click('.compose-session-menu')
await page.waitForSelector('.ds-menu-item', { timeout: 5000 })
const menuLabels = await page.evaluate(() =>
  [...document.querySelectorAll('.ds-menu-item')].map((e) => e.textContent.trim()),
)
check(
  'the menu carries IMPORT — a library you cannot add to from disk is not one',
  menuLabels.some((l) => l.startsWith('import')),
  JSON.stringify(menuLabels),
)
await page.evaluate(() => {
  const el = [...document.querySelectorAll('.ds-menu-item')].find(
    (e) => e.textContent.trim() === 'new',
  )
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await page.waitForSelector('.plugin-deck-scenes', { timeout: 20000 }).catch(() => {})
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

// ── PERF COMMITS (DECKPLUGIN v2 §1) ────────────────────────────────────────
//
// The layout checks above are geometry; this one is the DOOR. PERF toggled, the
// locator dragged, and NOTHING WAS WRITTEN — `setLocatorRange`/`setLocatorRepeat`
// were absent from `VERIFIABLE_TRACK_OPS`, so owner mode declined them and they
// fell through to `BrowserLink.trackEdit`'s bare `return { ok: true }`: accepted,
// discarded, no error anywhere. Every unit test stayed green the whole time,
// which is exactly why this assertion lives in a browser and reads the ROW.
//
// The readback is the row's own ⌊ start · length ⌉ boxes and its ↻ toggle — the
// controls a user looks at — not internal state. So this fails if the write path
// breaks OR if the write stops reaching the display.
const perfState = () =>
  page.evaluate(() => {
    const box = (i, slug) =>
      document.querySelector(`[data-focus-id$="track/${i}/${slug}"]`)?.textContent?.trim() ?? null
    const rows = []
    for (let i = 0; i < 8; i++) {
      const start = box(i, 'locstart')
      if (start === null) continue
      const tog = document.querySelectorAll('.trk-loc-group .trk-tog')[rows.length]
      rows.push({ i, start, len: box(i, 'loclen'), repeat: !!tog?.classList.contains('on') })
    }
    return rows
  })

const before = await perfState()
check('the deck has track rows with locator readouts', before.length > 0, `${before.length} rows`)

// ── PERF IS A POINTER MODE, AND LIVES WITH THE LIVE GESTURES ──────────────
//
// It briefly ALSO drove a reduced control density, derived from
// `meta.performActive`. Removed by user ruling (2026-08-01): "the PERF button
// was abused for view changes we did not request." PERF arms performative
// locator dragging and changes NOTHING about what is on screen — the view axis
// belongs to the COMPOSE/DECK switch, which you pick on purpose.
//
// It also moved OFF the view row, where it sat beside GRID (a real view
// toggle), onto the SYNC row beside BR and REV — the other live gestures that
// change what plays without editing the document.
const rowShape = () =>
  page.evaluate(() => ({
    controls: document.querySelectorAll(
      '.track-strips .ds-dragbox, .track-strips .ds-georange, .track-strips .trk-tog',
    ).length,
    gains: document.querySelectorAll('.track-strips [data-focus-id$="/gain"]').length,
    dj: document.querySelectorAll('.track-strips.density-dj').length,
    perfInSync: [...document.querySelectorAll('.deckrow-sync .dr')].filter(
      (b) => b.textContent.trim() === 'PERF',
    ).length,
    viewRow: [...document.querySelectorAll('.deckrow-view .dr')].map((b) => b.textContent.trim()),
    docScrollH: document.documentElement.scrollHeight,
    viewportH: window.innerHeight,
  }))
const shapeBefore = await rowShape()
check(
  'PERF lives on the SYNC row, with BR and REV',
  shapeBefore.perfInSync === 1,
  JSON.stringify(shapeBefore),
)
check(
  'the view row is GRID alone — PERF is not a view',
  JSON.stringify(shapeBefore.viewRow) === JSON.stringify(['GRID']),
  JSON.stringify(shapeBefore.viewRow),
)

const perfBtn = await page.$('.deckrow-sync .dr:has-text("PERF")')
check('the PERF control exists', perfBtn !== null)
if (perfBtn) {
  await perfBtn.click()
  await page.waitForTimeout(200)
  const latched = await page.evaluate(
    () =>
      [...document.querySelectorAll('.deckrow-sync .dr')]
        .find((b) => b.textContent.trim() === 'PERF')
        ?.classList.contains('latched') ?? false,
  )
  check('PERF latches when clicked', latched)
}

const shapeAfter = await rowShape()
// THE CLAIM: arming PERF changes the POINTER, not the picture. A control count
// that moved would mean the density coupling had come back.
check(
  'arming PERF hides NOTHING — it is not a view',
  shapeAfter.controls === shapeBefore.controls && shapeAfter.gains === shapeBefore.gains,
  `controls ${shapeBefore.controls}→${shapeAfter.controls}, gains ${shapeBefore.gains}→${shapeAfter.gains}`,
)
check(
  '…and does not change the row density either',
  shapeAfter.dj === shapeBefore.dj && shapeAfter.dj > 0,
  `dj ${shapeBefore.dj}→${shapeAfter.dj}`,
)

// The cells are drawn to a canvas, so a gate cannot address "step N" (the same
// limit browser_grid_test documents). It does not need to: the claim under test
// is "a PERF drag on a track row commits a window", not "it commits step 4". So
// sweep a few offsets down from the canvas top and take the first row that
// moves — then assert what that row now says.
let committed = null
if (m.grid) {
  const c = await page.evaluate(() => {
    const r = document.querySelector('.grid-static')?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y, w: r.width } : null
  })
  check('the cell canvas is present to drag on', c !== null)
  for (const dy of [22, 40, 60, 84, 110]) {
    if (committed || !c) break
    const y = c.y + dy
    await page.mouse.move(c.x + c.w * 0.2, y)
    await page.mouse.down()
    await page.mouse.move(c.x + c.w * 0.3, y, { steps: 6 })
    await page.mouse.move(c.x + c.w * 0.45, y, { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    const now = await perfState()
    const moved = now.find((r, k) => before[k] && (r.start !== before[k].start || r.len !== before[k].len))
    if (moved) committed = { ...moved, dy }
  }
}

check(
  'a PERF locator drag COMMITS — the row shows the new window',
  committed !== null,
  'no track row changed after dragging across the cell canvas in PERF',
)
check(
  'the committed window is a RANGE, not a single step',
  committed !== null && Number(committed.len) > 1,
  `len=${committed?.len}`,
)
// `engage: true` rides the same gesture — a dragged window arms the repeat, which
// is what makes the loop audible instead of merely drawn.
check(
  'the drag ENGAGES the locator repeat (↻ on)',
  committed !== null && committed.repeat === true,
  `repeat=${committed?.repeat}`,
)

// ── THE MASTER TEMPO IS TYPEABLE (DECKPLUGIN v2 §2 · D2) ───────────────────
//
// `masterBpm` was written ONLY from the host's `hostTransport` event and there
// was no control anywhere in the app to set one. So syncRatio sat at ~1 forever
// and TP / TS / T were indistinguishable — not because the modes were broken,
// but because there was nothing to stretch AGAINST. This asserts the two doors
// D2 signed: a TEMPO source switch separate from CLK, and a master-BPM box that
// is inert while the DAW owns the tempo and editable once you take it.
const bar = await page.evaluate(() => {
  const btn = (t) =>
    [...document.querySelectorAll('.compose-window-bar .dr')].find((b) =>
      b.textContent.trim().startsWith(t),
    )
  const box = document.querySelector('[data-focus-id$="plugin/masterBpm"]')
  return {
    clk: btn('CLK')?.textContent.trim() ?? null,
    tempo: btn('TEMPO')?.textContent.trim() ?? null,
    box: box ? { text: box.textContent.trim(), disabled: box.classList.contains('disabled') } : null,
  }
})

check('the CLK (transport) switch is present', bar.clk !== null, JSON.stringify(bar))
check('the TEMPO (master source) switch is present — D2 signed TWO switches', bar.tempo !== null)
check(
  'CLK and TEMPO are DIFFERENT controls, not one switch relabelled',
  bar.clk !== null && bar.tempo !== null && bar.clk !== bar.tempo,
  `clk=${bar.clk} tempo=${bar.tempo}`,
)
check('the master tempo box is present', bar.box !== null)
check(
  'the box starts on TEMPO HOST and is INERT — the DAW owns that number',
  bar.tempo === 'TEMPO HOST' && bar.box?.disabled === true,
  `tempo=${bar.tempo} disabled=${bar.box?.disabled}`,
)
// A disabled control must SAY WHY (DESIGN.md §6) — a dead end with no title is
// the defect, not the disabling.
const boxTitle = await page.evaluate(
  () => document.querySelector('[data-focus-id$="plugin/masterBpm"]')?.getAttribute('title') ?? '',
)
check(
  'the inert box explains its precondition',
  /TEMPO INT/.test(boxTitle),
  `title=${JSON.stringify(boxTitle)}`,
)

const tempoBtn = await page.$('.compose-window-bar .dr:has-text("TEMPO")')
if (tempoBtn) {
  await tempoBtn.click()
  await page.waitForTimeout(200)
}
const armed = await page.evaluate(() => {
  const box = document.querySelector('[data-focus-id$="plugin/masterBpm"]')
  const btn = [...document.querySelectorAll('.compose-window-bar .dr')].find((b) =>
    b.textContent.trim().startsWith('TEMPO'),
  )
  return {
    tempo: btn?.textContent.trim() ?? null,
    latched: btn?.classList.contains('latched') ?? false,
    disabled: box?.classList.contains('disabled') ?? null,
    text: box?.textContent.trim() ?? null,
  }
})
check(
  'TEMPO INT latches and hands the box over',
  armed.tempo === 'TEMPO INT' && armed.latched && armed.disabled === false,
  JSON.stringify(armed),
)

// …and the box actually WRITES. Drag it upward: a DragBox adjusts on vertical
// drag, so this is the same gesture a user makes, not a synthetic setState.
let moved = null
if (armed.disabled === false) {
  const r = await page.evaluate(() => {
    const b = document.querySelector('[data-focus-id$="plugin/masterBpm"]').getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  await page.mouse.move(r.x, r.y)
  await page.mouse.down()
  await page.mouse.move(r.x, r.y - 40, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  moved = await page.evaluate(
    () => document.querySelector('[data-focus-id$="plugin/masterBpm"]')?.textContent.trim() ?? null,
  )
}
check(
  'dragging the master tempo box CHANGES it',
  moved !== null && moved !== armed.text,
  `before=${armed.text} after=${moved}`,
)

// ── THE DECK'S MASTER SENDS EXIST (DECKPLUGIN v2 §3) ───────────────────────
//
// MasterRow has rendered this cluster since the mixer overhaul and it appeared
// on NO host, because `gridBackend.meta()` hard-coded `masterSends: []` — there
// was no plumbing for the values at all, which is a different bug from the
// capability one above it. Four faders, labelled, or the deck cannot reach the
// DAW's return tracks that D1 kept the buses for.
const sends = await page.evaluate(() => ({
  count: document.querySelectorAll('.mr-send').length,
  labels: [...document.querySelectorAll('.mr-send > .mono')].map((s) => s.textContent.trim()),
}))
check('the deck master sends render', sends.count === 4, `${sends.count} sends`)
check(
  'they are labelled S1…S4',
  JSON.stringify(sends.labels) === JSON.stringify(['S1', 'S2', 'S3', 'S4']),
  JSON.stringify(sends.labels),
)

// ── THE LCM BAR IS BIG ENOUGH TO READ (DECKPLUGIN v2 §6) ───────────────────
//
// `LcmBar` was mounted the whole time and reported missing, because `.strip-lcm`
// is `flex: 0 0 8px; overflow: hidden` — the plane's budget for a collapsed
// strip — with the "LCM" label hung at `top: -1px` INSIDE it. The label was
// clipped to a sliver and an 8px empty outline reads as nothing at all. A
// plugin has one deck and a resizable window; it can afford the pixels.
const lcm = await page.evaluate(() => {
  const bar = document.querySelector('.plugin-deck-pane .strip-lcm')
  const lab = document.querySelector('.plugin-deck-pane .strip-lcm-label')
  if (!bar || !lab) return null
  const b = bar.getBoundingClientRect()
  const l = lab.getBoundingClientRect()
  // ⚠️ MEASURED AGAINST THE PADDING BOX, not the border box. `overflow: hidden`
  // clips to the padding box, so comparing with getBoundingClientRect() alone
  // says "inside" for a label that is in fact losing a pixel to the border on
  // each side — which is exactly what the old `top: -1px` in an 8px box did.
  const padTop = b.top + bar.clientTop
  const padBottom = padTop + bar.clientHeight
  return {
    h: Math.round(b.height),
    text: lab.textContent.trim(),
    inside: l.height > 0 && l.top >= padTop - 0.5 && l.bottom <= padBottom + 0.5,
    clip: `label ${Math.round(l.top)}…${Math.round(l.bottom)} vs box ${Math.round(padTop)}…${Math.round(padBottom)}`,
    title: bar.getAttribute('title') ?? '',
  }
})
check('the LCM bar is mounted', lcm !== null, 'no .strip-lcm in the deck pane')
check(
  'it is tall enough for a cycle to be visible',
  lcm !== null && lcm.h >= 12,
  `height ${lcm?.h}px`,
)
check(
  'its label is INSIDE the box, not clipped by overflow:hidden',
  lcm?.inside === true && lcm?.text === 'LCM',
  `text=${JSON.stringify(lcm?.text)} — ${lcm?.clip}`,
)
// The bar means nothing without knowing how long the cycle is; the title is
// where that is said.
check(
  'it names the cycle length',
  /\d+ steps/.test(lcm?.title ?? ''),
  `title=${JSON.stringify(lcm?.title)}`,
)

// ── COMPOSE / DECK, AND THE MISSING LOAD (real-host report, 2026-08-01) ────
//
// `trackRowControls` gates the whole H row — name · browse ◀▶ · LOAD — on
// `!dj`. On the plane that is deliberate and harmless: sample browsing is sound
// design, and a compose window is one double-click away. ScoopyDeck mounts a
// deck and nothing else, so it shipped with NO WAY TO PUT A SAMPLE ON A TRACK.
// The sample doors were registered and correct the whole time; no control was
// wired to them.
//
// PERF is released first — it outranks the view switch by design, so leaving it
// armed would have this assert perform density and prove nothing.
{
  const perfOff = await page.$('.deckrow-sync .dr:has-text("PERF")')
  if (perfOff) {
    await perfOff.click()
    await page.waitForTimeout(200)
  }
}
const viewShape = () =>
  page.evaluate(() => ({
    label:
      [...document.querySelectorAll('.compose-window-bar .dr')]
        .map((b) => b.textContent.trim())
        .find((t) => t === 'COMPOSE' || t === 'DECK') ?? null,
    loads: [...document.querySelectorAll('.track-strips button')].filter(
      (b) => b.textContent.trim() === 'LOAD',
    ).length,
    add: document.querySelectorAll('.mr-add').length,
    compose: document.querySelectorAll('.track-strips.density-compose').length,
    dj: document.querySelectorAll('.track-strips.density-dj').length,
    docScrollH: document.documentElement.scrollHeight,
    viewportH: window.innerHeight,
  }))

const deckView = await viewShape()
check('the COMPOSE/DECK switch exists', deckView.label !== null, JSON.stringify(deckView))
check('it starts on DECK — a plugin comes up playable, not in an editor', deckView.label === 'DECK')

const viewBtn = await page.$('.compose-window-bar .dr:has-text("DECK")')
if (viewBtn) {
  await viewBtn.click()
  await page.waitForTimeout(300)
}
const composeView = await viewShape()
check('switching gives COMPOSE density', composeView.compose > 0 && composeView.dj === 0, JSON.stringify(composeView))
check(
  'LOAD is reachable in COMPOSE and absent in DECK — the whole point of the switch',
  deckView.loads === 0 && composeView.loads > 0,
  `deck=${deckView.loads} compose=${composeView.loads}`,
)
check(
  'the + add-track comes back with it — a build surface you cannot add to is not one',
  deckView.add === 0 && composeView.add > 0,
  `deck=${deckView.add} compose=${composeView.add}`,
)
check(
  'nothing overflows the window in COMPOSE either',
  composeView.docScrollH <= composeView.viewportH + 2,
  `scrollHeight=${composeView.docScrollH} viewport=${composeView.viewportH}`,
)

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
      .join(' ')} · PERF drag → track ${committed?.i} ⌊${committed?.start}·${committed?.len}⌉ ` +
    `↻${committed?.repeat ? 'on' : 'off'} (dy=${committed?.dy}) · ` +
    `${bar.clk} · ${bar.tempo}→${armed.tempo} master ${armed.text}→${moved} · ` +
    `master sends ${sends.count} · LCM ${lcm?.h}px "${lcm?.text}" · ` +
    `PERF pointer-only (controls ${shapeBefore.controls}=${shapeAfter.controls}) · ` +
    `LOAD deck ${deckView.loads} → compose ${composeView.loads}`,
)

if (failures.length) {
  console.error('browser_plugindeck_test FAILED:')
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log('browser_plugindeck_test OK — scene row, deck rows, grid and FILES all in their boxes')
