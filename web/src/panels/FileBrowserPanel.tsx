import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  COMMANDS,
  FileBrowserState,
  HotFrameLayout,
  type BrowserEntry,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { BrowserShell, BrowserRow } from "../design/BrowserShell.tsx";
import { drawWave, type Peaks } from "./waveRender.ts";
import { DEFAULT_WAVEFORM } from "../design/waveformStyle.ts";
import "./filebrowser.css";

/**
 * The compose sample browser (BR-4) — the `.samples` half of
 * FileBrowserView.swift, the last SwiftUI surface in the compose view.
 *
 * LAYOUT: single column + breadcrumb, NOT native's Miller columns
 * (browser.md §3). Native's 160px columns inside a 280px rail force a
 * horizontal scroll and truncate every filename two levels deep — that is a
 * rail-width failure, not an idiom worth carrying over.
 *
 * OWNERSHIP: Swift lists, bookmarks, auditions and decodes (browser.md §2); the
 * web owns fold/selection/focus and sends INTENTS. `load` in particular lands on
 * BeatSequencer's own loader, so ⌥-stretch, bookmark minting, the critical
 * pushState and the undo entry are inherited rather than re-implemented.
 */

/** The drag payload a web track row accepts to load a sample into itself. */
export const SAMPLE_DRAG_MIME = "application/x-scoopy-sample";

/**
 * Cross-WKWebView drag bridge.
 *
 * The sample browser and the grid are SEPARATE WKWebViews (separate web-content
 * processes). A custom `dataTransfer` MIME type like `SAMPLE_DRAG_MIME` is NOT
 * shared across that boundary — it is stashed in WebKit-private custom data that
 * the destination webview cannot read — so a drag started in the browser reached
 * the grid with the type stripped, and the drop silently did nothing.
 *
 * Standard `text/plain` DOES cross: WebKit maps it to a public pasteboard type,
 * the same path an external text drag into a webview uses. So we carry the path
 * there too, tagged with a sentinel so ONLY our own drags are honored — a stray
 * text drop over a track row reads back no tag and is ignored. The custom MIME
 * is still set for same-webview drags (more specific, no tag to strip).
 */
const SAMPLE_DRAG_TEXT_TAG = "\u0001scoopy-sample\u0001";

/** Write the sample-drag payload onto a dragstart event (both channels). */
export function writeSampleDrag(dt: DataTransfer, path: string): void {
  dt.setData(SAMPLE_DRAG_MIME, path);
  dt.setData("text/plain", SAMPLE_DRAG_TEXT_TAG + path);
  dt.effectAllowed = "copy";
}

/**
 * True if the drag in progress looks like a sample drag. Called from dragover,
 * where the data itself is not yet readable (WebKit only exposes the type LIST
 * until drop), so a same-webview drag is known by its custom type and a
 * cross-webview one by the presence of `text/plain` — the tag is verified on
 * drop by {@link readSampleDrag}.
 */
export function hasSampleDrag(dt: DataTransfer): boolean {
  return dt.types.includes(SAMPLE_DRAG_MIME) || dt.types.includes("text/plain");
}

/** The dragged sample path on drop, or "" if this was not one of our drags. */
export function readSampleDrag(dt: DataTransfer): string {
  const direct = dt.getData(SAMPLE_DRAG_MIME);
  if (direct) return direct;
  const text = dt.getData("text/plain");
  return text.startsWith(SAMPLE_DRAG_TEXT_TAG) ? text.slice(SAMPLE_DRAG_TEXT_TAG.length) : "";
}

const PEAK_POINTS = 512;

