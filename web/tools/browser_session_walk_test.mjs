/**
 * P3-SES-2 — the session walk, machine half.
 *
 * The chain the merged app could never complete (P3-ROADMAP "OPFS cannot be
 * the session store"): create a session → it appears in the library → load it
 * into a plane strip through the VISIBLE strip menu → the strip becomes a grid
 * deck. Every prior gate proved pieces; nothing drove the whole store path a
 * person walks.
 *
 * This drives the BUILT bundle in Chromium against a FAKE JUCE backend whose
 * `slFiles` is backed by this server's in-memory library — the same
 * opfs.ts → nativeFiles.ts → slFiles route the WKWebView host takes, with
 * SlDispatch's semantics (list/read/remove fail on missing; write is
 * text-or-b64) mirrored here. What it deliberately is NOT: the real JUCE
 * host. The bridge itself and WebKit's quirks stay P3-G1's ear/eye check —
 * this proves the WEB side of the walk cannot regress silently.
 *
 *   node tools/browser_session_walk_test.mjs [dist]
 */
import { openEngine } from "./lib/engines.mjs"
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname, dirname } from 'node:path'
import { unzipSync } from 'fflate'

const dist = process.argv[2] ?? '../webdist'
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
}

const failures = []
const check = (name, cond, detail) => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

// ── The library, server-side (SlDispatch slFiles semantics) ─────────────────
const files = new Map() // path -> Buffer
const dirs = new Set(['/'])
const norm = (p) => '/' + String(p).split('/').filter(Boolean).join('/')
const parent = (p) => norm(p.split('/').slice(0, -1).join('/'))
const mkdirs = (p) => {
  for (let d = norm(p); d !== '/'; d = parent(d)) dirs.add(d)
}
function libHandle({ action, path, text, b64 }) {
  const p = norm(path)
  if (action === 'mkdirs') {
    mkdirs(p)
    return { ok: true }
  }
  if (action === 'write') {
    if (text === undefined && b64 === undefined) throw new Error('slFiles/write: text or b64 required')
    mkdirs(parent(p))
    files.set(p, text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(b64, 'base64'))
    return { ok: true }
  }
  if (action === 'read') {
    const bytes = files.get(p)
    if (!bytes) throw new Error('slFiles/read: no such file')
    return { ok: true, b64: bytes.toString('base64') }
  }
  if (action === 'exists') return { ok: true, exists: files.has(p) || dirs.has(p) }
  if (action === 'remove') {
    if (!files.has(p) && !dirs.has(p)) throw new Error('slFiles/remove: no such entry')
    files.delete(p)
    dirs.delete(p)
    for (const k of [...files.keys()]) if (k.startsWith(p + '/')) files.delete(k)
    for (const d of [...dirs]) if (d.startsWith(p + '/')) dirs.delete(d)
    return { ok: true }
  }
  if (action === 'list') {
    if (!dirs.has(p)) throw new Error('slFiles/list: no such directory')
    const seen = new Map()
    for (const k of files.keys())
      if (parent(k) === p)
        seen.set(k.split('/').pop(), { isDirectory: false, sizeBytes: files.get(k).length })
    for (const d of dirs)
      if (d !== p && parent(d) === p) seen.set(d.split('/').pop(), { isDirectory: true, sizeBytes: 0 })
    return {
      ok: true,
      entries: [...seen.entries()].map(([name, e]) => ({ name, ...e, modifiedMs: 0 })),
    }
  }
  throw new Error(`slFiles: unknown action '${action}'`)
}

// ── Settings, server-side, for the same reason the library is ──────────────
// The fake backend used to answer `getSetting` with a flat `{value:null}` and
// swallow `setSetting`, which made every persisted setting invisible to every
// walk — a whole class of behaviour ("it is remembered") that could not be
// tested at all. Held in the NODE process so it outlives a page, because
// outliving a page is the entire claim a persistence test makes.
const settings = new Map()

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/__set') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { method, key, value } = JSON.parse(body)
      if (method === 'setSetting') settings.set(key, value)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(
        method === 'getSetting' ? { value: settings.has(key) ? settings.get(key) : null } : {}))
    })
    return
  }
  if (url.pathname === '/__lib') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const out = libHandle(JSON.parse(body))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (e) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(String(e.message ?? e))
      }
    })
    return
  }
  let p = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!existsSync(p)) p = join(dist, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
  res.end(readFileSync(p))
})
await new Promise((r) => server.listen(4601, r))

