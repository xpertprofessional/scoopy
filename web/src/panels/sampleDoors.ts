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
import { importAudioFile, useCompanion } from "../store/companionEngine.ts";

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
    input.onchange = () => res(input.files?.[0] ?? null);
    input.click();
  });
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

  // A library path (double-clicked in FILES, or a row dropped on a track).
  link.setSampleLoadHandler(async (trackIndex, path) => {
    await useCompanion.getState().loadSample(trackIndex, path, deck);
  }, at);

  // The LOAD button: pick → import into the library → assign to the row. The
  // import makes the file a library citizen, so FILES is told to refresh.
  link.setSamplePickHandler(async (trackIndex) => {
    try {
      const file = await pickAudioFile();
      if (!file) return;
      const path = await importAudioFile(file);
      await useCompanion.getState().loadSample(trackIndex, path, deck);
      void link.command("fileBrowser", { op: "refresh" });
    } catch (err) {
      // The store's error line is the one surface every host renders — a door
      // that fails silently is indistinguishable from the defect this fixes.
      useCompanion.setState({ error: `sample import failed: ${(err as Error).message}` });
    }
  }, at);
}
