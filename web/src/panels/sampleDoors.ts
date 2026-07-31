/**
 * P3.5-E8a — THE SAMPLE DOORS, IN ONE PLACE.
 *
 * A grid track's audio arrives through exactly two gestures, and `GridPanel`
 * has always drawn both: the row's **LOAD** button (`trackEdit/loadSample` →
 * an OS picker) and a **library path** dropped or double-clicked onto the row
 * (`fileBrowser/load`). Neither does anything by itself — each is an intent
 * that `BrowserLink` forwards to a handler the mounting surface registers.
 *
 * WHY THIS MODULE EXISTS. Three surfaces registered those handlers by hand
 * (the companion, the deck tile) and the fourth — `useComposeBinding`, i.e.
 * the COMPOSE WINDOW, which is where a person actually reaches for a sample —
 * registered neither. `BrowserLink`'s `trackEdit` falls through to a silent
 * `{ok:true}` when no handler is registered, so LOAD in compose accepted the
 * click and did nothing: "in compose it wont let me load any audio samples"
 * (user, real host, 2026-07-30). One registration, imported by every surface,
 * is the only shape where a new surface cannot quietly ship without doors.
 */
import { BrowserLink } from "../browserLink.ts";
import {
  gridDocument,
  configureTrackAsStretch,
  gridDocumentId,
  gridPeakPaths,
  gridRuntimeInfos,
  importAudioFile,
  useCompanion,
} from "../store/companionEngine.ts";

/**
 * One audio file, by user gesture — a plain file input, in every engine.
 *
 * ⚠️ IT USED TO PREFER `showOpenFilePicker` where that exists, and P3.5-E8a's
 * walk measured what that costs: the LOAD button's intent crosses an async
 * command hop before the picker opens, and the File System Access picker
 * demands TRANSIENT ACTIVATION that the hop has already spent — so in Chromium
 * the click produced no picker and no error, exactly the dead button this row
 * is about, while WebKit (which has no such API, and is what WKWebView runs)
 * took the input branch and worked. One branch nobody could reach in the
 * shipping host and that failed silently in the other engine is worse than no
 * branch: the input takes the same `accept` list and hands back the same File.
 */
