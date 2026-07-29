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
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

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

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
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
    if (method === 'getSetting') return { value: null }
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

const browser = await chromium.launch()
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
await page2.close()

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

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

await browser.close()
server.close()

if (failures.length > 0) {
  console.error('browser_session_walk_test FAILURES:')
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('browser_session_walk_test OK — create → library → strip menu → grid deck, on the native store route')
