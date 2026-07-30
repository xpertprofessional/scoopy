/**
 * P8-7 — THE COMPANION SHELL. The first surface of this app that is not a Mac.
 *
 * Everything it drives already existed and was unreachable: the WASM engine (P8-1/P8-2), the OPFS
 * session library and sample store (P8-0/P8-6), the session→World converter. The only thing that had
 * ever run that chain end to end was a test. This is the door.
 *
 * P8-12: IT NOW EDITS THE PATTERN. The grid runs here unmodified — `GridBackend` serves the
 * `gridMeta` / `gridPattern/<i>` / `gridRuntime/<i>` topics from the session document (the 78-field
 * projection `gridProjection.ts` mirrors from `WebGridBinding`) and takes `publishTrackPattern` back
 * into the document. The panel cannot tell it is not Swift.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { BrowserLink } from "../browserLink.ts";
import type { EngineLink } from "../engineLink.ts";
import { enabledScenes, projectScene } from "../audio/sceneProjection.ts";
import { lcmForScene } from "../audio/patternClock.ts";
import { Button, Caption, PanelTitle, SectionTitle } from "../design/controls.tsx";
import { kitSamples } from "../persist/kit.ts";
import {
  useCompanion,
  useCompanionDeck,
  flushAutosave,
  engineLevel,
  enginePosition,
  applyGridRow,
  gridRuntimeInfos,
  gridPeakPaths,
  importAudioFile,
  toggleLocatorRepeatTrack,
} from "../store/companionEngine.ts";
import { isSessionFile } from "../store/sessionStore.ts";
// P3.5-E7: the folder doors moved to `persist/folderImport.ts` and the plane's
// library uses the SAME ones. Two copies of a directory walk is how the plane
// ended up with one door out of three.
import {
  entriesFromDirectoryInput,
  readDrop,
  walkDroppedDir,
} from "../persist/folderImport.ts";
import { isCoarsePointer } from "../design/pointerCapability.ts";
import { FileBrowserPanel } from "./FileBrowserPanel.tsx";
import { GridPanel } from "./GridPanel.tsx";
import "./companion.css";
import "./scenes.css";

export function CompanionPanel({ link }: { link: EngineLink | null }) {
  const s = useCompanionDeck();

  // Wire the store's document into the grid, ONCE: register the edit handler, and reload the grid
  // whenever the open session changes. `link` is a BrowserLink in the companion (the App routes
  // ?host=browser here), but the panel only sees the EngineLink interface, so narrow to reach the
  // grid backend — the one place the companion knows more about its link than a panel usually may.
  const browserLink = link instanceof BrowserLink ? link : null;
  useEffect(() => {
    browserLink?.setGridEditHandler(applyGridRow);
    // The two sample doors: a library file (double-click / row-drop in FILES) and the LOAD
    // button's OS picker. Both end in the same document edit, `loadSample`.
    browserLink?.setSampleLoadHandler(async (trackIndex, path) => {
      await useCompanion.getState().loadSample(trackIndex, path);
    });
    browserLink?.setSamplePickHandler(async (trackIndex) => {
      try {
        const file = await pickAudioFile();
        if (!file) return;
        const path = await importAudioFile(file);
        await useCompanion.getState().loadSample(trackIndex, path);
        // The imported file is a library citizen now — show it in FILES.
        void browserLink.command("fileBrowser", { op: "refresh" });
      } catch (err) {
        useCompanion.setState({ error: `sample import failed: ${(err as Error).message}` });
      }
    });
    // The grid's ▶/■: flip the runtime gate, then push the row states back so the buttons repaint.
    browserLink?.setLaunchToggleHandler((trackIndex) => {
      useCompanion.getState().toggleLaunch(trackIndex);
      browserLink.gridBackend.updateRuntime(gridRuntimeInfos());
    });
    // Solo: same runtime shape — every row republishes so the peers' recede language updates too.
    browserLink?.setSoloToggleHandler((trackIndex) => {
      useCompanion.getState().toggleSoloTrack(trackIndex);
      browserLink.gridBackend.updateRuntime(gridRuntimeInfos());
    });
    // ↻ locator repeat: a scene-aware document flip (the grid repaints via the session reload).
    browserLink?.setLocatorRepeatHandler(toggleLocatorRepeatTrack);
  }, [browserLink]);
  useEffect(() => {
    if (!browserLink) return;
    if (s.session) {
      browserLink.setGridPeakPaths(gridPeakPaths());
      // The grid shows (and edits) the ACTIVE SCENE's projection — what you see is what you hear.
      // The write path splits the edited row back into scene section vs sectionA (applyGridRow).
      browserLink.gridBackend.load(
        projectScene(s.session.pattern, s.scene) as Record<string, unknown>,
        gridRuntimeInfos(),
      );
    } else {
      browserLink.gridBackend.clear();
    }
  }, [browserLink, s.session, s.scene]);
  // Keep the grid's playhead flag honest with the transport.
  useEffect(() => {
    browserLink?.gridBackend.setPlaying(s.playing);
  }, [browserLink, s.playing]);

  useEffect(() => {
    void s.refresh();
    // The debounce would eat the last edit if the tab goes away mid-window — and "the tab went away"
    // is the normal way a browser session ends, not an edge case.
    const flush = () => void flushAutosave();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!s.notice) return;
    const t = setTimeout(() => s.dismissNotice(), 2400);
    return () => clearTimeout(t);
  }, [s.notice, s]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    // The desktop's `.scoopySession` is a DIRECTORY, and that is what a user naturally drags in.
    // `readDrop` reads the entry API first for that reason (folderImport.ts).
    const drop = readDrop(e.dataTransfer);
    if (drop.kind === "directory") {
      void walkDroppedDir(drop.entry).then((files) => s.importEntries(drop.entry.name, files));
      return;
    }
    if (drop.kind === "file" && isSessionFile(drop.file)) void s.importFile(drop.file);
  };

  const tracks = s.session ? kitSamples(s.session.kit) : [];
  const bpm = (s.session?.pattern.bpm as number | undefined) ?? 120;
  // Touch devices (companion.css `touch-capable`) turn the rail into an
  // overlay drawer so the grid + track rows own the full width — the surface
  // the tablet is held landscape to use. `railOpen` is its latch; on desktop
  // the toggle is display:none and the class is inert (the rail contents never
  // move — one control, one home).
  const [railOpen, setRailOpen] = useState(false);
  // The sample browser folds away inside the drawer (default folded on touch,
  // open on desktop where the rail is always visible). It stays MOUNTED when
  // folded — CSS hides it — so expanding never re-fetches the library.
  const [browserOpen, setBrowserOpen] = useState(() => !isCoarsePointer());

  return (
    <div
      className={`cmp-root${railOpen ? " rail-open" : ""}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="cmp-head">
        <button
          className="cmp-rail-toggle mono"
          onClick={() => setRailOpen((v) => !v)}
          aria-expanded={railOpen}
        >
          {railOpen ? "✕ CLOSE" : "☰ FILES"}
        </button>
        <PanelTitle>SCOOPYLOOPS · COMPANION</PanelTitle>
        <Caption>
          compose away from the studio — sessions live in this browser, and travel as
          .scoopySession
        </Caption>
      </header>

      <div className="cmp-body">
        <aside className="cmp-rail">
          <SectionTitle>SESSIONS</SectionTitle>

          {s.sessions.length === 0 && (
            <p className="cmp-empty mono">
              no sessions yet — drop a <code>.scoopySession</code> (the folder itself, or a zip of
              it) anywhere on this page
            </p>
          )}

          <ul className="cmp-sessions">
            {s.sessions.map((entry) => (
              <li key={entry.name}>
                <button
                  className={`cmp-session mono${entry.name === s.session?.name ? " on" : ""}`}
                  onClick={() => {
                    void s.open(entry.name);
                    setRailOpen(false); // drawer mode: opening a session is leaving the rail
                  }}
                  title={entry.name}
                >
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>

          <div className="cmp-rail-actions">
            <Button label="New" onClick={() => void s.newSession()} />
            <ImportButton onFile={(f) => void s.importFile(f)} />
            <Button
              label="Export…"
              onClick={() => void s.exportCurrent()}
              disabled={!s.session}
            />
          </div>

          <button
            className="cmp-browser-toggle mono"
            onClick={() => setBrowserOpen((v) => !v)}
            aria-expanded={browserOpen}
          >
            {browserOpen ? "▾ SAMPLES" : "▸ SAMPLES"}
          </button>
          <div className={`cmp-browser${browserOpen ? "" : " folded"}`}>
            <FileBrowserPanel link={link} />
          </div>
        </aside>

        <main className="cmp-main">
          <Transport />

          {s.session ? (
            <>
              <SectionTitle>{s.session.name}</SectionTitle>
              <p className="cmp-meta mono dim">
                {bpm.toFixed(1)} BPM · {tracks.length} sample{tracks.length === 1 ? "" : "s"} in the
                kit
              </p>

              {/* THE GRID — the same component the desktop runs, over the document. Editing here
                  folds straight back into the session and re-publishes the world, so you hear the
                  edit. */}
              <div className="cmp-grid">
                <GridPanel link={link} />
              </div>
            </>
          ) : (
            <p className="cmp-empty mono">open a session, or drop a .scoopySession</p>
          )}

          {s.missingSamples.length > 0 && (
            <p className="cmp-warn mono">
              ⚠️ {s.missingSamples.length} track(s) name a sample this kit does not carry — they will
              not sound.
            </p>
          )}
          {s.decodeFailures.length > 0 && (
            <p className="cmp-warn mono">
              ⚠️ could not decode: {s.decodeFailures.map((f) => f.name).join(", ")}
            </p>
          )}
          {s.error && <p className="cmp-error mono">{s.error}</p>}
          {s.notice && <p className="cmp-notice mono">{s.notice}</p>}
        </main>
      </div>
    </div>
  );
}

