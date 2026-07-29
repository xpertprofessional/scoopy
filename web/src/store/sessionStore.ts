/**
 * P8-6 — the session library. Where your work survives a reload.
 *
 * This is the half of the row that makes the thing a *companion* rather than a viewer: you are on a
 * plane, you close the lid, the tab reloads, and the session is still there. Nothing is exported,
 * nothing was downloaded, and no file dialog was involved.
 *
 * TWO FORMS, and keeping them straight is the whole design:
 *
 *   WORKING (in OPFS)                        PACKAGED (the transfer unit)
 *   /sessions/<name>/pattern.json            MySession.scoopySession   (a zip)
 *   /sessions/<name>/kit.json                  pattern.json
 *      kit.filePath → /samples/Kicks/808.wav   kit.json   ← filePath → Samples/808.wav
 *                                              Samples/808.wav
 *
 * The working kit points INTO the library, so a sample shared by four sessions is stored once and
 * an autosave costs two small JSON writes rather than a copy of every WAV. Only export copies the
 * audio in and rewrites the paths relative — which is exactly what the desktop's `saveSession`
 * does (PersistenceService.swift:66/76), and it is why a session was already portable before any of
 * this existed (XP-1, corrected).
 *
 * ⚠️ `kit.ts` warns: *"the companion must never write an absolute path"* — and it doesn't. The
 * library paths above never leave OPFS; `exportSession` rewrites every one of them to `Samples/…`
 * before a single byte is packed. The packaged form is the only form the desktop ever sees, and it
 * is the form P8-0's byte-identity proof and the P8-10 round-trip both cover.
 */
import { decodeKit, encodeKit, kitSamples, type KitJson, type KitSample } from "../persist/kit.ts";
import { decodePatternFileAnyVersion } from "../persist/migrations.ts";
import { encodePatternFile, type PatternFileJson } from "../persist/patternFile.ts";
import {
  packSession,
  packageFromEntries,
  unpackSession,
  SAMPLES_DIR,
  type SessionPackage,
} from "../persist/sessionPackage.ts";
import * as opfs from "./opfs.ts";
import { isAudioPath } from "./sampleStore.ts";

export const SESSION_EXTENSION = ".scoopySession";

export interface WorkingSession {
  name: string;
  pattern: PatternFileJson;
  kit: KitJson;
  /**
   * Container entries the companion did not recognise, carried verbatim.
   *
   * ⚠️ THIS FIELD IS THE WHOLE PRESERVE-DON'T-DROP RULE, ONE LEVEL UP FROM THE SCHEMA. `unpackSession`
   * keeps every archive entry it does not understand and `packSession` writes them back — but that
   * only holds if the entries SURVIVE THE TRIP THROUGH OPFS in between. Without this they would be
   * read out of the zip, dropped on the floor at import, and silently deleted on the next export: a
   * desktop that starts writing `notes.json` into the package would have it erased by any companion
   * that predates the field, and the JSON would stay perfectly well-formed while it happened. The
   * fixture's `notes.txt` exists to catch exactly this, and it did.
   */
  extras: Map<string, Uint8Array>;
}

export interface SessionSummary {
  name: string;
  modifiedMs: number;
}

function sessionDir(name: string): string {
  return opfs.joinPath(opfs.SESSIONS_ROOT, name);
}

/** Where a working session parks the archive entries it must not lose. */
function extrasDir(name: string): string {
  return `${sessionDir(name)}/_extras`;
}