export function FileBrowserPanel({ link }: { link: EngineLink | null }) {
  const [state, setState] = useState<FileBrowserState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("fileBrowser", (raw) => {
      const parsed = FileBrowserState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "fileBrowser" }).catch(() => {});
    return off;
  }, [link]);

  // Native shows load failures as a toast; same 1.8 s life here.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 1800);
    return () => clearTimeout(t);
  }, [notice]);

  const browse = useCallback(
    (op: string, extra: Record<string, unknown> = {}) =>
      link
        ?.command("fileBrowser", { op, ...extra })
        .then((raw) => {
          const res = COMMANDS.fileBrowser.result.safeParse(raw);
          if (res.success && res.data.notice) setNotice(res.data.notice);
        })
        .catch((err) => console.error("fileBrowser failed:", err)),
    [link],
  );

  const selected = state?.selected ?? null;

  // One decode per SELECTION — not per keystroke, and never for a directory.
  // Swift caches the envelope, so re-selecting a file costs nothing.
  useEffect(() => {
    if (!link || !selected) {
      setPeaks(null);
      setDurationMs(0);
      return;
    }
    let live = true;
    link
      .command("getFilePeaks", { path: selected, points: PEAK_POINTS })
      .then((raw) => {
        if (!live) return;
        const res = COMMANDS.getFilePeaks.result.safeParse(raw);
        if (!res.success || res.data.error) {
          setPeaks(null);
          setDurationMs(0);
          if (res.success && res.data.error) setNotice(res.data.error);
          return;
        }
        setPeaks({ minMax: res.data.minMax, rms: res.data.rms });
        setDurationMs(res.data.durationMs);
      })
      .catch(() => {
        if (live) setPeaks(null);
      });
    return () => {
      live = false;
    };
  }, [link, selected]);

  const entries = state?.entries ?? [];
  const selectedEntry = useMemo(
    () => entries.find((e) => e.path === selected) ?? null,
    [entries, selected],
  );

  // ⌥ = stretch import, on BOTH load paths. The web owns the event, so the
  // modifier travels as an explicit field rather than an NSEvent read in Swift.
  const load = (path: string, e: { altKey: boolean }, trackIndex?: number) =>
    browse("load", {
      path,
      asStretch: e.altKey,
      ...(trackIndex === undefined ? {} : { trackIndex }),
    });

  const openEntry = (entry: BrowserEntry, e: { altKey: boolean }) => {
    if (entry.isDirectory) browse("navigate", { path: entry.path });
    else load(entry.path, e);
  };

  // The arrow cursor. It may rest on a DIRECTORY, which `state.selected` never
  // can (that field is the selected FILE — a directory has nothing to audition),
  // so the two are separate and the cursor follows the selection when it moves.
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    if (state?.selected) setCursor(state.selected);
  }, [state?.selected]);

  // --- keyboard: ↑↓ move · → into a folder · ← up · ⏎ load · space audition.
  // The same meanings the native browser gives them (HotkeyManager posts
  // FileBrowserNav.*); here they are plain key events, because the WKWebView
  // owns first responder while the panel has focus.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!state) return;

    const move = (delta: number) => {
      const index = entries.findIndex((x) => x.path === cursor);
      const next = index < 0 ? (delta > 0 ? 0 : entries.length - 1) : index + delta;
      const entry = entries[Math.max(0, Math.min(entries.length - 1, next))];
      if (!entry) return;
      setCursor(entry.path);
      // Selecting is what auditions (Swift decides, per autoPlay) — so arrowing
      // over files previews them, and arrowing over folders stays silent.
      if (!entry.isDirectory) browse("select", { path: entry.path });
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "ArrowRight": {
        e.preventDefault();
        const entry = entries.find((x) => x.path === cursor);
        if (entry?.isDirectory) browse("navigate", { path: entry.path });
        break;
      }
      case "ArrowLeft":
        e.preventDefault();
        browse("up");
        break;
      case "Enter":
        e.preventDefault();
        if (state.selected) load(state.selected, e);
        break;
      case " ":
        e.preventDefault();
        browse("togglePreview");
        break;
    }
  };

  const crumbs = state?.crumbs ?? [];

  return (
    // The panel IS the whole webview here, and #root carries no height — so the
    // viewport is what the shell stretches against (the DJ browser instead
    // inherits its height from the deck row it sits in).
    <div className="fb-root">
      <BrowserShell
        title="FILES"
        fill
        // The fold is SHARED state, not view-local (unlike the DJ browser's): the
        // host sizes this webview's frame from the same key, so a fold the web
        // kept to itself would leave a transparent panel over the grid. ⌘B is the
        // other door onto it.
        expanded={!(state?.folded ?? false)}
        onExpandedChange={(v) => browse("setFolded", { value: v ? "off" : "on" })}
        railTitle="Sample browser (⌘B)"
        actions={
          <>
            <button
              onClick={() => browse("chooseFolder")}
              title={state?.root ? `Change folder — ${state.root}` : "Choose a sample folder"}
            >
              ⌘
            </button>
            <button onClick={() => browse("refresh")} title="Re-scan this folder">
              ↻
            </button>
            <button
              onClick={() =>
                browse("setSort", {
                  value: state?.sort === "date" ? "name" : "date",
                })
              }
              title={`Sorted by ${state?.sort === "date" ? "date modified" : "name"} — click to toggle`}
            >
              {state?.sort === "date" ? "date" : "a–z"}
            </button>
            <button
              className={state?.autoPlay ? "on" : undefined}
              onClick={() => browse("setAutoPlay", { value: state?.autoPlay ? "off" : "on" })}
              title={
                state?.autoPlay
                  ? "Auto-play on: click to disable"
                  : "Auto-play off: click to enable"
              }
            >
              {state?.autoPlay ? "▶" : "▷"}
            </button>
          </>
        }
        banner={
          <>
            {crumbs.length > 0 && (
              <nav className="br-crumbs mono" aria-label="Folder path">
                {crumbs.map((c, i) => (
                  <span key={c.path}>
                    {i > 0 && <span className="br-crumb-sep">›</span>}
                    <button onClick={() => browse("navigate", { path: c.path })} title={c.path}>
                      {c.name}
                    </button>
                  </span>
                ))}
              </nav>
            )}
            {state?.error && <p className="br-error mono">{state.error}</p>}
            {notice && <p className="br-notice mono">{notice}</p>}
          </>
        }
        footer={
          selectedEntry && (
            <PreviewFooter
              link={link}
              entry={selectedEntry}
              peaks={peaks}
              durationMs={durationMs}
              playing={state?.previewPlaying ?? false}
              onToggle={() => browse("togglePreview")}
              onLoad={(e) => load(selectedEntry.path, e)}
            />
          )
        }
      >
        {!state?.root ? (
          <div className="br-empty mono">
            <p>no folder</p>
            <button className="fb-choose mono" onClick={() => browse("chooseFolder")}>
              Choose folder…
            </button>
          </div>
        ) : (
          // tabIndex makes the list itself the key target — the browser is a
          // focusable region, exactly as HotkeyManager.isBrowserFocused models it.
          <ul className="br-list" tabIndex={0} onKeyDown={onKeyDown} role="listbox">
            {entries.map((entry) => (
              <BrowserRow
                key={entry.path}
                name={entry.name}
                icon={entry.isDirectory ? "▸" : "~"}
                selected={entry.path === cursor}
                title={entry.path}
                onClick={() => {
                  setCursor(entry.path);
                  if (!entry.isDirectory) browse("select", { path: entry.path });
                }}
                onDoubleClick={(e) => openEntry(entry, e)}
                draggable={!entry.isDirectory}
                onDragStart={(e) => writeSampleDrag(e.dataTransfer, entry.path)}
              />
            ))}
            {/* P3.5-E8b — AN EMPTY LIBRARY MUST OFFER THE FOLDER DOOR. The big
                "Choose folder…" button above only renders when there is no
                root, and on the merged host (and in the companion) `root` is
                never null — the library always exists, it is just empty the
                first time. So the sole folder door there was the ⌘ glyph in
                the header, which reads as decoration; a person opening the
                drawer saw the words "empty folder" and nothing to press. */}
            {entries.length === 0 && (
              <li className="br-empty mono">
                empty folder
                <button className="fb-choose mono" onClick={() => browse("chooseFolder")}>
                  Choose folder…
                </button>
              </li>
            )}
          </ul>
        )}
      </BrowserShell>
    </div>
  );
}

