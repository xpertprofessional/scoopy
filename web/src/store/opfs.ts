/**
 * P8-6 — OPFS, as a filesystem.
 *
 * The Origin Private File System is the companion's disk. It is real, persistent, origin-scoped
 * storage that survives a reload and a closed laptop lid, and — unlike a mounted directory handle —
 * it needs no permission prompt, works in every browser, and cannot be revoked out from under a
 * session mid-flight. That is why the ledger settled on it: *"OPFS is the store; the zipped session
 * package is the transport."*
 *
 * ⚠️ THE WHOLE MODULE IS A PATH→HANDLE ADAPTER, and that is the point. OPFS's native API is a
 * handle tree (`getDirectoryHandle` / `getFileHandle`, one level at a time), while every surface
 * above it — `FileBrowserState.entries[].path`, the kit's `filePath`, every `fileBrowser` op — speaks
 * an opaque POSIX-ish STRING. The schema promised exactly this and said why (schema.ts:704-707):
 * the listing is a pushed topic, never a web-side `fs` call, precisely so the panel never learns
 * which kind of filesystem is underneath it. So the string↔handle walk happens HERE, once, and
 * nothing above this file ever sees a `FileSystemHandle`.
 *
 * Paths are absolute, "/"-separated, and rooted at the OPFS root: `/samples/Kicks/808.wav`.
 * There is no cwd here — callers pass whole paths.
 */

/** Where the two libraries live. Everything the companion persists is under one of these. */
export const SAMPLES_ROOT = "/samples";
export const SESSIONS_ROOT = "/sessions";

export interface OpfsEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedMs: number;
}

/** True when this browser can be the companion's disk at all. */
export function opfsAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

/** Split "/a/b/c" → ["a","b","c"]; "" and "/" → []. */
export function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  const parts = segments(path);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function baseName(path: string): string {
  return segments(path).pop() ?? "";
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/**
 * Walk to a directory. `create` makes it `mkdir -p`; without it, a missing segment throws
 * NotFoundError, which callers turn into a browser `error` string rather than a crash.
 */
export async function dirHandle(
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let handle = await root();
  for (const seg of segments(path)) {
    handle = await handle.getDirectoryHandle(seg, { create });
  }
  return handle;
}

async function fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
  const dir = await dirHandle(parentPath(path), create);
  return dir.getFileHandle(baseName(path), { create });
}

export async function ensureDir(path: string): Promise<void> {
  await dirHandle(path, true);
}

export async function writeFile(path: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await fileHandle(path, true);
  const writable = await handle.createWritable();
  try {
    // A fresh BlobPart per write: `createWritable()` truncates by default, so this is a full
    // replace, not an append.
    await writable.write(typeof bytes === "string" ? bytes : (bytes.slice() as Uint8Array<ArrayBuffer>));
  } finally {
    await writable.close();
  }
}

export async function readFile(path: string): Promise<Uint8Array> {
  const handle = await fileHandle(path);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

export async function readText(path: string): Promise<string> {
  const handle = await fileHandle(path);
  return (await handle.getFile()).text();
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fileHandle(path);
    return true;
  } catch {
    try {
      await dirHandle(path);
      return true;
    } catch {
      return false;
    }
  }
}

export async function remove(path: string): Promise<void> {
  const dir = await dirHandle(parentPath(path));
  await dir.removeEntry(baseName(path), { recursive: true });
}

/**
 * One level of a directory. Unsorted — ordering is the browser backend's business (it owns the
 * name/date toggle), and mixing the two concerns here would make the sort untestable.
 *
 * `sizeBytes`/`modifiedMs` cost a `getFile()` per entry, which is why directories report 0/0 and
 * are never opened: `FileBrowserState.entries` declares `sizeBytes: 0 for directories`, so this is
 * the schema's own contract, not a shortcut.
 */
export async function list(path: string): Promise<OpfsEntry[]> {
  const dir = await dirHandle(path);
  const out: OpfsEntry[] = [];
  for await (const [name, handle] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    const entryPath = joinPath(path, name);
    if (handle.kind === "directory") {
      out.push({ path: entryPath, name, isDirectory: true, sizeBytes: 0, modifiedMs: 0 });
    } else {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({
        path: entryPath,
        name,
        isDirectory: false,
        sizeBytes: file.size,
        modifiedMs: file.lastModified,
      });
    }
  }
  return out;
}

/** Directory names only — the session library's listing. */
export async function listDirs(path: string): Promise<string[]> {
  const entries = await list(path);
  return entries.filter((e) => e.isDirectory).map((e) => e.name);
}

/**
 * Every file under `path`, recursively, keyed by its path RELATIVE to `path`. Returns empty for a
 * directory that does not exist — the caller (a session with no preserved extras) is not an error.
 */
export async function walkFiles(path: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await list(dir)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(entry.path, rel);
      else out.set(rel, await readFile(entry.path));
    }
  };
  try {
    await walk(path, "");
  } catch {
    return out;
  }
  return out;
}

/**
 * Copy a whole subtree into `dest`, flattening nothing. Used when an imported session's `Samples/`
 * become library folders.
 */
export async function copyInto(
  dest: string,
  files: Iterable<[string, Uint8Array]>,
): Promise<void> {
  await ensureDir(dest);
  for (const [rel, bytes] of files) {
    const target = `${dest}/${rel}`;
    await ensureDir(parentPath(target));
    await writeFile(target, bytes);
  }
}