export function pickAudioFile(): Promise<File | null> {
  return new Promise((res) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg";
    // ⚠️ IN THE DOCUMENT, HIDDEN — not detached (P3.5-E8g).
    //
    // This used to create the input, click it and never append it. The picker
    // OPENED that way in every engine, so the difference is invisible until you
    // ask whether the RESULT comes back. Meanwhile the app's OTHER dynamic file
    // input — `fileBrowserBackend.pickViaInput`, E7's `folder…` — has always
    // appended, and that is the one the user proved end-to-end in WizardMerged
    // on the same walk that reported this door broken. Two implementations of
    // one gesture, and the shipping host had only ever exercised the appended
    // one: exactly the shape of E8a (three hand-written copies of a
    // registration, and the fourth surface shipped without it).
    //
    // Measured 2026-07-30: headless WebKit fires `change` on a DETACHED input
    // too, so this is not proof of the cause and is not claimed as one. It is
    // the cheap half of the answer — make the unproven door structurally
    // identical to the door this host has actually delivered through — and it
    // costs nothing if the cause turns out to be elsewhere.
    input.style.display = "none";

    const done = (file: File | null) => {
      input.remove();
      res(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    // A CANCELLED PICKER USED TO BE AN ETERNALLY PENDING PROMISE, indistinguishable
    // from a pick that vanished — both were silence forever. `cancel` makes "I
    // changed my mind" a resolved outcome, so the only remaining silence is a
    // genuine failure, which the caller now reports.
    input.addEventListener("cancel", () => done(null));

    document.body.append(input);
    input.click();
  });
}

/**
 * P3.5-E8g-a — TELL THE GRID THE SAMPLE LANDED.
 *
 * The user's E8g walk: the header reached `<name> → track N` (companionEngine
 * :674, set AFTER the document write) and the row stayed empty. So the load
 * worked and the REPAINT did not — and this is the hole it fell through.
 *
 * A sample landing on a track is a RUNTIME change, not a pattern one: nothing
 * about the sample is on the pattern wire (`toGridPattern` carries no sample
 * field at all; `name` / `sampleKey` / `sampleDurationMs` are `toGridRuntime`'s,
 * gridProjection.ts:353). Every other door that moves the runtime half
 * republishes the backend RIGHT THERE, from its own handler —
 *
 *   toggleLaunch  → `updateRuntime` (CompanionPanel:66, useComposeBinding:36,
 *                   deckTile:89)
 *   toggleSolo    → `updateRuntime` (CompanionPanel:71, useComposeBinding:40,
 *                   deckTile:93)
 *   setActiveCellParameter → `grid.setActiveCellParameter` (browserLink:362)
 *
 * — and the SAMPLE doors republished nothing. Their repaint was delegated
 * entirely to a React effect in another component (`useComposeBinding:53`,
 * `CompanionPanel:76`) that reloads the whole grid when the session OBJECT's
 * identity changes. That effect is three layers from the store, it is the only
 * path a loaded sample had to the screen, and when it does not fire the door is
 * indistinguishable from the defect E8g was opened for: the document changed
 * and the only evidence a person has that it changed did not.
 *
 * Measured 2026-07-30 (composeLoadDoor.test.ts): the store→backend chain is
 * correct end to end — with the reload effect simulated, `gridRuntime/<i>`
 * receives the sample's name and key. So the fix is not to repair that chain
 * but to stop the repaint DEPENDING on a subscription the door does not own.
 * This is the shape the launch/solo doors have always had, and neither has ever
 * been reported dead.
 *
 * ONE call site for every surface, deliberately: the compose WINDOW and the
 * in-window `Composer` share this module precisely so a repaint fixed in one
 * cannot ship missing from the other (P3.5-E8b), and the companion and the deck
 * tiles inherit it for free.
 */
function republishRow(link: BrowserLink, deck: number, scope: "deck" | "compose"): void {
  const infos = gridRuntimeInfos(deck);
  // No session ⇒ nothing to repaint. Guarded rather than assumed: `updateRuntime([])`
  // would republish every row under `runtimeState`'s `Track i+1` fallback and
  // wipe the names off a grid that is still showing a document.
  if (!infos.length) return;
  const at = scope === "deck" ? deck : undefined;
  // PEAK PATHS FIRST. `getSamplePeaks` resolves a row's file through this map
  // (browserLink:246), and it is written only by the reload effect — so a
  // runtime push naming a sample the map has never heard of draws a NAMED row
  // with no waveform, which is the same report one layer smaller.
  link.setGridPeakPaths(gridPeakPaths(deck), at);
  const backend = scope === "deck" ? link.djGridBackend(deck) : link.gridBackend;
  backend.updateRuntime(infos);
}

/**
 * P3.5-E8g-h — THE SAME REPAINT, WHEN THE DOCUMENT GREW A ROW.
 *
 * `republishRow` cannot show a track that did not exist a moment ago: `updateRuntime`
 * walks the rows the BACKEND already holds (`gridBackend.ts:204`), and `updatePatternRow`
 * refuses an index past the end (`:236`). Neither republishes `gridMeta`, and `trackCount`
 * is what tells the panel there is an eighth row to draw at all. So a topology change is
 * the one case that needs the full `load` — the verb the bindings' reload effect uses.
 *
 * ⚠️ IT PASSES THE DOCUMENT ID, and that is the whole difference between this and the bug
 * E8g-e closed. `load` resets the cursor and the armed cell-parameter lanes only when the
 * document CHANGES; appending a track is the same document, so the id keeps the user's
 * selection where they put it. Calling `load(doc, infos)` with the id omitted would send
 * the cursor home to track 0 on every appended track — a create gesture that silently
 * moved the selection, which is the shape of defect this family keeps producing.
 *
 * `select` then moves the cursor DELIBERATELY, and only when a track was created.
 * That is the original's behaviour, checked rather than guessed: `addTrackInternal` sets
 * `keyboardSelectedTrackIndex = newIndex`, calls `selectTrack(trackId:)` and syncs
 * `HotkeyManager.setSelectedTrack` (`../scoopyloops`, BeatSequencer.swift:15656-15662),
 * and the schema's own `addTrack` result says the index comes back "so the caller can
 * focus the row it just made". It does not contradict E8g-e: that row is about a REPAINT
 * moving a selection nobody asked to move — this is an answer to the gesture itself.
 */
function reloadDocument(
  link: BrowserLink,
  deck: number,
  scope: "deck" | "compose",
  select?: number,
): void {
  const at = scope === "deck" ? deck : undefined;
  // Peak paths first, same order and same reason as `republishRow`.
  link.setGridPeakPaths(gridPeakPaths(deck), at);
  const backend = scope === "deck" ? link.djGridBackend(deck) : link.gridBackend;
  backend.load(gridDocument(deck), gridRuntimeInfos(deck), gridDocumentId(deck));
  // After the load, never before: `selectTrack` refuses an index the backend's rows do
  // not answer to yet, so selecting the new row first would silently do nothing.
  if (select !== undefined) backend.selectTrack(select);
}

/**
 * Register both sample doors for one surface.
 *
 * `deck` is whose DOCUMENT the sample lands in. `scope` is which handler slot
 * to fill, and the two are NOT the same axis: a deck tile addresses the grid
 * WITH a deck (`trackEdit {deck}` → that tile's own document, P3-D4-1), while
 * the compose window, the companion and the in-window overlay address a grid
 * that has no deck axis at all — they mount one composer and mean it — so they
 * register on the compose scope while still writing into their own deck.
 */
export function registerSampleDoors(
  link: BrowserLink,
  deck: number,
  scope: "deck" | "compose",
): void {
  const at = scope === "deck" ? deck : undefined;

  // The CREATE verb, for every caller that has one: ⌘T, the MasterRow `+`, and the
  // untargeted branch of the library door just below. One registration per surface,
  // in the module all four surfaces already share — the E8a shape, for the same
  // reason (three hand-written copies and a fourth surface with none).
  link.setAddTrackHandler(async () => {
    const index = await useCompanion.getState().appendTrack(deck);
    // A refusal has already spoken on the store's error line; there is nothing to
    // repaint, and the link turns the null into the loud rejection the schema asks
    // for ("Refused (16-track cap) comes back as an error, not a silent no-op").
    if (index === null) return null;
    reloadDocument(link, deck, scope, index);
    return index;
  }, at);

  // A library path (double-clicked in FILES, or a row dropped on a track).
  //
  // TWO GESTURES, ONE INTENT, AND THE DIFFERENCE IS WHETHER A ROW WAS NAMED (P3.5-E8g-h).
  // A drop names the row it landed on and a LOAD button names its own row, so both
  // REPLACE. A double-click (and ⏎) in FILES names nothing — it arrives with
  // `trackIndex` absent, which the protocol has always defined as "new track"
  // (`fileBrowser.test.tsx`, browser.md §2) — so it APPENDS. The user's report is the
  // one-line version: "yes it lands on track 1, however it should create a new track."
  //
  // Deliberately NOT "create when nothing is selected": that is one gesture doing two
  // things depending on invisible state, which is the confusion E8g-e came out of.
  link.setSampleLoadHandler(async (trackIndex, path, asStretch) => {
    let target = trackIndex;
    if (target === null) {
      target = await useCompanion.getState().appendTrack(deck);
      // Refused — no session, or the track ceiling. `appendTrack` has already put
      // the reason on the store's error line; loading into a track that does not
      // exist would set `<name> → track NaN` and change nothing, which is the
      // silent-accept shape this row exists to avoid. (`loadSample` skips every
      // section whose length the index is past, so it fails QUIETLY today —
      // measured, and pinned in `sampleDoors.test.ts`.)
      if (target === null) return;
    }
    await useCompanion.getState().loadSample(target, path, deck)
    // ⌥ = STRETCH (P3.5-E8c + E8g-h-a). The donor configures the track AFTER the
    // sample lands, because the algorithm sizes the first cell to the pattern's
    // step count — it needs a loaded row to reshape.
    if (asStretch) configureTrackAsStretch(target, deck);
    // A created track is a TOPOLOGY change — `gridMeta.trackCount` moved, and the
    // runtime push alone cannot draw a row the backend has never heard of. The new
    // row takes the cursor, which is what the original does on this exact path
    // (`loadBrowserSample` with no trackIndex → `addTrack(sampleURL:)` → select).
    if (trackIndex === null) reloadDocument(link, deck, scope, target);
    else republishRow(link, deck, scope);
  }, at);

  // The LOAD button: pick → import into the library → assign to the row. The
  // import makes the file a library citizen, so FILES is told to refresh.
  //
  // ⚠️ EVERY STAGE SAYS WHERE IT IS (P3.5-E8g). This door had FIVE outcomes and
  // four of them were silent: the picker never returning, the user cancelling,
  // a non-audio file, an import throw, and success. "Load opens the
  // documentpicker but the file never loads, track stays empty" is what all
  // four look like from the outside, which is why one user report could not
  // name the seam and neither could any test.
  //
  // The progress line is not decoration — it is the diagnosis. It NAMES THE
  // STAGE IT IS WAITING ON, so a door that hangs says which await never came
  // back: still "choosing…" means the pick never returned; still "loading
  // <name>…" means the import or the decode did. Cheaper than a timeout and
  // it cannot guess wrong, because it only ever reports where control is.
  link.setSamplePickHandler(async (trackIndex) => {
    const row = `track ${trackIndex + 1}`;
    try {
      useCompanion.setState({ notice: `choosing a sample for ${row}…`, error: null });
      const file = await pickAudioFile();
      if (!file) {
        // Cancelled. A choice, not a failure — clear the line, say nothing.
        useCompanion.setState({ notice: null });
        return;
      }
      useCompanion.setState({ notice: `loading ${file.name} into ${row}…` });
      const path = await importAudioFile(file);
      // `loadSample` owns the last word: it sets `<name> → track N` on success
      // and `sample load failed: …` on a decode or document failure.
      await useCompanion.getState().loadSample(trackIndex, path, deck);
      // P3.5-E8g-a — the row, on screen, without waiting for a reload effect
      // this handler does not own. See `republishRow`.
      republishRow(link, deck, scope);
      void link.command("fileBrowser", { op: "refresh" });
    } catch (err) {
      // The store's error line is the one surface every host renders — a door
      // that fails silently is indistinguishable from the defect this fixes.
      useCompanion.setState({
        error: `sample import failed: ${(err as Error).message}`,
        notice: null,
      });
    }
  }, at);
}
