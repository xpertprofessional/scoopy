/**
 * P8-6 — the file browser, over OPFS. The TS twin of `WebFileBrowserBinding.swift`.
 *
 * The schema called this shot two phases ago and wrote down why (schema.ts:704-707):
 *
 *   > Directory listing stays Swift by Domain Ownership: a WKWebView cannot read arbitrary disk
 *   > paths, and **the browser target swaps this for OPFS — so the listing is a pushed topic from
 *   > day one, never a web-side `fs` call.**
 *
 * This is that swap being cashed in. `FileBrowserPanel.tsx` is **not modified by this row**: it
 * subscribes to the `fileBrowser` topic and sends the same ten ops, and it never learns whether a
 * `FileManager` or an OPFS handle tree answered. Every path it holds is opaque to it.
 *
 * WHAT CHANGES MEANING, AND WHAT DOESN'T:
 *
 * - `chooseFolder` — on the desktop it POINTS the library at a folder (and mints a security-scoped
 *   bookmark). A browser has no such power and never will: the only legal door is a user-gesture
 *   picker, and what comes back is bytes, not a lease on a directory. So here it IMPORTS: pick a
 *   folder, copy its audio into the library, navigate to it. The user's intent behind the button —
 *   *"get my samples in here"* — is preserved exactly; the mechanism cannot be.
 * - `root` is therefore never null. The library always exists (it may be empty), so the panel's
 *   "no folder" empty state never shows in the companion — an empty library shows "empty folder"
 *   and the ⌘ button, which is the truthful thing for it to say.
 * - `load` — the honest boundary. See `load()` below.
 */
import type { BrowserCrumb, BrowserEntry, FileBrowserState } from "../../protocol/schema.ts";
import * as opfs from "./opfs.ts";
import { isAudioPath, type SampleStore } from "./sampleStore.ts";
import { PreviewPlayer } from "./preview.ts";

/** The same @AppStorage keys the native browser uses — ONE owner, shared with the General panel. */
export const SETTING_SORT = "fileBrowserSortOption";
export const SETTING_AUTOPLAY = "fileBrowserAutoPlay";
export const SETTING_FOLDED = "fileBrowserFolded";

export interface BrowserSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export class FileBrowserBackend {
  private cwd = opfs.SAMPLES_ROOT;
  private entries: BrowserEntry[] = [];
  private selected: string | null = null;
  private error: string | null = null;
  private preview: PreviewPlayer;

  constructor(
    private store: SampleStore,
    private settings: BrowserSettings,
    /** Push the `fileBrowser` topic. Called on every state change — the panel is push-driven. */
    private publish: (state: FileBrowserState) => void,
  ) {
    this.preview = new PreviewPlayer(store, () => this.publish(this.state()));
  }

  /** The audition player, so the link's HotFrame pump can read its level/progress. */
  get player(): PreviewPlayer {
    return this.preview;
  }

  private get sort(): "name" | "date" {
    return this.settings.get(SETTING_SORT) === "date" ? "date" : "name";
  }

  private get autoPlay(): boolean {
    return this.settings.get(SETTING_AUTOPLAY) === true;
  }

  private get folded(): boolean {
    return this.settings.get(SETTING_FOLDED) === true;
  }

  /** Create the library if this origin has never seen it, then list. */
  async init(): Promise<void> {
    await opfs.ensureDir(opfs.SAMPLES_ROOT);
    await this.rescan();
  }

  state(): FileBrowserState {
    return {
      root: opfs.SAMPLES_ROOT,
      cwd: this.cwd,
      crumbs: this.crumbs(),
      entries: this.entries,
      selected: this.selected,
      sort: this.sort,
      autoPlay: this.autoPlay,
      previewPlaying: this.preview.playing,
      folded: this.folded,
      error: this.error,
    };
  }

  /**
   * root → cwd. Served, not derived in the panel — the schema is explicit that only the owner knows
   * where the root actually is, and that contract holds here even though our paths happen to be
   * splittable strings. The panel must not start splitting on "/" just because this backend could.
   */
  private crumbs(): BrowserCrumb[] {
    const rootSegs = opfs.segments(opfs.SAMPLES_ROOT);
    const cwdSegs = opfs.segments(this.cwd);
    const out: BrowserCrumb[] = [{ path: opfs.SAMPLES_ROOT, name: "Library" }];
    for (let i = rootSegs.length; i < cwdSegs.length; i++) {
      out.push({
        path: `/${cwdSegs.slice(0, i + 1).join("/")}`,
        name: cwdSegs[i]!,
      });
    }
    return out;
  }

