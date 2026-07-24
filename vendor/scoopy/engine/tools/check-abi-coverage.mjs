/**
 * THE DRIFT DETECTOR — "when we add a feature to the big app, does the browser still keep up?"
 *
 * P8-10(a) happened because the answer was silently NO. `sl_snapshot_add_track` carried twelve of
 * `NativeTrackSnapshot`'s 125 fields and the other 113 took their C++ defaults — so a band-pass track
 * was not band-passed, a trimmed sample played whole, and the browser rendered a different piece of
 * audio (−3.2 dBFS against the desktop, louder than the signal itself). Nothing caught it, because
 * every test sat on one side of the ABI or the other.
 *
 * ABI v2 fixed the twelve. It did NOT fix the thing that let twelve happen: the track's field list is
 * hand-mirrored in four places, and a new field added to the engine appears in NONE of them.
 *
 *     ScoopyLoops/NativeAudioEngineCore.hpp   NativeTrackSnapshot  ← the truth
 *     engine/include/sl_engine.h              SL_T_* / SL_TA_*     ← the keys
 *     engine/src/sl_engine.cpp                the setter switch    ← key → field
 *     web/src/audio/scoopy-worklet.js         SCALAR_FIELDS        ← what JS actually sends
 *     web/src/audio/worldFromSession.ts       the converter        ← what the document fills in
 *
 * Add `t.newThing` to the engine and every one of those keeps compiling, every test keeps passing, and
 * the browser quietly plays without it. That is not a hypothetical: it is precisely how the last one
 * went unnoticed for three phases.
 *
 * So: this walks the chain and FAILS when a field falls out of it. Every field of NativeTrackSnapshot
 * must be either CARRIED end-to-end, or listed in `abi-not-carried.json` **with a reason**. There is
 * no third state, and "nobody noticed" stops being one of them.
 *
 *   node engine/tools/check-abi-coverage.mjs          # or: npm run abi:check   (from web/)
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const read = (p) => readFile(resolve(repo, p), "utf8");

const CORE = "ScoopyLoops/NativeAudioEngineCore.hpp";
const ABI_H = "engine/include/sl_engine.h";
const ABI_C = "engine/src/sl_engine.cpp";
const WORKLET = "web/src/audio/scoopy-worklet.js";
const CONVERTER = "web/src/audio/worldFromSession.ts";
const ALLOW = "engine/tools/abi-not-carried.json";

// ── 1. the truth: every field of NativeTrackSnapshot ──────────────────────────────────────────
async function coreFields() {
  const src = await read(CORE);
  const start = src.indexOf("struct NativeTrackSnapshot");
  if (start < 0) throw new Error(`cannot find NativeTrackSnapshot in ${CORE}`);
  const end = src.indexOf("\n};", start);
  const body = src.slice(start, end);

  const fields = new Set();
  for (const line of body.split("\n")) {
    const code = line.split("//")[0];
    // `std::vector<float> accentLevels;` · `float volume = 0.8f;` · `NativeToneFilter::Mode toneMode = …;`
    const m = code.match(/^\s{4}[A-Za-z_][\w:<>,\s*]*?\s([A-Za-z_]\w*)\s*(=|;)/);
    if (m) fields.add(m[1]);
  }
  if (fields.size < 50) throw new Error(`parsed only ${fields.size} fields — the regex has drifted`);
  return fields;
}

// ── 2. the ABI: which core field each key writes ──────────────────────────────────────────────
async function abiFields() {
  const src = await read(ABI_C);
  const carried = new Map(); // coreField -> key

  // `case SL_T_VOLUME:  t.volume = f(); break;`
  for (const [, key, field] of src.matchAll(/case\s+(SL_T_\w+):\s*t\.(\w+)\s*=/g)) {
    carried.set(field, key);
  }
  // `case SL_TA_ACCENT_LEVELS:  asFloat(t.accentLevels); break;`
  for (const [, key, field] of src.matchAll(/case\s+(SL_TA_\w+):\s*\w+\(t\.(\w+)\)/g)) {
    carried.set(field, key);
  }
  // sl_snapshot_track_begin sets these directly, not by key.
  for (const [, field] of src.matchAll(/e->track\.(\w+)\s*[.=]/g)) {
    if (!carried.has(field)) carried.set(field, "(track_begin)");
  }
  return carried;
}

// ── 3. what JavaScript actually SENDS ─────────────────────────────────────────────────────────
async function workletKeys() {
  const src = await read(WORKLET);
  const keys = new Set();
  for (const [, key] of src.matchAll(/\[\s*"[\w]+"\s*,\s*"(SL_T[A-Z_]*\w+)"\s*\]/g)) keys.add(key);
  return keys;
}

/** The WorldTrack fields the worklet knows how to send, i.e. the JS-side names. */
async function workletFields() {
  const src = await read(WORKLET);
  const fields = new Set();
  for (const [, field] of src.matchAll(/\[\s*"(\w+)"\s*,\s*"SL_T/g)) fields.add(field);
  return fields;
}

// ── 4. what the CONVERTER fills in from the document ──────────────────────────────────────────
async function converterFields() {
  const src = await read(CONVERTER);
  const start = src.indexOf("tracks.push({");
  if (start < 0) throw new Error(`cannot find the track literal in ${CONVERTER}`);
  const body = src.slice(start, src.indexOf("\n    });", start));
  const fields = new Set();
  for (const [, field] of body.matchAll(/^\s{6}(\w+):/gm)) fields.add(field);
  return fields;
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────
const [core, abi, wKeys, wFields, cFields, allowRaw] = await Promise.all([
  coreFields(),
  abiFields(),
  workletKeys(),
  workletFields(),
  converterFields(),
  read(ALLOW),
]);

const allow = JSON.parse(allowRaw);
const notCarried = new Map(Object.entries(allow.notCarried));

let failures = 0;
const fail = (lines) => {
  failures++;
  console.error(lines);
};

console.log(`NativeTrackSnapshot: ${core.size} fields · ABI carries ${abi.size} · allowlist ${notCarried.size}`);

// (a) every core field is either carried, or explicitly not-carried WITH A REASON.
const unaccounted = [...core].filter((f) => !abi.has(f) && !notCarried.has(f));
if (unaccounted.length > 0) {
  fail(
    `\n✗ ${unaccounted.length} engine field(s) reach NEITHER the browser NOR the allowlist:\n` +
      unaccounted.map((f) => `      ${f}`).join("\n") +
      `\n\n  A field the ABI does not carry takes its C++ DEFAULT in the browser, silently, and the\n` +
      `  default is not "off" — it is a different track. That is exactly how P8-10(a) happened.\n\n` +
      `  Pick one, per field:\n` +
      `    CARRY IT   1. add an SL_T_* (or SL_TA_*) key to engine/include/sl_engine.h\n` +
      `               2. add its case to the switch in engine/src/sl_engine.cpp (+ the name table)\n` +
      `               3. add ["worldField", "SL_T_KEY"] to SCALAR_FIELDS in ${WORKLET}\n` +
      `               4. set it in ${CONVERTER} and add it to WorldTrack\n` +
      `               5. put it in the scene in engine/tools/abi_fidelity_test.cpp\n` +
      `    OR SAY WHY  add it to ${ALLOW} with a reason. "Not carried on purpose" is a fine\n` +
      `                answer; "nobody noticed" is the one this check exists to prevent.`,
  );
}

// (b) an allowlisted field that IS now carried is stale bookkeeping — clean it up.
const staleAllow = [...notCarried.keys()].filter((f) => abi.has(f));
if (staleAllow.length > 0) {
  fail(`\n✗ allowlisted but actually carried (remove from ${ALLOW}): ${staleAllow.join(", ")}`);
}

// (c) an allowlisted field that no longer exists in the engine is also stale.
const ghostAllow = [...notCarried.keys()].filter((f) => !core.has(f));
if (ghostAllow.length > 0) {
  fail(`\n✗ allowlisted but no longer a field of NativeTrackSnapshot: ${ghostAllow.join(", ")}`);
}

// (d) THE HALF-WIRED CASE, and it is the nastiest: the engine can carry the field, but JavaScript
//     never sends it. The C++ compiles, the C++ gate passes (it drives the ABI directly), and the
//     BROWSER still plays the default. A key with no sender is a key that does nothing.
const abiKeys = new Set([...abi.values()].filter((k) => k.startsWith("SL_T")));
const unsent = [...abiKeys].filter((k) => !wKeys.has(k));
if (unsent.length > 0) {
  fail(
    `\n✗ ${unsent.length} ABI key(s) the engine accepts but JAVASCRIPT NEVER SENDS:\n` +
      unsent.map((k) => `      ${k}`).join("\n") +
      `\n  Add ["worldField", "${unsent[0]}"] to SCALAR_FIELDS/ARRAY_FIELDS in ${WORKLET}.`,
  );
}

// (e) and the other half: JS sends a field the CONVERTER never fills from the document, so it is
//     always undefined and the engine keeps its default. A sender with no source does nothing either.
const unfilled = [...wFields].filter((f) => !cFields.has(f));
if (unfilled.length > 0) {
  fail(
    `\n✗ ${unfilled.length} field(s) the worklet can send but ${CONVERTER} never sets:\n` +
      unfilled.map((f) => `      ${f}`).join("\n") +
      `\n  They will always be undefined, so the engine keeps its default and the control is dead.`,
  );
}

if (failures === 0) {
  const carried = [...core].filter((f) => abi.has(f)).length;
  console.log(
    `\n✓ every engine field is accounted for — ${carried} carried to the browser, ` +
      `${notCarried.size} deliberately not (with reasons).`,
  );
  process.exit(0);
}

console.error(`\nABI COVERAGE CHECK FAILED — ${failures} problem(s).`);
process.exit(1);