/**
 * The transport. `START ENGINE` is a button and not an effect, and that is deliberate: a browser
 * blocks an AudioContext that was not born in a user gesture, and it does so SILENTLY — the context
 * suspends, every call succeeds, and no sound comes out. Better a button that says what it does.
 */
function Transport() {
  const s = useCompanionDeck();
  const bpm = (s.session?.pattern.bpm as number | undefined) ?? 120;
  // The bpm the engine actually hears for the active scene (a scene can PIN tempo). The box
  // edits the GLOBAL base — same rule as every unpinned control.
  const resolvedBpm = s.session ? ((projectScene(s.session.pattern, s.scene).bpm as number) ?? bpm) : bpm;
  const scenes = s.session ? enabledScenes(s.session.pattern) : [];
  const meterRef = useRef<HTMLSpanElement | null>(null);
  const lcmRef = useRef<HTMLSpanElement | null>(null);
  const lcmTextRef = useRef<HTMLSpanElement | null>(null);
  // The active scene's cycle length in master-steps — scheduled switches land on its end.
  const cycleLen = useMemo(
    () => (s.session ? lcmForScene(s.session.pattern, s.scene) : 16),
    [s.session, s.scene],
  );

  // Written straight to the DOM on rAF, outside React — a level is a hot surface, and re-rendering
  // the shell 60×/s to move one bar is exactly what the rest of the app refuses to do. The LCM bar
  // rides the same tick: position comes from the worklet's transport mirror (enginePosition).
  useEffect(() => {
    if (s.engine !== "running") return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const bar = meterRef.current;
      if (bar) bar.style.width = `${Math.round(Math.min(1, engineLevel() * 3) * 100)}%`;
      const lcmBar = lcmRef.current;
      const lcmText = lcmTextRef.current;
      const pos = enginePosition();
      if (lcmBar && lcmText) {
        if (!pos?.playing || pos.framesPerStep <= 0) {
          lcmBar.style.width = "0";
          lcmText.textContent = `·/${cycleLen}`;
        } else {
          const inCycle = (pos.step % cycleLen) + pos.stepFrame / pos.framesPerStep;
          lcmBar.style.width = `${Math.min(100, (inCycle / cycleLen) * 100)}%`;
          lcmText.textContent = `${(pos.step % cycleLen) + 1}/${cycleLen}`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [s.engine, cycleLen]);

  return (
    <div className="cmp-transport">
      {s.engine !== "running" ? (
        <Button
          label={
            s.engine === "starting"
              ? "starting…"
              : s.engine === "failed"
                ? "retry engine"
                : "START ENGINE"
          }
          onClick={() => void s.startEngine()}
          disabled={s.engine === "starting"}
        />
      ) : (
        <>
          <button
            className={`cmp-play mono${s.playing ? " on" : ""}`}
            onClick={() => (s.playing ? s.stop() : s.play())}
            disabled={!s.session}
            aria-label={s.playing ? "Stop" : "Play"}
          >
            {s.playing ? "■" : "▶"}
          </button>

          <label
            className="cmp-bpm mono"
            title={
              resolvedBpm !== bpm
                ? `scene ${s.scene} pins tempo (${resolvedBpm.toFixed(1)}) — edits write the global base`
                : undefined
            }
          >
            <input
              type="number"
              min={20}
              max={300}
              step={0.5}
              value={resolvedBpm}
              disabled={!s.session}
              onChange={(e) => s.setBpm(Number(e.target.value))}
            />
            BPM
          </label>

          {/* The proof that it is actually making sound, and not merely claiming to. */}
          <span className="cmp-meter" title="engine output">
            <span ref={meterRef} className="cmp-meter-fill" />
          </span>

          {/* The pattern cycle — where scheduled switches land. */}
          <span
            className="cmp-lcm"
            title="pattern cycle (LCM of all track lengths) — a scheduled scene switch fires at its end"
          >
            <span ref={lcmRef} className="cmp-lcm-fill" />
          </span>
          <span ref={lcmTextRef} className="cmp-lcm-text mono dim" />
        </>
      )}

      {/* Scene pads — the browser home of pattern-scene switching (the desktop's live in the
          transport strip). While playing, a click SCHEDULES the switch at the cycle boundary
          (blinking pad = pending; clicking the active pad cancels); ⌘-click switches now.
          Interactive before the engine starts: the selection latches, the first publish honors it. */}
      {scenes.length > 0 && (
        <div
          className="scene-pads cmp-scenes"
          title="Pattern scene — click schedules at the cycle end (⌘-click: switch now · active pad: cancel) · keys 1–8"
        >
          {scenes.map((letter, i) => (
            <button
              key={letter}
              className={
                letter === s.scene
                  ? "scene-pad is-active ds-hot"
                  : letter === s.scheduledScene
                    ? "scene-pad is-scheduled ds-hot"
                    : "scene-pad ds-hot"
              }
              onClick={(e) => s.selectScene(letter, { immediate: e.metaKey })}
              aria-label={`Scene ${letter}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      <span className="cmp-status mono dim">
        engine: {s.engine}
        {s.engine === "running" && " · WASM"}
      </span>
    </div>
  );
}

/** One audio file, by user gesture. `showOpenFilePicker` where it exists, an input elsewhere.
    Exported for the plane's deck-tile binding (P3-D4-1) — the tile's LOAD button is the same
    gesture against a different deck, and two pickers would drift. */
export function pickAudioFile(): Promise<File | null> {
  const picker = (
    window as Window & {
      showOpenFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle[]>;
    }
  ).showOpenFilePicker;
  if (picker) {
    return picker({
      types: [
        {
          description: "Audio",
          accept: { "audio/*": [".wav", ".aif", ".aiff", ".mp3", ".m4a", ".flac", ".ogg"] },
        },
      ],
    })
      .then(([handle]) => (handle ? handle.getFile() : null))
      .catch((err: Error) => (err.name === "AbortError" ? null : Promise.reject(err)));
  }
  return new Promise((res) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg";
    input.onchange = () => res(input.files?.[0] ?? null);
    input.click();
  });
}

/**
 * The pickers. TWO, because the platform forces it: a file input cannot select a directory (picking
 * a `.scoopySession` folder fires NO event at all — the "import does not react" bug), and a
 * `webkitdirectory` input cannot select a file. Drag-and-drop is the door that takes both.
 */
function ImportButton({ onFile }: { onFile: (file: File) => void }) {
  const s = useCompanionDeck();
  return (
    <>
      <label className="cmp-import mono">
        Import…
        <input
          type="file"
          accept=".scoopySession,.zip"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = ""; // so importing the same file twice still fires
          }}
        />
      </label>
      <label className="cmp-import mono">
        Folder…
        <input
          type="file"
          // @ts-expect-error non-standard but universal (Chrome/Safari/Firefox all honour it)
          webkitdirectory=""
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length === 0) return;
            void entriesFromDirectoryInput(files).then(({ dirName, entries }) =>
              s.importEntries(dirName, entries),
            );
          }}
        />
      </label>
    </>
  );
}