  private async rescan(): Promise<void> {
    try {
      const raw = await opfs.list(this.cwd);
      // Directories first, then the sort order — the native browser's ordering, kept verbatim.
      const dirs = raw.filter((e) => e.isDirectory);
      const files = raw.filter((e) => !e.isDirectory && isAudioPath(e.path));
      const byName = (a: opfs.OpfsEntry, b: opfs.OpfsEntry) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      const byDate = (a: opfs.OpfsEntry, b: opfs.OpfsEntry) => b.modifiedMs - a.modifiedMs;
      const order = this.sort === "date" ? byDate : byName;

      dirs.sort(byName); // directories always sort by name; date is meaningless for them here
      files.sort(order);
      this.entries = [...dirs, ...files];
      this.error = null;

      // A selection that no longer exists (deleted, or we navigated away) must not linger — the
      // footer would render a waveform for a file that is gone.
      if (this.selected && !this.entries.some((e) => e.path === this.selected)) {
        this.selected = null;
      }
    } catch (err) {
      this.entries = [];
      this.error = `cannot read ${this.cwd}: ${(err as Error).message}`;
    }
  }

  /**
   * The `fileBrowser` command. Returns the same `{notice}` result Swift does.
   *
   * ⚠️ The synchronous prefix matters: `chooseFolder` opens a picker, and a browser only allows that
   * while the user gesture is still live. Nothing may be awaited before it.
   */
  async handle(params: {
    op: string;
    path?: string;
    value?: string;
    trackIndex?: number;
    asStretch?: boolean;
  }): Promise<{ notice: string | null }> {
    switch (params.op) {
      case "chooseFolder":
        return this.chooseFolder(); // MUST stay first-touch — see above

      case "refresh":
        this.store.invalidate(this.selected ?? "");
        await this.rescan();
        break;

      case "navigate":
        if (params.path) {
          this.cwd = params.path;
          await this.rescan();
        }
        break;

      case "up":
        if (this.cwd !== opfs.SAMPLES_ROOT) {
          this.cwd = opfs.parentPath(this.cwd);
          await this.rescan();
        }
        break;

      case "select":
        return this.select(params.path);

      case "togglePreview":
        return this.togglePreview();

      case "setSort":
        this.settings.set(SETTING_SORT, params.value === "date" ? "date" : "name");
        await this.rescan();
        break;

      case "setAutoPlay":
        this.settings.set(SETTING_AUTOPLAY, params.value === "on");
        break;

      case "setFolded":
        this.settings.set(SETTING_FOLDED, params.value === "on");
        break;

      case "load":
        return this.load();

      default:
        return { notice: `unknown op: ${params.op}` };
    }

    this.publish(this.state());
    return { notice: null };
  }

  private async select(path?: string): Promise<{ notice: string | null }> {
    if (!path) return { notice: null };
    this.selected = path;
    this.publish(this.state());

    if (this.autoPlay) {
      try {
        await this.preview.play(path);
        this.publish(this.state());
      } catch (err) {
        return { notice: `cannot play ${opfs.baseName(path)}: ${(err as Error).message}` };
      }
    }
    return { notice: null };
  }

  private async togglePreview(): Promise<{ notice: string | null }> {
    if (this.preview.playing) {
      this.preview.stop();
      this.publish(this.state());
      return { notice: null };
    }
    if (!this.selected) return { notice: null };
    try {
      await this.preview.play(this.selected);
      this.publish(this.state());
      return { notice: null };
    } catch (err) {
      return { notice: `cannot play: ${(err as Error).message}` };
    }
  }