// ── The fake JUCE backend, injected before any bundle code runs ─────────────
const INIT = `
window.__JUCE__ = { backend: (() => {
  const listeners = new Map()
  const on = (id) => listeners.get(id) ?? []
  const emit = (id, payload) => on(id).forEach((fn) => fn(payload))
  async function handle(method, p) {
    if (method === 'getCapabilities')
      return { schemaVersion: 92, pluginHosting: false, fileSystem: true,
               midiHardware: false, audioDeviceSelection: true, returnFx: false }
    if (method === 'slFiles') {
      const res = await fetch('/__lib', { method: 'POST', body: JSON.stringify(p) })
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    }
    if (method === 'openPanelWindow') {
      // Recorded so the walk can assert the compose door (P3-C1) — the fake
      // has no window layer to actually open.
      ;(window.__panelWindowCalls ||= []).push(p)
      return { ok: true }
    }
    if (method === 'slRouteList') return { ok: true, routes: [], renderOrder: [] }
    if (method === 'slDevices')
      return { ok: true, current: 'Fake Duplex', devices: ['Fake Duplex'],
               channels: ['in 1', 'in 2'] }
    if (method === 'slWorld') return { ok: true, applied: true }
    if (method === 'slMap') return { ok: true, maps: [] }
    if (method === 'slTakes') return { ok: true, takes: [] }
    if (method === 'getSetting' || method === 'setSetting') {
      const res = await fetch('/__set', { method: 'POST', body: JSON.stringify(
        { method, key: p.key, value: p.value }) })
      return res.json()
    }
    return { ok: true }
  }
  // The walk plays the SHELL's part for window-lifecycle events (P3-C2):
  // the test emits slPanelClosed the way MergedMain broadcasts it.
  window.__emitEvent = emit
  return {
    emitEvent(id, payload) {
      if (id !== '__juce__invoke') return
      const { params, resultId } = payload
      const [method, p] = params
      handle(method, p).then(
        (result) => emit('__juce__complete', { promiseId: resultId, result: { ok: true, result } }),
        (e) => emit('__juce__complete', { promiseId: resultId, result: { ok: false, error: String(e && e.message || e) } }),
      )
    },
    addEventListener(id, fn) { listeners.set(id, [...on(id), fn]); return on(id).length },
    removeEventListener() {},
  }
})() }
`

const { browser, cleanup } = await openEngine()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
await page.addInitScript(INIT)

// ── 1 · Create, in the PLANE's own library popover (P3-L1 — the companion is
//        the browser's shell; the merged app never opens it) ────────────────
await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-bar', { timeout: 10000 })
await page.click('button:has-text("library ▾")')
await page.waitForSelector('.plane-library', { timeout: 5000 })
await page.click('.plane-library-actions button:has-text("New")')
await page.waitForSelector('.plane-library-row', { timeout: 10000 })

check('created session is listed in the plane library',
  ((await page.textContent('.plane-library-row')) ?? '').includes('Untitled'))
check('New created WITHOUT loading — no deck was hijacked',
  (await page.locator('.plane-library-loaded').count()) === 0)
check('pattern.json landed in the NATIVE library, non-empty',
  (files.get('/sessions/Untitled/pattern.json')?.length ?? 0) > 100,
  `got ${files.get('/sessions/Untitled/pattern.json')?.length ?? 0} bytes`)
check('the write was the atomic slFiles route, not OPFS',
  [...files.keys()].every((k) => k.startsWith('/sessions/') || k.startsWith('/samples/')))

// ── 2 · Load, on the plane, through the VISIBLE strip menu ─────────────────
await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-add', { timeout: 10000 })
await page.click('.plane-add')
await page.waitForSelector('.plane-strip', { timeout: 5000 })
await page.click('.strip-menu')
await page.waitForSelector('.ds-menu', { timeout: 5000 })

const menuItem = page.locator('.ds-menu-item', { hasText: 'Untitled' })
check('the strip menu offers the session', (await menuItem.count()) === 1)
await menuItem.click()
await page.waitForSelector('.strip-scenes', { timeout: 10000 })

check('the strip became a grid deck (scene pads present)',
  (await page.$('.strip-scenes')) !== null)
check('the strip took the SESSION NAME (P3-U2) — not an anonymous "STRIP 1"',
  ((await page.textContent('.strip-name')) ?? '').includes('Untitled'),
  await page.textContent('.strip-name'))
check('the grid row (sync · tempo mode · bpm) is present',
  (await page.$('.strip-gridrow')) !== null)
