/**
 * Foundation-compatible JSON encoder (P5-06a — the flip's persistence kernel).
 *
 * THE FLIP's hard gate is a byte-stable `PatternFile` round-trip: TS decodes a
 * session Swift wrote, re-encodes it, and the bytes are identical. That proves
 * no key and no value was lost in the ownership transfer.
 *
 * Byte-identity is only possible if TS reproduces Foundation's exact output.
 * Four rules, all established EMPIRICALLY against a real `JSONEncoder` with the
 * production settings (`PersistenceService:22` — `.prettyPrinted, .sortedKeys`).
 * None of them is what you would guess:
 *
 * 1. **Key order is ICU collation, NOT lexicographic.** Swift emits
 *    `ab, aB, Ab, AB, ac, aC` — lowercase before uppercase at equal letters.
 *    A plain `keys.sort()` gives `AB, Ab, aB, aC, ab, ac`: a completely
 *    different file. `Intl.Collator` uses the same ICU root collation and
 *    matches Foundation exactly (verified key-for-key).
 *
 * 2. **nil optionals are OMITTED, not null.** `PatternFile` uses Codable's
 *    synthesized encoding, so a nil key is simply absent. (Careful: this is the
 *    OPPOSITE of the wire structs in `Generated/SLPProtocol.swift`, where
 *    P5-01c added an explicit `encode(to:)` that writes `null` — the zod UiState
 *    schemas need the key present. Same app, two deliberate contracts.)
 *
 * 3. **Numbers use the shortest round-trip representation FOR THEIR STORAGE
 *    TYPE**, and integral values carry no `.0` (`120`, not `120.0`).
 *    This is the load-bearing one: `Float` and `Double` format DIFFERENTLY.
 *    Swift writes Float(1/3) as `0.33333334` (shortest float32) but Double(1/3)
 *    as `0.3333333333333333`. In JS every number is a double, so a Float field
 *    naively re-encoded prints `0.3333333432674408` — the double expansion of
 *    the float. **The encoder must therefore KNOW which fields are Float**;
 *    that type information is invisible in the JSON and must come from the
 *    model (see `FLOAT32_PATHS`). PatternFile mixes both freely
 *    (`masterVolume: Float`, `bpm: Double`).
 *
 * 4. Pretty-print shape: 2-space indent, `"key" : value` (space BOTH sides of
 *    the colon), one array element per line, `{}`/`[]` for empty.
 */

/** Foundation's `.sortedKeys` order (ICU root collation, as `Intl.Collator`). */
const collator = new Intl.Collator();
export function foundationKeyOrder(keys: string[]): string[] {
  return [...keys].sort(collator.compare);
}

/**
 * Shortest decimal string that round-trips through a 32-bit float — Swift's
 * representation for a `Float` field. JS holds the value as a double, so we
 * search precisions until `Math.fround` reproduces the stored value.
 */
export function formatFloat32(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`non-finite Float: ${value}`);
  if (Number.isInteger(value)) return String(value); // 1, 0, -3 — no ".0"
  const target = Math.fround(value);
  for (let p = 1; p <= 9; p++) {
    const s = target.toPrecision(p);
    if (Math.fround(Number(s)) === target) return String(Number(s)); // strip 0.800 → 0.8
  }
  return String(target);
}

/** Shortest round-trip decimal for a `Double` — JS's native `String(n)`. */
export function formatDouble(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`non-finite Double: ${value}`);
  return String(value); // JS already emits shortest-round-trip; integrals get no ".0"
}

/**
 * JSON string escaping as Foundation emits it.
 *
 * RULE 5 (found 2026-07-13, the hard way): **Foundation escapes the forward slash.**
 * `JSONEncoder` writes `"a\/b"` where `JSON.stringify` writes `"a/b"`. Both are legal JSON
 * and both decode identically — but they are not the same BYTES, and byte-identity is the
 * flip's gate.
 *
 * This hid for a long time because no fixture happened to carry a `/` inside a string. It
 * surfaced the moment a plugin identifier did (`AudioUnit:aumu/xxxx/yyyy`) — and the field it
 * would really have bitten is `originalSamplePath`, i.e. every session that remembers where
 * its samples came from.
 */
function encodeString(s: string): string {
  return JSON.stringify(s).replace(/\//g, "\\/");
}

/**
 * Path of the value currently being encoded, in the form `a.b[].c` — array
 * elements collapse to `[]` because every element of an array shares one type.
 * `FLOAT32_PATHS` membership marks a number as a Swift `Float`.
 *
 * Swift dictionaries (`[Int: Float]`, `[String: Layer]`) are the same problem
 * with object syntax: every VALUE shares one type but the keys are arbitrary
 * data, so a concrete key can never appear in a type path. `dictPaths` marks an
 * object as a dictionary; its children then collapse to `{}` exactly like array
 * elements collapse to `[]` (e.g. `sectionA[].storedExtensionVolumeOffsets.{}`).
 */
export interface FoundationEncodeOptions {
  /** Paths (`a.b[].c`) whose numbers are Swift `Float`, not `Double`. */
  float32Paths?: ReadonlySet<string>;
  /** Paths whose object is a Swift dictionary — children collapse to `{}`. */
  dictPaths?: ReadonlySet<string>;
}

function encodeValue(
  value: unknown,
  path: string,
  indent: string,
  opts: FoundationEncodeOptions,
): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return opts.float32Paths?.has(path) ? formatFloat32(value) : formatDouble(value);
  }
  if (typeof value === "string") return encodeString(value);

  const inner = indent + "  ";
  if (Array.isArray(value)) {
    // Empty containers are NOT "[]" — Foundation emits an empty LINE between the
    // brackets (verified against the real encoder; guessing this wrong silently
    // breaks byte-identity on every session with an empty array, which is most).
    if (value.length === 0) return `[\n\n${indent}]`;
    const elems = value.map((v) => inner + encodeValue(v, `${path}[]`, inner, opts));
    return `[\n${elems.join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Rule 2: a key whose value is `undefined` is an absent Swift optional.
    const keys = foundationKeyOrder(Object.keys(obj).filter((k) => obj[k] !== undefined));
    if (keys.length === 0) return `{\n\n${indent}}`;
    const isDict = opts.dictPaths?.has(path) ?? false;
    const entries = keys.map((k) => {
      const seg = isDict ? "{}" : k;
      const child = path ? `${path}.${seg}` : seg;
      return `${inner}${encodeString(k)} : ${encodeValue(obj[k], child, inner, opts)}`;
    });
    return `{\n${entries.join(",\n")}\n${indent}}`;
  }
  throw new Error(`unencodable value at ${path}: ${typeof value}`);
}

/**
 * Encode exactly as Swift's `JSONEncoder` with `[.prettyPrinted, .sortedKeys]`.
 * Byte-for-byte: feed it what Swift wrote and you get what Swift wrote.
 */
export function encodeFoundationJSON(value: unknown, opts: FoundationEncodeOptions = {}): string {
  return encodeValue(value, "", "", opts);
}
