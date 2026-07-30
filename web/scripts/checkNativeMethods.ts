/**
 * nativemethods:check — the shell answers it, so the link must ROUTE it.
 *
 * WHY THIS EXISTS. `MergedLink.NATIVE_METHODS` (web/src/engineLink.ts) is a
 * hand-maintained allowlist. A method the shell implements but the list omits
 * does not fail loudly: `MergedLink.command` falls through to `BrowserLink`,
 * which throws "not implemented in the browser companion" — and callers
 * routinely swallow that (`.catch(() => {})`, or `ask()` answering null). So the
 * symptom is a control that moves and does nothing, in the real host only.
 *
 * It has now happened twice.
 *   - slDeck / slMaster / slMap / slDevices — missing since P2 step 4. Map
 *     persistence "has never worked in this app" (that list's own comment).
 *   - fxSlot (v95) / getFxSlotState (v96) — the two most recent schema bumps
 *     both shipped a feature the merged host could not reach.
 *
 * The second time, the fix for the first was sitting three lines above as a
 * warning comment. A comment is not a gate. This is.
 *
 * WHAT IT COMPARES. Every `method == "x"` in shell/src/SlDispatch.cpp against
 * the NATIVE_METHODS set literal. Anything the shell handles and the link does
 * not route is RED unless it is listed in NOT_ROUTED below, with a reason.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. The reverse direction — a routed method
 * the shell does not handle — is already honest: it reaches SlDispatch's
 * refusal path and answers ok:false with the method named. Loud, not silent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

/**
 * Handled by the shell, deliberately NOT routed natively. Each needs a reason:
 * an entry here is a claim that the browser path is the right one on this host.
 */
const NOT_ROUTED: Record<string, string> = {
  getUiState:
    "UiState stays with the COMPANION, which owns the grid document and is the " +
    "only side with anything to publish. SlDispatch::getUiState deliberately " +
    "answers {} for every topic (SlDispatch.cpp:172), and BrowserLink has the " +
    "real implementation (browserLink.ts:289). Routing it natively would replace " +
    "a working answer with an empty one. See MergedLink.onUiState's docstring.",
  worldPublish:
    "the live world sink is slWorld, which IS routed. worldPublish is the " +
    "legacy Option-B entry the shell still answers for persistShadow/getPattern " +
    "— both of which are themselves unanswered, so nothing reaches it.",
};

const dispatch = readFileSync(resolve(repo, "shell/src/SlDispatch.cpp"), "utf8");
const link = readFileSync(resolve(repo, "web/src/engineLink.ts"), "utf8");

// `if (method == "x")` — the shell's one dispatch idiom.
const handled = new Set<string>();
for (const m of dispatch.matchAll(/method\s*==\s*"([A-Za-z][A-Za-z0-9]*)"/g))
  if (m[1] !== undefined) handled.add(m[1]);

// The NATIVE_METHODS set literal, then every quoted string inside it.
const setStart = link.indexOf("NATIVE_METHODS");
if (setStart < 0) {
  console.error("nativemethods:check FAILED: NATIVE_METHODS not found in engineLink.ts");
  process.exit(1);
}
const open = link.indexOf("[", setStart);
const close = link.indexOf("]);", open);
if (open < 0 || close < 0) {
  console.error("nativemethods:check FAILED: could not bound the NATIVE_METHODS literal");
  process.exit(1);
}
const body = link.slice(open, close);
const routed = new Set<string>();
// Quoted strings only — comments in this block name methods too (and must not
// count as routing them, which is precisely the failure mode being gated).
for (const line of body.split("\n")) {
  const code = line.replace(/\/\/.*$/, "");
  for (const m of code.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g))
    if (m[1] !== undefined) routed.add(m[1]);
}

if (handled.size === 0 || routed.size === 0) {
  console.error(
    `nativemethods:check FAILED: parsed ${handled.size} handled / ${routed.size} routed — ` +
      "one side came back empty, so the comparison would pass vacuously.",
  );
  process.exit(1);
}

const missing = [...handled].filter((m) => !routed.has(m) && !(m in NOT_ROUTED)).sort();
const staleExempt = Object.keys(NOT_ROUTED).filter((m) => !handled.has(m)).sort();

if (missing.length === 0 && staleExempt.length === 0) {
  console.log(
    `nativemethods:check OK — ${handled.size} handled by the shell, ` +
      `${routed.size} routed by MergedLink, ${Object.keys(NOT_ROUTED).length} exempt.`,
  );
  process.exit(0);
}

for (const m of missing) {
  console.error(
    `nativemethods:check RED: shell/src/SlDispatch.cpp handles "${m}", but ` +
      `MergedLink.NATIVE_METHODS does not route it.\n` +
      `  In the real host every call to "${m}" falls through to BrowserLink and throws,\n` +
      `  and callers commonly swallow that — so the feature is silently unreachable.\n` +
      `  Fix: add "${m}" to NATIVE_METHODS in web/src/engineLink.ts, or add it to\n` +
      `  NOT_ROUTED in this script WITH A REASON if the browser path is correct here.`,
  );
}
for (const m of staleExempt)
  console.error(
    `nativemethods:check RED: "${m}" is exempted in NOT_ROUTED but the shell no longer ` +
      `handles it — remove the stale exemption so it cannot mask a real gap.`,
  );
process.exit(1);