  /**
   * THE HONEST BOUNDARY — and it is deliberately loud.
   *
   * On the desktop `load` is an INTENT that lands on BeatSequencer's one loader, which adds the
   * track, mints the bookmark, pushes state and writes the undo entry. In the companion there is no
   * BeatSequencer: `worldWire` is a PIPE to Swift, and `ScoopyAudio.World` is the engine's flat
   * render world (sampleId + steps), not the PatternFile document. **TS does not own a document
   * yet — that is THE FLIP (P5-06 step D), and it is not this row.**
   *
   * So `load` cannot work here, and the one thing it must not do is nothing. A silent no-op is
   * indistinguishable from a dead wire — the exact failure this codebase has now been bitten by
   * three times (the dead context-menu items, the frozen DJ topic, the inert launchQuantize picker).
   * It says so, in the panel's own toast.
   *
   * Everything `load` NEEDS is already built and tested underneath it: the bytes are in OPFS, the
   * decode is cached, and `SampleStore.registerKit` hands the engine the audio keyed by the very
   * UUID a track would name. The day TS owns the document, this method is a few lines.
   */
  private load(): { notice: string | null } {
    return { notice: "load needs the TS document — THE FLIP (P5-06 step D). Preview works." };
  }

  /** Peak envelope for the footer waveform. Same result shape as Swift's `getFilePeaks`. */
  async peaks(
    path: string,
    points: number,
  ): Promise<{ minMax: number[]; rms: number[]; durationMs: number; error: string | null }> {
    try {
      const envelope = await this.store.peakEnvelope(path, points);
      return { ...envelope, error: null };
    } catch (err) {
      return { minMax: [], rms: [], durationMs: 0, error: (err as Error).message };
    }
  }

  /**
   * Import a folder of samples into the library.
   *
   * `showDirectoryPicker()` is the File System Access API this row names, and it is the better door
   * where it exists (a real folder picker). Firefox and Safari do not have it, so the fallback is an
   * `<input webkitdirectory>` — which is not a lesser hack but the same transaction: a user gesture,
   * a folder, and bytes copied in. Both are user-gesture pickers; neither is programmatic, and the
   * ledger is right that a programmatic one cannot exist.
   */
  private async chooseFolder(): Promise<{ notice: string | null }> {
    const picker = (
      window as Window & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;

    try {
      const picked = picker
        ? await this.pickViaFileSystemAccess(picker)
        : await this.pickViaInput();
      if (!picked) return { notice: null }; // user cancelled — not an error

      const { name, files } = picked;
      if (files.length === 0) return { notice: "no audio files in that folder" };

      const dest = opfs.joinPath(opfs.SAMPLES_ROOT, name);
      const { imported, skipped } = await this.store.importFiles(dest, files);

      this.cwd = dest;
      await this.rescan();
      this.publish(this.state());

      const skippedNote = skipped > 0 ? `, ${skipped} skipped` : "";
      return { notice: `imported ${imported} sample${imported === 1 ? "" : "s"}${skippedNote}` };
    } catch (err) {
      // AbortError = the user closed the picker. That is a choice, not a failure.
      if ((err as Error).name === "AbortError") return { notice: null };
      return { notice: `import failed: ${(err as Error).message}` };
    }
  }

  private async pickViaFileSystemAccess(
    picker: () => Promise<FileSystemDirectoryHandle>,
  ): Promise<{ name: string; files: File[] } | null> {
    const handle = await picker();
    const files: File[] = [];
    await collectFiles(handle, "", files);
    return { name: handle.name, files };
  }

  private pickViaInput(): Promise<{ name: string; files: File[] } | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      // Non-standard but universally implemented; TS's lib.dom has no type for it.
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.style.display = "none";

      input.addEventListener("change", () => {
        const files = [...(input.files ?? [])];
        input.remove();
        if (files.length === 0) return resolve(null);
        // webkitRelativePath is "FolderName/sub/file.wav" — its first segment names the folder.
        const first = files[0] as File & { webkitRelativePath?: string };
        const name = first.webkitRelativePath?.split("/")[0] || "Imported";
        resolve({ name, files });
      });
      // A cancelled picker fires no event in older browsers; `cancel` covers the modern ones and a
      // stuck promise is harmless (the command just never resolves and no state changed).
      input.addEventListener("cancel", () => {
        input.remove();
        resolve(null);
      });

      document.body.append(input);
      input.click();
    });
  }
}

/** Walk a picked directory handle. Recursive: a drum folder keeps its sub-folders. */
async function collectFiles(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: File[],
): Promise<void> {
  for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      await collectFiles(handle as FileSystemDirectoryHandle, rel, out);
    } else if (isAudioPath(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      // Re-wrap so `webkitRelativePath` carries the folder shape, exactly as the input path gives it.
      Object.defineProperty(file, "webkitRelativePath", { value: rel });
      out.push(file);
    }
  }
}