check('no fatal error blocks', (await page.$$('.fatal-error')).length === 0)

// ── 2b · The strip becomes the DECK (P3-D4-1, D-SL-MORPH-01) ───────────────
// ⤢ expands the strip to the deck tile, and the REAL GridPanel must be FED:
// "waiting for pattern state…" forever was the D4-M hard-block finding, so the
// assertion is the dj track rows actually materialising, not the container.
await page.click('.strip-expand')
await page.waitForSelector('.strip-deckface', { timeout: 5000 })
await page.waitForSelector('.strip-deckface .track-strips.density-dj', { timeout: 10000 })
check('the deck tile hosts the real GridPanel at DJ density',
  (await page.$('.strip-deckface .track-strips.density-dj')) !== null)
check('the tile\'s MasterRow is scoopy\'s own (BPM · VOL · DRV — P3-D4-1a made it real)',
  (await page.$('.strip-deckface .master-row')) !== null)
// THE CLASSIC DECK ROWS (B1 · P7-T1/T2/T3). The verbs used to be a span in the
// tile header (`strip-deckverbs`); they are three rows of their own now that
// there are eighteen of them rather than seven. Asserted BY CONTENT and not
// only by container, because "a div exists" is exactly the check that would
// still pass if every button inside it had gone.
check('the tile carries the four classic deck rows (B1 + B2\'s scene row)',
  (await page.$$('.deckrow')).length === 4)
{
  const rows = (await page.textContent('.deckrow-toolbar')) ?? ''
  check('the toolbar row carries the donor block in the app vocabulary (OPEN ⟳ ▸ ↻ ◼ » DBL SAVE ⏏)',
    ['OPEN', '⟳', '▸', '↻', '◼', '»', 'DBL', 'SAVE', '⏏'].every((v) => rows.includes(v)), rows)
  const sync = (await page.textContent('.deckrow-sync')) ?? ''
  // PERF joined this row on 2026-08-01: it is a POINTER MODE (drag a track to
  // set its locator window live), not a view, and it belongs with BR and REV —
  // the other live gestures that change what PLAYS without editing the
  // document. It used to sit beside GRID on the view row, and that adjacency is
  // part of what made it look like somewhere a view change could be hung.
  check('the sync row carries SYNC/FREE · TR · TP · WIN · BR · REV · PERF',
    ['TR', 'TP', 'WIN', 'BR', 'REV', 'PERF'].every((v) => sync.includes(v)) &&
      (sync.includes('SYNC') || sync.includes('FREE')), sync)
  const scene = (await page.textContent('.deckrow-scene')) ?? ''
  check('the scene row carries the switch-mode cycler, CU, SCN and MUTE (B2)',
    ['SCHED', 'CU', 'SCN', 'MUTE'].every((v) => scene.includes(v)), scene)
  const view = (await page.textContent('.deckrow-view')) ?? ''
  // GRID ALONE — the view axis. See the sync row above for where PERF went.
  check('the view row carries GRID, and NOT PERF',
    view.includes('GRID') && !view.includes('PERF'), view)
}
check('the header no longer carries the retired verb span',
  (await page.$('.strip-deckverbs')) === null)
check('the LCM bar sits between the deck rows and the channel row (P3-D4-2)',
  (await page.$('.strip-lcm')) !== null)
check('the panel is not stuck waiting for state',
  !((await page.textContent('.strip-deckface')) ?? '').includes('waiting for pattern state'))
// …and the way back restores the compact strip to the pixel.
await page.click('.strip-expand')
await page.waitForFunction(() => document.querySelector('.strip-deckface') === null,
  { timeout: 5000 })
const collapsedBox = await page.evaluate(() => {
  const s = document.querySelector('.plane-strip')
  return { w: s.style.width, h: s.style.height }
})
check('collapse restores the 340×196 strip exactly',
  collapsedBox.w === '340px' && collapsedBox.h === '196px', JSON.stringify(collapsedBox))

// ── 3 · The library survives a reload (persistence is server-side) ─────────
await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-add', { timeout: 10000 })
await page.click('.plane-add')
await page.waitForSelector('.plane-strip', { timeout: 5000 })
await page.click('.strip-menu')
await page.waitForSelector('.ds-menu', { timeout: 5000 })
check('after a reload the library still lists the session',
  (await page.locator('.ds-menu-item', { hasText: 'Untitled' }).count()) === 1)

