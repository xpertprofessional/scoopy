/**
 * P8-0b — `.scoopySession` as ONE FILE. The transfer unit.
 *
 * The desktop's session is a DIRECTORY package (`pattern.json` · `kit.json` · `Samples/`). That is
 * a fine shape for a filesystem and a hostile one for a browser: a browser hands you a *file*, and
 * a folder round-trip through a download is miserable. So the interchange form is the same package,
 * zipped — one thing to download, mail to yourself, and drop back on the desktop.
 *
 * ⚠️ **STORED, not deflated** — deliberately, and the Swift half agrees (SessionZip.swift):
 *   - a sandboxed macOS app cannot shell out to `ditto`/`zip`, and Apple ships no ZIP *container*
 *     API (Compression is raw streams), so Swift writes its own — and a STORED-only writer is
 *     ~150 honest lines, while a deflate one is a compression library nobody asked for;
 *   - the bulk of a session is WAV audio, which barely compresses anyway;
 *   - every unzip tool on earth reads STORED entries, so the file stays inspectable by hand.
 * The JSON does compress well, and if a session ever gets big enough for that to matter, deflating
 * only the two manifests is a contained change. It is not worth a dependency today.
 *
 * ⚠️ **preserve-don't-drop applies to the CONTAINER too.** `unpack` keeps every entry it did not
 * recognise, and `pack` writes them back. A future desktop version that adds `notes.json` to the
 * package must not have it deleted by a companion that predates it. The rule is the same one the
 * strict PatternFile schema enforces at the field level, applied one level up.
 */
import { unzipSync, zipSync } from "fflate";

import { decodeKit, encodeKit, type KitJson } from "./kit.ts";
import { decodePatternFileAnyVersion } from "./migrations.ts";
import { encodePatternFile, type PatternFileJson } from "./patternFile.ts";

export const PATTERN_ENTRY = "pattern.json";
export const KIT_ENTRY = "kit.json";
export const SAMPLES_DIR = "Samples/";

export interface SessionPackage {
  pattern: PatternFileJson;
  kit: KitJson;
  /** Sample bytes, keyed by the path the kit refers to (`Samples/kick.wav`). */
  samples: Map<string, Uint8Array>;
  /**
   * Anything else the archive carried. We do not know what it is, and we are not entitled to
   * delete it — see the header. Kept verbatim and written back byte-for-byte.
   */
  extras: Map<string, Uint8Array>;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

/**
 * Finder's Compress writes resource-fork shadows into the archive (`__MACOSX/…`, `._name`
 * AppleDouble files, `.DS_Store`). They are container junk, not session content: left in, the
 * `__MACOSX/` tree defeats the common-root detection below and a Finder-zipped package fails with
 * "missing pattern.json" — the one workflow a user without the desktop's zip export actually has.
 * Junk is dropped, not preserved: preserve-don't-drop covers what a FUTURE DESKTOP might write,
 * and the desktop's own zip writer (SessionZip.swift) never writes these.
 */
function isFinderJunk(name: string): boolean {
  return (
    name.startsWith("__MACOSX/") ||
    name.split("/").some((part) => part === ".DS_Store" || part.startsWith("._"))
  );
}

/** Read a `.scoopySession` archive. Throws (loudly) if a manifest is missing or malformed. */
export function unpackSession(zip: Uint8Array): SessionPackage {
  return packageFromEntries(new Map(Object.entries(unzipSync(zip))));
}

/**
 * The same reading, over loose path→bytes entries — how a DROPPED OR PICKED FOLDER arrives. The
 * desktop's `.scoopySession` is a directory, and a browser file input silently refuses directories
 * (no change event, nothing) — "import does not react". So the folder itself is a first-class
 * import form, walked by the shell into entries and funnelled through the one package reader.
 */
export function packageFromEntries(rawFiles: Map<string, Uint8Array>): SessionPackage {
  // Separator normalization (CROSS-PLATFORM.md §3.3, hazard 4). A package zipped on Windows arrives
  // with backslash entry names (`Samples\kick.wav`), but the kit refers to samples with forward
  // slashes (`Samples/kick.wav`) and the classifier below tests `startsWith("Samples/")`. Left raw,
  // every sample fails that test, lands in `extras`, and is silently lost on import. Normalize on
  // the way IN only — `packSession` still writes forward slashes, so the save form is unchanged.
  const files = new Map<string, Uint8Array>();
  for (const [name, bytes] of rawFiles) files.set(name.replace(/\\/g, "/"), bytes);

  // A package rooted in a folder (`MySession.scoopySession/pattern.json`) is what you get when the
  // desktop's directory is zipped by Finder — or walked by a drop. Tolerate it: strip the single
  // common prefix.
  const names = [...files.keys()].filter((n) => !isFinderJunk(n));
  const prefix = commonRootPrefix(names);
  const at = (name: string) => files.get(prefix + name);

  const patternBytes = at(PATTERN_ENTRY);
  const kitBytes = at(KIT_ENTRY);
  if (!patternBytes) throw new Error(`.scoopySession is missing ${PATTERN_ENTRY}`);
  if (!kitBytes) throw new Error(`.scoopySession is missing ${KIT_ENTRY}`);

  const samples = new Map<string, Uint8Array>();
  const extras = new Map<string, Uint8Array>();
  for (const name of names) {
    const rel = name.slice(prefix.length);
    if (rel === PATTERN_ENTRY || rel === KIT_ENTRY) continue;
    if (rel.endsWith("/")) continue; // directory entry
    if (rel.startsWith(SAMPLES_DIR)) samples.set(rel, files.get(name)!);
    else extras.set(rel, files.get(name)!); // unknown — preserved, never dropped
  }

  return {
    // `AnyVersion`, not the strict decoder: a package written by an OLDER desktop is the normal
    // import, not an edge case — every session in a user's back catalogue predates some fields.
    // The migration layer is a no-op on a current file, so nothing is lost on the happy path.
    pattern: decodePatternFileAnyVersion(dec.decode(patternBytes)),
    kit: decodeKit(dec.decode(kitBytes)),
    samples,
    extras,
  };
}

/** Write a `.scoopySession` archive the desktop can open. */
export function packSession(pkg: SessionPackage): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  const stored = (b: Uint8Array): [Uint8Array, { level: 0 }] => [b, { level: 0 }];

  files[PATTERN_ENTRY] = stored(enc.encode(encodePatternFile(pkg.pattern)));
  files[KIT_ENTRY] = stored(enc.encode(encodeKit(pkg.kit)));
  for (const [name, bytes] of pkg.samples) files[name] = stored(bytes);
  for (const [name, bytes] of pkg.extras) files[name] = stored(bytes); // preserve-don't-drop
  return zipSync(files, { level: 0 });
}

/**
 * The single common root folder, or "" — so a Finder-zipped desktop package and a browser-written
 * flat archive both open.
 */
function commonRootPrefix(names: string[]): string {
  const real = names.filter((n) => !n.endsWith("/"));
  if (real.length === 0) return "";
  const first = real[0]!;
  const slash = first.indexOf("/");
  if (slash < 0) return "";
  const candidate = first.slice(0, slash + 1);
  // Only a prefix if EVERY entry shares it — otherwise `Samples/` would look like the root.
  return real.every((n) => n.startsWith(candidate)) ? candidate : "";
}