/** Every session in the library, newest first. */
export async function listSessions(): Promise<SessionSummary[]> {
  await opfs.ensureDir(opfs.SESSIONS_ROOT);
  const names = await opfs.listDirs(opfs.SESSIONS_ROOT);
  const out: SessionSummary[] = [];
  for (const name of names) {
    // The pattern's mtime is the session's — the kit often does not change between saves.
    const entries = await opfs.list(sessionDir(name));
    const pattern = entries.find((e) => e.name === "pattern.json");
    out.push({ name, modifiedMs: pattern?.modifiedMs ?? 0 });
  }
  return out.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export async function saveSession(session: WorkingSession): Promise<void> {
  const dir = sessionDir(session.name);
  await opfs.ensureDir(dir);
  // Canonical bytes on the way out — the SAME encoders the package uses. An autosave that wrote a
  // different form would mean the thing we reload is not the thing we would export, and the
  // byte-identity proof would cover only half the round-trip.
  await opfs.writeFile(`${dir}/pattern.json`, encodePatternFile(session.pattern));
  await opfs.writeFile(`${dir}/kit.json`, encodeKit(session.kit));

  for (const [rel, bytes] of session.extras) {
    const target = `${extrasDir(session.name)}/${rel}`;
    await opfs.ensureDir(opfs.parentPath(target));
    await opfs.writeFile(target, bytes);
  }
}

export async function openSession(name: string): Promise<WorkingSession> {
  const dir = sessionDir(name);
  return {
    name,
    // `AnyVersion`, not the strict decoder: an autosave written by an older build of the companion
    // is exactly the case migrations exist for, and refusing to open it would lose the user's work.
    pattern: decodePatternFileAnyVersion(await opfs.readText(`${dir}/pattern.json`)),
    kit: decodeKit(await opfs.readText(`${dir}/kit.json`)),
    extras: await opfs.walkFiles(extrasDir(name)),
  };
}

export async function deleteSession(name: string): Promise<void> {
  await opfs.remove(sessionDir(name));
}

/**
 * A fresh session ON DISK — created, not loaded (P3-L1). The library's New must
 * not hijack a deck: `companionEngine.newSession` (create AND open, the
 * companion's own gesture) now rides this and adds the open.
 *
 * The document is the byte-pinned fresh-DESKTOP-save fixture, dynamically
 * imported (~540 KB nobody pays for until they click New), so a plane-born
 * session is indistinguishable from a studio-born one.
 */
export async function createSession(preferredName?: string): Promise<WorkingSession> {
  const { default: freshText } = await import("../../fixtures/patternfile/fresh-default.json?raw");
  const pattern = decodePatternFileAnyVersion(freshText);
  const taken = new Set((await listSessions()).map((s) => s.name));
  const base = preferredName?.trim() || "Untitled";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  const session: WorkingSession = {
    name,
    pattern,
    kit: { id: crypto.randomUUID().toUpperCase(), name: "Session Kit", samples: [] },
    extras: new Map(),
  };
  await saveSession(session);
  return session;
}

/**
 * Rename = open → save under the new name → delete the old dir (P3-L1). The
 * session's SAMPLES stay where they are (`/samples/<import name>/…`) and the
 * kit's `filePath`s keep pointing at them — a rename moves the identity, never
 * the audio, so it cannot break a reference.
 *
 * Refuses an existing target: silently merging two sessions' directories is a
 * data loss with a well-formed library listing.
 */
export async function renameSession(oldName: string, newName: string): Promise<void> {
  const target = newName.trim();
  if (!target) throw new Error("a session needs a name");
  if (target === oldName) return;
  const taken = new Set((await listSessions()).map((s) => s.name));
  if (taken.has(target)) throw new Error(`a session named "${target}" already exists`);
  const session = await openSession(oldName);
  await saveSession({ ...session, name: target });
  await deleteSession(oldName);
}

/**
 * Autosave. Debounced, because the caller is an edit stream: every nudge of a knob would otherwise
 * re-encode and rewrite the whole document.
 *
 * Serialized too — an autosave that overlapped its predecessor could interleave two `createWritable`
 * truncations on the same file and leave a half-written pattern.json, which is precisely the file
 * you cannot afford to corrupt.
 */
export class Autosaver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private pending: WorkingSession | null = null;

  constructor(private delayMs = 1500) {}

  schedule(session: WorkingSession): void {
    this.pending = session;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Write now — for `visibilitychange`/`pagehide`, where the debounce would lose the last edit. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const session = this.pending;
    if (!session) return;
    this.pending = null;
    this.inFlight = this.inFlight.then(() => saveSession(session)).catch((err) => {
      console.error("autosave failed:", err);
    });
    return this.inFlight;
  }
}

// ---------------------------------------------------------------------------
// Import / export — the File System Access half of the row.
// ---------------------------------------------------------------------------

/**
 * Read a `.scoopySession` into the library.
 *
 * The package's samples become REAL library folders (`/samples/<session>/…`), not hidden per-session
 * copies — so the moment you open a session from the studio, every sample it carries is browsable,
 * auditionable and reusable in the panel. That is the payoff for making OPFS the library.
 */
export async function importSessionFile(file: File): Promise<WorkingSession> {
  const pkg = unpackSession(new Uint8Array(await file.arrayBuffer()));
  return importPackage(sessionNameFrom(file.name), pkg);
}

/**
 * The FOLDER import — the desktop's `.scoopySession` as it actually sits on disk. The shell walks
 * the directory (drop via webkitGetAsEntry, or a webkitdirectory picker) into path→bytes entries;
 * from there it is the same package the zip form unwraps to.
 */
export async function importSessionEntries(
  dirName: string,
  entries: Map<string, Uint8Array>,
): Promise<WorkingSession> {
  return importPackage(sessionNameFrom(dirName), packageFromEntries(entries));
}

/** Strip `.zip` FIRST: Finder's Compress of `BXXX.scoopySession` yields `BXXX.scoopySession.zip`,
 *  and stripping only one suffix would name the library entry "BXXX.scoopySession". */
