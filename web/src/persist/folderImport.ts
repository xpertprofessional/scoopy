/**
 * P3.5-E7 — THE THREE DOORS A `.scoopySession` ACTUALLY ARRIVES THROUGH.
 *
 * The desktop's `.scoopySession` is a DIRECTORY. The platform gives no single
 * control that takes one, so the import needs three, and this module is the one
 * place that knows how each of them turns a gesture into `path → bytes` entries
 * for `packageFromEntries`:
 *
 *   1. a `<input type=file accept=".scoopySession,.zip">`   — the zipped form
 *   2. a `<input type=file webkitdirectory>`                — the folder, picked
 *   3. a drop                                              — the folder OR the zip
 *
 * WHY ALL THREE, stated once so it is never trimmed to one again (the deleted
 * `CompanionPanel` said it at `:463-467` and P3-L1 rebuilt the import with only
 * the first): **a file input cannot select a directory** — picking a
 * `.scoopySession` folder fires NO change event at all, so the button simply
 * looks dead ("import does not react") — and a `webkitdirectory` input cannot
 * select a file. Drag-and-drop is the only door that takes both, which is also
 * why it is the fallback when a host's picker disappoints.
 *
 * Everything here is deliberately free of React and of the store: the walk and
 * the classification are the parts worth pinning, and this project has no jsdom
 * (P6-2b's house rule — pin the decision, not the markup).
 */

/** A folder gesture, read: the root's name plus its files, rooted at that name. */
export interface DirectoryEntries {
  dirName: string;
  entries: Map<string, Uint8Array>;
}

/**
 * What a drop is. Directory FIRST and unconditionally — `dataTransfer.files`
 * flattens a dropped directory into a useless 0-byte File, so a folder that
 * fell through to the file branch would be "imported" as an empty archive.
 */
export type DroppedItem =
  | { kind: "directory"; entry: FileSystemDirectoryEntry }
  | { kind: "file"; file: File }
  | { kind: "none" };

/** The structural minimum of a `DataTransfer` — so the decision is testable. */
export interface DropLike {
  items?: ArrayLike<{ webkitGetAsEntry?: () => FileSystemEntry | null }>;
  files?: ArrayLike<File>;
}

/**
 * Classify a drop. The entry API is consulted before `files` because it is the
 * only one that can tell a directory from a file at all; `files` is the path a
 * dropped `.scoopySession.zip` takes.
 */
export function readDrop(dt: DropLike): DroppedItem {
  const entry = dt.items?.[0]?.webkitGetAsEntry?.();
  if (entry?.isDirectory) return { kind: "directory", entry: entry as FileSystemDirectoryEntry };
  const file = dt.files?.[0];
  // A dropped directory ALSO surfaces in `files` (0 bytes, no type) in some
  // engines; the entry branch above has already claimed it, so anything here is
  // a real file. The caller decides whether its NAME is one we accept.
  if (file) return { kind: "file", file };
  return { kind: "none" };
}

/**
 * The root folder's name, from a `webkitdirectory` input's relative paths.
 *
 * The picker reports every file as `<root>/…`, so the first segment is the
 * folder the user chose — the string the library names the session after. A
 * file with no relative path (an engine that does not fill it in) contributes
 * nothing rather than naming the session after a sample.
 */
export function dirNameFromRelativePaths(paths: readonly string[]): string {
  for (const p of paths) {
    const first = p.replace(/\\/g, "/").split("/")[0];
    // A single-segment path is the file itself, not a root: `kick.wav` must not
    // become the session's name.
    if (first && first !== p) return first;
  }
  return "Imported Session";
}

/** `webkitRelativePath` where the engine fills it in, the bare name otherwise. */
export function relativePathOf(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

/** A `webkitdirectory` input's FileList → the entries `packageFromEntries` reads. */
export async function entriesFromDirectoryInput(
  files: readonly File[],
): Promise<DirectoryEntries> {
  const entries = new Map<string, Uint8Array>();
  for (const f of files) entries.set(relativePathOf(f), new Uint8Array(await f.arrayBuffer()));
  return { dirName: dirNameFromRelativePaths([...entries.keys()]), entries };
}

/**
 * Recursively read a DROPPED directory into path→bytes entries (rooted at the
 * folder name, the shape `packageFromEntries` strips).
 *
 * `readEntries` returns BATCHES and must be called until it comes back empty —
 * a single call caps at 100 entries in Chromium and silently truncates a
 * 130-sample kit.
 */
export async function walkDroppedDir(
  root: FileSystemDirectoryEntry,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string): Promise<void> => {
    const reader = dir.createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (batch.length === 0) return;
      for (const entry of batch) {
        if (entry.isDirectory) {
          await walk(entry as FileSystemDirectoryEntry, `${prefix}${entry.name}/`);
        } else {
          const file = await new Promise<File>((res, rej) =>
            (entry as FileSystemFileEntry).file(res, rej),
          );
          out.set(`${prefix}${entry.name}`, new Uint8Array(await file.arrayBuffer()));
        }
      }
    }
  };
  await walk(root, `${root.name}/`);
  return out;
}