/**
 * The preview footer — the point of the panel: you see and hear the sample
 * BEFORE you spend a track on it.
 *
 * The waveform is peak data from Swift (`getFilePeaks`), drawn with the SAME
 * `drawWave` the grid cells use, so a sample looks identical in the browser and
 * in the row it lands on. Level and playhead ride the HotFrame at 30 Hz like
 * every other meter, rather than a UiState push storm.
 */
function PreviewFooter(props: {
  link: EngineLink | null;
  entry: BrowserEntry;
  peaks: Peaks | null;
  durationMs: number;
  playing: boolean;
  onToggle: () => void;
  onLoad: (e: { altKey: boolean }) => void;
}) {
  const { link, entry, peaks, durationMs, playing } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const meterRef = useRef<HTMLSpanElement | null>(null);
  const progressRef = useRef<HTMLSpanElement | null>(null);

  // Paint on peak change only — the waveform is static; the playhead moves.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!peaks) return;
    // Canvas needs a concrete colour string, so the token is resolved here
    // rather than hardcoded; `color` (inherited from the panel) is the fallback
    // if the var is ever missing, so no literal enters the source.
    const style = getComputedStyle(canvas);
    const color = style.getPropertyValue("--text-dim").trim() || style.color;
    drawWave(
      ctx,
      peaks,
      { x: 0, y: 0, w, h },
      { startFrac: 0, endFrac: 1, reversed: false, color },
      DEFAULT_WAVEFORM,
    );
  }, [peaks]);

  // Level + playhead: written straight to the DOM from the HotFrame, outside
  // React reconciliation (ARCHITECTURE: hot surfaces never re-render).
  useEffect(() => {
    if (!link) return;
    return link.onHotFrame((frame) => {
      const level = frame[HotFrameLayout.previewLevel] ?? 0;
      const progress = frame[HotFrameLayout.previewProgress] ?? -1;
      if (meterRef.current) {
        meterRef.current.style.width = `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`;
      }
      if (progressRef.current) {
        const on = progress >= 0;
        progressRef.current.style.opacity = on ? "1" : "0";
        if (on) progressRef.current.style.left = `${progress * 100}%`;
      }
    });
  }, [link]);

  const seconds = durationMs / 1000;
  const time = seconds >= 1 ? `${seconds.toFixed(1)}s` : `${Math.round(durationMs)}ms`;

  return (
    <div className="fb-preview">
      <div className="fb-preview-head">
        <span className="fb-preview-name mono" title={entry.path}>
          {entry.name}
        </span>
        <span className="fb-preview-time mono dim">{durationMs > 0 ? time : "—"}</span>
      </div>

      <div className="fb-wave">
        <canvas ref={canvasRef} />
        <span ref={progressRef} className="fb-wave-head" />
      </div>

      <div className="fb-preview-row">
        <button
          className="fb-play mono"
          onClick={props.onToggle}
          title={playing ? "Stop" : "Audition"}
          aria-label={playing ? "Stop" : "Audition"}
        >
          {playing ? "■" : "▶"}
        </button>
        <span className="fb-meter">
          <span ref={meterRef} className="fb-meter-fill" />
        </span>
        <button
          className="fb-load mono"
          onClick={(e) => props.onLoad(e)}
          title="Load into a new track — hold ⌥ to load as stretch"
        >
          LOAD
        </button>
      </div>
    </div>
  );
}