function sessionNameFrom(fileName: string): string {
  return fileName.replace(/\.zip$/i, "").replace(/\.scoopySession$/, "") || "Imported Session";
}

async function importPackage(name: string, pkg: SessionPackage): Promise<WorkingSession> {
  const libraryDir = opfs.joinPath(opfs.SAMPLES_ROOT, name);
  await opfs.ensureDir(libraryDir);

  // `Samples/808.wav` → `/samples/<session>/808.wav`, and the kit is rewritten to match.
  const relocated = new Map<string, string>();
  for (const [packagePath, bytes] of pkg.samples) {
    const rel = packagePath.startsWith(SAMPLES_DIR)
      ? packagePath.slice(SAMPLES_DIR.length)
      : packagePath;
    const target = `${libraryDir}/${rel}`;
    await opfs.ensureDir(opfs.parentPath(target));
    await opfs.writeFile(target, bytes);
    relocated.set(packagePath, target);
  }

  const kit = { ...pkg.kit };
  kit.samples = kitSamples(pkg.kit).map((sample) => ({
    ...sample,
    // A sample the archive did not carry keeps its path verbatim — a broken reference we can SEE
    // beats a silently rewritten one that points at nothing.
    filePath: relocated.get(sample.filePath) ?? sample.filePath,
  }));

  // pkg.extras carried through untouched — see WorkingSession.extras.
  const session: WorkingSession = { name, pattern: pkg.pattern, kit, extras: pkg.extras };
  await saveSession(session);
  return session;
}

/**
 * Package a working session for the studio: copy the audio in, rewrite the paths relative, zip.
 *
 * ⚠️ BASENAME COLLISIONS ARE REAL. The library is a tree, so `/samples/Kicks/hit.wav` and
 * `/samples/Snares/hit.wav` are different samples with the same basename — and `Samples/` in the
 * package is FLAT. Left alone, the second would overwrite the first in the zip and two tracks would
 * silently play the same audio on the desktop. So names are de-duplicated on the way out, and the
 * kit is rewritten to the de-duplicated name.
 */
export async function packageSession(
  session: WorkingSession,
): Promise<{ bytes: Uint8Array; missing: string[] }> {
  const samples = new Map<string, Uint8Array>();
  const used = new Set<string>();
  const missing: string[] = [];

  const rewritten: KitSample[] = [];
  for (const sample of kitSamples(session.kit)) {
    let bytes: Uint8Array;
    try {
      bytes = await opfs.readFile(sample.filePath);
    } catch {
      // The sample is gone from the library. Keep the kit entry (preserve-don't-drop) and TELL the
      // caller — an export that quietly shipped a session with a missing sample is a bug you would
      // only discover back in the studio.
      missing.push(sample.name);
      rewritten.push(sample);
      continue;
    }

    const packagePath = SAMPLES_DIR + uniqueName(opfs.baseName(sample.filePath), used);
    samples.set(packagePath, bytes);
    rewritten.push({ ...sample, filePath: packagePath });
  }

  const kit = { ...session.kit, samples: rewritten };
  return {
    bytes: packSession({ pattern: session.pattern, kit, samples, extras: session.extras }),
    missing,
  };
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? "" : name.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Hand the packaged session to the user. `showSaveFilePicker` gives a real Save dialog where it
 * exists; everywhere else it is a download, which is the same outcome with less ceremony.
 *
 * MUST be called from a user gesture — like every other door out of a browser.
 */
export async function exportSession(session: WorkingSession): Promise<{ missing: string[] }> {
  const fileName = `${session.name}${SESSION_EXTENSION}`;
  const picker = (
    window as Window & {
      showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  // The picker must be opened inside the gesture, so it goes FIRST — before the packaging await.
  const handle = picker
    ? await picker({
        suggestedName: fileName,
        types: [
          {
            description: "ScoopyLoops session",
            accept: { "application/zip": [SESSION_EXTENSION, ".zip"] },
          },
        ],
      }).catch((err: Error) => {
        if (err.name === "AbortError") return null;
        throw err;
      })
    : undefined;

  if (handle === null) return { missing: [] }; // cancelled

  const { bytes, missing } = await packageSession(session);

  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(bytes.slice() as Uint8Array<ArrayBuffer>);
    await writable.close();
  } else {
    const url = URL.createObjectURL(new Blob([bytes.slice() as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return { missing };
}

/** Drop a `.scoopySession` (or a loose sample) — what a browser is actually good at. */
export function isSessionFile(file: File): boolean {
  return file.name.endsWith(SESSION_EXTENSION) || /\.zip$/i.test(file.name);
}

export { isAudioPath };