// ── 4 · Rename, end to end through the slFiles route (P3-L1) ───────────────
await page.keyboard.press('Escape') // close the strip menu
await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-bar', { timeout: 10000 })
await page.click('button:has-text("library ▾")')
await page.waitForSelector('.plane-library-row', { timeout: 5000 })
await page.click('.plane-library-row button[title="rename"]')
await page.fill('.plane-library-rename', 'Beach')
await page.keyboard.press('Enter')
await page.waitForFunction(() => {
  const row = document.querySelector('.plane-library-row')
  return row && row.textContent.includes('Beach')
}, { timeout: 10000 })

check('rename moved the directory on the native route',
  (files.get('/sessions/Beach/pattern.json')?.length ?? 0) > 100 &&
    !files.has('/sessions/Untitled/pattern.json'),
  [...files.keys()].join(', '))

// ── 5 · The compose window and the single-publisher rule (P3-C1/C2) ────────
await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-add', { timeout: 10000 })
await page.click('.plane-add')
await page.waitForSelector('.plane-strip', { timeout: 5000 })
await page.click('.strip-menu')
await page.waitForSelector('.ds-menu', { timeout: 5000 })
await page.locator('.ds-menu-item', { hasText: 'Beach' }).click()
await page.waitForSelector('.strip-scenes', { timeout: 10000 })
await page.click('.strip-compose')
await page.waitForSelector('.strip-scenefield.locked', { timeout: 5000 })

const calls = await page.evaluate(() => window.__panelWindowCalls ?? [])
check('COMPOSE ⇱ asked the shell for a compose window',
  calls.length === 1 && calls[0].panel === 'compose', JSON.stringify(calls))
const composeArg = calls[0]?.arg ?? ''
let decodedArg = null
try {
  decodedArg = JSON.parse(Buffer.from(
    composeArg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
} catch { /* checked below */ }
check('the address decodes to the deck and session',
  decodedArg?.deck === 0 && decodedArg?.session === 'Beach', JSON.stringify(decodedArg))
check('the plane locked the strip while the window owns the deck',
  (await page.$('.strip-scenefield.locked')) !== null)

// The compose window itself: a second page wearing the injected address —
// exactly what PanelWindow's user script does.
const page2 = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page2.on('pageerror', (e) => pageErrors.push('page2: ' + String(e)))
await page2.addInitScript(INIT)
await page2.addInitScript(
  `window.__slPanel = 'compose'; window.__slPanelArg = '${composeArg}';`)
await page2.goto('http://localhost:4601/')
await page2.waitForSelector('.compose-window', { timeout: 10000 })
check('the compose window names its session',
  ((await page2.textContent('.compose-window-bar')) ?? '').includes('Beach'),
  await page2.textContent('.compose-window-bar'))
await page2.waitForSelector('.trk-name', { timeout: 10000 })
check('the REAL GridPanel mounted in the compose window',
  (await page2.$('.trk-name')) !== null)

// ── P3.5-E8e — the FILES drawer remembers, across a REOPEN ─────────────────
// The row's own gate, in the only place that can prove it: persistence goes
// through getSetting/setSetting, which here is BrowserLink's localStorage-backed
// LocalSettings, so "survives a reopen" means a genuinely new page reading what
// the last one wrote. A unit test can pin the clamp; only a walk can pin that.
await page2.click('.compose-files-tab')
await page2.waitForSelector('.compose-files.open .compose-files-body', { timeout: 10000 })
const grip = await page2.waitForSelector('.compose-files-grip', { timeout: 10000 })
const gb = await grip.boundingBox()
// Drag the grip LEFT — the drawer is on the right, so left is wider.
await page2.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2)
await page2.mouse.down()
await page2.mouse.move(gb.x + gb.width / 2 - 70, gb.y + gb.height / 2, { steps: 8 })
await page2.mouse.up()
const widened = await page2.evaluate(
  () => document.querySelector('.compose-files-body').getBoundingClientRect().width)
check('dragging the grip widens the drawer', widened > 300, `width ${widened}`)
await page2.close()

// A NEW page, same context: it must come up with the drawer OPEN at that width.
const page3 = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page3.on('pageerror', (e) => pageErrors.push('page3: ' + String(e)))
await page3.addInitScript(INIT)
await page3.addInitScript(
  `window.__slPanel = 'compose'; window.__slPanelArg = '${composeArg}';`)
await page3.goto('http://localhost:4601/')
await page3.waitForSelector('.compose-files.open .compose-files-body', { timeout: 10000 })
const reopened = await page3.evaluate(
  () => document.querySelector('.compose-files-body').getBoundingClientRect().width)
check('the drawer reopens OPEN — the state is remembered, not defaulted',
  reopened > 0)
check('and at the width it was left at', Math.abs(reopened - widened) < 2,
  `left ${widened}, reopened ${reopened}`)
await page3.close()

// ── S1/S2 — the STUDIO face, and the transport door it grew ────────────────
// Studio is what the app opens now (D-SL-STUDIO-01), and its transport had no
// visible door until S2. Both facts were pinned only by source-text tests,
// which cannot see a rendered button — so this asserts the door EXISTS and that
// its disabled state TEACHES (DESIGN.md §6/§7), in a real engine.
//
// Studio boots with NO session on purpose ("empty is a door"), which is exactly
// the state the four verbs must refuse in: every one of them goes through
// useCompanion, which returns silently with no session, so unguarded they would
// be four buttons that swallow clicks and look identical to four working ones.
const studio = await browser.newPage({ viewport: { width: 1200, height: 800 } })
studio.on('pageerror', (e) => pageErrors.push('studio: ' + String(e)))
await studio.addInitScript(INIT)
await studio.addInitScript(`window.__slPanel = 'studio';`)
await studio.goto('http://localhost:4601/')
await studio.waitForSelector('main.compose-window', { timeout: 10000 })
check('the studio face mounts and names itself',
  ((await studio.getAttribute('main.compose-window', 'aria-label')) ?? '').startsWith('studio'),
  await studio.getAttribute('main.compose-window', 'aria-label'))

const glyphs = await studio.$$eval('[aria-label="transport"] button', (bs) =>
  bs.map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, title: b.title })))
