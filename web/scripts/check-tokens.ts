/**
 * check:tokens — fails if any file under web/src (excluding src/design/)
 * hardcodes a visual constant. Everything visual must come from the token
 * system (web/src/design/tokens.ts); the sibling apps learned the hard way that
 * a token nothing enforces is a token that rots.
 *
 * It also catches a DANGLING VAR — a `var(--x)` referenced in CSS/TSX that
 * tokens.ts never emits — the failure mode that silently renders as nothing
 * (a dropped border, a corner stuck at 0). The set of legitimate vars is asked
 * of tokenVars() rather than grepped, so it is exact by construction and stays
 * correct when a token group is added.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_TOKENS, tokenVars } from '../src/design/tokens.ts'

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const designRoot = join(srcRoot, 'design')

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/
const FONT_LITERAL = /font(-family)?\s*:\s*[^;}]*(["'][A-Za-z]|serif|sans-serif|monospace)/
const FONT_VAR_OK = /font(-family)?\s*:\s*var\(/
/** A px/% radius literal — corners are a token so ONE number softens the app. */
const RADIUS_LITERAL = /border-radius\s*:\s*[^;}]*\d/
/** A px font-size is a size no look can reach; sizes come from --type-*-size. */
const FONT_SIZE_LITERAL = /font-size\s*:\s*[^;}]*\d+px/
/** rgb()/hsl() with numeric args — the loophole HEX_COLOR never closed. An
    interpolated rgb(${…}) computed FROM tokens is legitimate and must not trip. */
const COLOR_FUNC_LITERAL = /\b(rgba?|hsla?)\s*\([^)$]*\d[^)$]*\)/

const violations: string[] = []

const defined = new Set<string>(Object.keys(tokenVars(DEFAULT_TOKENS)))
const used = new Map<string, string>() // name → first location

function collectDefs(text: string): void {
  for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) if (m[1]) defined.add(m[1])
  for (const m of text.matchAll(/["'](--[\w-]+)["']/g)) if (m[1]) defined.add(m[1])
}

function collectUses(text: string, loc: string): void {
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
    if (m[1] && !used.has(m[1])) used.set(m[1], loc)
  }
}

function scan(text: string, loc: string): void {
  text.split('\n').forEach((line, i) => {
    const at = `${loc}:${i + 1}`
    // A line that references a token var is exempt from the literal checks on
    // that line (the var IS the token; a fallback like var(--x, #000) is fine).
    const usesVar = /var\(\s*--/.test(line)
    if (HEX_COLOR.test(line) && !usesVar) violations.push(`${at}  hardcoded color: ${line.trim()}`)
    if (COLOR_FUNC_LITERAL.test(line) && !usesVar)
      violations.push(`${at}  hardcoded color fn: ${line.trim()}`)
    if (FONT_LITERAL.test(line) && !FONT_VAR_OK.test(line))
      violations.push(`${at}  hardcoded font: ${line.trim()}`)
    if (RADIUS_LITERAL.test(line) && !usesVar)
      violations.push(`${at}  hardcoded radius: ${line.trim()}`)
    if (FONT_SIZE_LITERAL.test(line) && !usesVar)
      violations.push(`${at}  hardcoded font-size: ${line.trim()}`)
  })
}

function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(ts|tsx|css)$/.test(entry) || /\.test\.ts$/.test(entry)) continue
    const text = readFileSync(full, 'utf8')
    const loc = relative(srcRoot, full)
    // design/ DEFINES tokens (literals are legitimate there); it is scanned for
    // var USES + DEFS but not for literal violations.
    collectDefs(text)
    collectUses(text, loc)
    if (!full.startsWith(designRoot)) scan(text, loc)
  }
}

walk(srcRoot)

for (const [name, loc] of used)
  if (!defined.has(name)) violations.push(`${loc}  dangling var (never emitted by tokens.ts): ${name}`)

if (violations.length > 0) {
  console.error('check:tokens FAILED — visual constants must come from the token system:')
  for (const v of violations) console.error('  - ' + v)
  process.exit(1)
}
console.log('check:tokens OK')