check('all four transport glyphs are drawn (DESIGN.md §3)',
  glyphs.map((g) => g.text).join('') === '⟳▸↻◼', JSON.stringify(glyphs.map((g) => g.text)))
check('with no session every verb is disabled rather than silently inert',
  glyphs.length === 4 && glyphs.every((g) => g.disabled), JSON.stringify(glyphs))
check('and each disabled verb says what to do about it (§6)',
  glyphs.every((g) => g.title.includes('session')), JSON.stringify(glyphs.map((g) => g.title)))
await studio.close()

// The plane resumes ownership on the shell's close broadcast.
await page.evaluate(
  (a) => window.__emitEvent('slPanelClosed', { panel: 'compose', arg: a }),
  composeArg,
)
await page.waitForFunction(
  () => document.querySelector('.strip-scenefield.locked') === null,
  null,
  { timeout: 10000 },
)
check('the lock released on slPanelClosed', true)

// ── 6 · Import a `.scoopySession` FOLDER through the plane library (P3.5-E7) ─
//        The desktop writes a DIRECTORY, and the plane's lone file input could
//        not select one — picking a folder fired no event and the button read
//        as dead. This drives the RESTORED folder picker over a real directory
//        on disk. Worth most in WebKit (`node tools/walks.mjs webkit session`):
//        WKWebView is where `webkitdirectory` is likeliest to differ, which is
//        the whole reason the row exists.
const fixtureDir = await mkdtemp(join(tmpdir(), 'scoopy-session-'))
const sessionDir = join(fixtureDir, 'Demo.scoopySession')
{
  const zip = unzipSync(new Uint8Array(readFileSync('fixtures/session/session.zip')))
  for (const [name, bytes] of Object.entries(zip)) {
    const target = join(sessionDir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
  // ONE SAMPLE IS DELIBERATELY NOT AUDIO (P3.5-E9a). It rides the import
  // untouched — bytes are bytes — and fails to DECODE when the session is
  // loaded into a strip, which is the exact shape of "a loaded scoopy session
  // makes no sound". Step 8 asserts the app now says so instead of going quiet.
  writeFileSync(join(sessionDir, 'Samples', 'kick.wav'), Buffer.from('not audio at all'))
}

await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-bar', { timeout: 10000 })
await page.click('button:has-text("library ▾")')
await page.waitForSelector('.plane-library', { timeout: 5000 })
check('the library offers a FOLDER door beside the file one',
  (await page.locator('.plane-library-actions button:has-text("folder")').count()) === 1)

await page.setInputFiles('.plane-library input[webkitdirectory]', sessionDir)
await page.waitForFunction(
  () => [...document.querySelectorAll('.plane-library-row')]
    .some((r) => r.textContent.includes('Demo')),
  null,
  { timeout: 15000 },
)
check('the imported FOLDER is listed in the library', true)
check('its pattern landed on the native route, non-empty',
  (files.get('/sessions/Demo/pattern.json')?.length ?? 0) > 100,
  `got ${files.get('/sessions/Demo/pattern.json')?.length ?? 0} bytes`)
check('it arrived WITH its samples — the point of importing a session',
  (files.get('/samples/Demo/kick.wav')?.length ?? 0) > 0 &&
    (files.get('/samples/Demo/snare.wav')?.length ?? 0) > 0,
  [...files.keys()].filter((k) => k.startsWith('/samples/')).join(', '))
check('the import told the note line what it did',
  ((await page.textContent('.plane-note')) ?? '').includes('imported Demo'),
  await page.textContent('.plane-note').catch(() => '(no note)'))

// ── 7 · LOAD a sample IN THE COMPOSE WINDOW (P3.5-E8a) ─────────────────────
//        "in compose it wont let me load any audio samples" (user, real host).
//        GridPanel has always drawn LOAD on every audio row, but the button
//        only sends an intent, and `useComposeBinding` registered no handler
//        for it — BrowserLink then falls through to a silent {ok:true}. What
//        is measured here is the door OPENING: the click must produce a real
//        file chooser, and the file picked must land in the native library.
{
  const composePage = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  composePage.on('pageerror', (e) => pageErrors.push('compose: ' + String(e)))
  await composePage.addInitScript(INIT)
  await composePage.addInitScript(
    `window.__slPanel = 'compose'; window.__slPanelArg = '${composeArg}';`)
  await composePage.goto('http://localhost:4601/')
  await composePage.waitForSelector('.trk-name', { timeout: 15000 })

  const load = composePage.locator('button:has-text("LOAD")').first()
  check('the compose window draws a LOAD door on a track row',
    (await load.count()) === 1 || (await composePage.locator('button:has-text("LOAD")').count()) > 0)

  // The measurement. Pre-fix this click resolved `{ok:true}` and NOTHING
  // happened, so a timeout here is the defect reproducing.
  let chooserOpened = true
  const chooser = await Promise.all([
    composePage.waitForEvent('filechooser', { timeout: 10000 }),
    load.click(),
  ]).then(([c]) => c).catch(() => { chooserOpened = false; return null })
  check('LOAD opens a real file chooser in the compose window', chooserOpened,
    'bar says: ' + ((await composePage.textContent('.compose-window-bar')) ?? '(none)'))

  if (chooser) {
    await chooser.setFiles(join(sessionDir, 'Samples', 'kick.wav'))
    // The picked file becomes a library citizen on the native slFiles route —
    // the half that does not depend on this engine decoding the audio.
    let landed = false
    for (let i = 0; i < 50 && !landed; i++) {
      landed = (files.get('/samples/Imported/kick.wav')?.length ?? 0) > 0
      if (!landed) await new Promise((r) => setTimeout(r, 100))
    }
    check('the picked file landed in the library on the native route', landed,
      [...files.keys()].filter((k) => k.startsWith('/samples/Imported')).join(', '))
  }
  await composePage.close()
}

// ── 8 · A SILENT DECK SAYS WHY (P3.5-E9a) ──────────────────────────────────
//        The imported Demo session carries one sample that is not audio. Load
//        it into a strip: the deck comes up looking perfectly normal and those
//        tracks make no sound. Before this row NOTHING said so on any surface
//        in the merged app — `decodeFailures` was read only by the browser-only
//        companion panel P3-L1 deleted.
await page.goto('http://localhost:4601/?panel=plane')
await page.waitForSelector('.plane-add', { timeout: 10000 })
await page.click('.plane-add')
await page.waitForSelector('.plane-strip', { timeout: 5000 })
await page.click('.strip-menu')
await page.waitForSelector('.ds-menu', { timeout: 5000 })
await page.locator('.ds-menu-item', { hasText: 'Demo' }).click()
await page.waitForSelector('.strip-scenes', { timeout: 10000 })

const quiet = await page
  .waitForSelector('.plane-note', { timeout: 10000 })
  .then((el) => el.textContent())
  .catch(() => '(no note at all)')
check('the load reported the sample that would not decode', /did not load/.test(quiet), quiet)
check('…and named it, rather than counting it', /kick/.test(quiet), quiet)
check('…and said what it MEANS — those tracks are silent', /silent/.test(quiet), quiet)

await rm(fixtureDir, { recursive: true, force: true })

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

await cleanup()
server.close()

if (failures.length > 0) {
  console.error('browser_session_walk_test FAILURES:')
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('browser_session_walk_test OK — create → library → strip menu → grid deck, on the native store route')
