/**
 * P8-7 — the companion, as a thing a person can actually use.
 *
 * Everything below this file already worked and nobody could reach it: the engine runs in WASM
 * (P8-1/P8-2), sessions and their samples live in OPFS (P8-0/P8-6), and a session converts to the
 * engine's `World` (`worldFromSession`). But the only thing that had ever driven that chain was a
 * test. This is the controller a UI binds to — the session library, the engine, and a transport.
 *
 * ⚠️ THE ENGINE CANNOT BE STARTED FOR YOU. `AudioContext` is blocked outside a user gesture in every
 * browser, and the failure is the nastiest kind: the context sits `suspended`, every call succeeds,
 * and nothing comes out. So `start()` is deliberately a thing the user CLICKS, and the UI says so,
 * rather than being fired hopefully on mount where it would silently do nothing.
 *
 * The audio objects are module-scoped, not store state: an `AudioContext` and a decode cache are not
 * serialisable, must not be cloned by a state update, and there is exactly one of each.
 */
import { create } from "zustand";

import { ScoopyAudio, type EnginePosition } from "../audio/scoopyAudio.ts";
import { NativeWorldSink, type WorldSink } from "../audio/nativeAudio.ts";
import { juceBackend } from "../../protocol/juceLink.ts";
import { nativeLink } from "../engineLink.ts";
import { lcmForScene, switchBoundary } from "../audio/patternClock.ts";
import {
  SECTION_KEYS,
  projectScene,
  sectionKeyFor,
  splitSceneEdit,
  type SceneLetter,
} from "../audio/sceneProjection.ts";
import { worldFromSession } from "../audio/worldFromSession.ts";
import { kitSamples } from "../persist/kit.ts";
import { resetUndo } from "../state/undoStore.ts";
import { decodePatternFileAnyVersion } from "../persist/migrations.ts";
import type { DocRow } from "./gridProjection.ts";
import type { TrackRuntimeInfo } from "./gridBackend.ts";
import { SampleStore } from "./sampleStore.ts";
import {
  Autosaver,
  exportSession,
  importSessionEntries,
  importSessionFile,
  listSessions,
  openSession,
  saveSession,
  type SessionSummary,
  type WorkingSession,
} from "./sessionStore.ts";

// The worklet, resolved through the bundler rather than hardcoded. It statically imports the
// generated `scoopy-engine.js` (the WASM, embedded via -sSINGLE_FILE=1), so both must be served as
// real modules — which the dev server does.
const WORKLET_URL = new URL("../audio/scoopy-worklet.js", import.meta.url).href;

/**
 * THE WORLD SINK — where this store's published worlds actually go.
 *
 * In the browser that is `ScoopyAudio`: an Emscripten build of the same C++
 * core, in an AudioWorklet, because a browser has no native engine to reach.
 *
 * ⚠️ IN THE MERGED DESKTOP APP THAT WAS WRONG, and silently so. `WizardMerged`
 * compiles the real core in and renders it through a real device — so pointing
 * this store at the worklet ran a WASM COPY of the engine inside an app that
 * already had the original, on a second clock, into a second output. The native
 * applier (`SlWorldApply`) had been built and tested since P1 with zero callers
 * because nothing had ever pointed a sink at it. A grid deck sharing a mixer
 * with a tape strip was impossible for that reason alone, and it is why "scoopy
 * in a strip" was never a UI task.
 *
 * Chosen ONCE, here, by whether a JUCE backend exists. Everything below is
 * written against the sink, not against either implementation, so the store
 * never learns which host it is on.
 */
const audio: WorldSink = makeSink();

function makeSink(): WorldSink {
  // ⚠️ THIS USED TO INSTALL AN `onPublished` HOOK, and its removal is P3-2.
  // A publish commits a snapshot, and `sl_snapshot_begin` reset every deck's
  // tempoSyncRatio to 1.0 — so editing anything in the grid silently un-synced
  // every synced deck, and the hook re-asserted the map's sync after every
  // single publish to paper over it.
  //
  // The ratio is now DECK SCOPE in the engine (SL-ABI-V3 §3): held in a
  // persistent per-deck param block and re-stamped onto each rebuilt world, so
  // a session publish does not touch the tempo axis at all. Nothing to
  // re-assert, and the grid no longer reaches into the plane's store on every
  // keystroke to do it.
  return hasNativeEngine() ? new NativeWorldSink(nativeLink()) : new ScoopyAudio();
}

/** Is there a JUCE backend to publish to? Guarded on `window` because this
    module is imported by node-environment tests that have no DOM, and a bare
    `juceBackend()` here threw on IMPORT — before a line of any such test ran. */
function hasNativeEngine(): boolean {
  return typeof window !== "undefined" && juceBackend() !== null;
}

// iOS suspends the AudioContext on backgrounding and never brings it back on
// its own; WebKit's "interrupted" state sometimes even needs a fresh user
// gesture to leave. Both doors are installed once, after the first successful
// start: return-to-foreground tries silently, and failing that the next tap
// anywhere resumes it.
let resumeHooksInstalled = false;
function installResumeHooks() {
  if (resumeHooksInstalled) return;
  resumeHooksInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void audio.resume().catch(() => {});
  });
  window.addEventListener("pointerdown", () => {
    void audio.resume().catch(() => {});
  });
}
const samples = new SampleStore();
const autosaver = new Autosaver();

/**
 * sampleId → decoded rate, filled by registerKit. The world's sample trim is in frames.
 *
 * ⚠️ MERGED ACROSS DECKS, never replaced. This used to be `sampleRates = rates`
 * on every kit registration, which was correct while exactly one session could
 * be open. With N decks it silently breaks the others: registering deck 1's kit
 * would drop every rate deck 0's samples were trimmed against, and
 * `worldFromSession` reports those as `unresolvedTrims` and plays each sample
 * FROM THE TOP. A trimmed sample playing from the top is a wrong note, not a
 * missing feature — and nothing about it looks like the deck you just opened.
 *
 * Sample ids are content-addressed, so a merge cannot collide meaningfully:
 * two decks naming the same sample name the same audio at the same rate.
 */
let sampleRates = new Map<string, number>();

function mergeRates(rates: Map<string, number>): void {
  for (const [id, rate] of rates) sampleRates.set(id, rate);
}

/**
 * OPFS path → decoded duration in ms, filled when a session opens (and when a sample loads).
 * The grid's cell-waveform math (`gridWave`) BAILS on `sampleDurationMs <= 0` — a runtime info
 * that hardcodes 0 doesn't degrade the waveform, it deletes it. Decoding here is not extra work:
 * the decode cache is shared with playback and peaks, so the session's samples are warmed exactly
 * once.
 */
const sampleDurations = new Map<string, number>();

async function computeDurations(kit: WorkingSession["kit"]): Promise<void> {
  for (const s of kitSamples(kit)) {
    if (sampleDurations.has(s.filePath)) continue;
    try {
      const buffer = await samples.decode(s.filePath);
      sampleDurations.set(s.filePath, buffer.duration * 1000);
    } catch {
      // A missing/undecodable sample stays at 0 — the open() path surfaces it as a warning.
    }
  }
}

export type EngineStatus = "idle" | "starting" | "running" | "failed";

/**
 * HOW MANY DECKS CAN HOLD A SESSION AT ONCE — `sl_deck_count()` in the merged
 * engine (kMaxDecks = 3, a property of the pinned core, not a preference).
 *
 * The browser companion uses deck 0 and only deck 0: one session IS the app
 * there, and there is no plane to put a second one on.
 */
export const MAX_DECKS = 3;

/**
 * ONE DECK'S WORLD — everything that used to be a single set of top-level
 * fields, now once per deck.
 *
 * ⚠️ THIS IS THE CHANGE THAT UNBLOCKED "A GRID IN A STRIP", and it was never a
 * UI task. The store held ONE `session` and `worldFromSession` had no deck axis,
 * because it was written for the browser companion where one session is the
 * whole app. The mission sentence is "decks load into strips, each with its own
 * BPM", which needs N — and that single cause blocked the grid creation gesture,
 * landing a carve, and multi-deck grid strips all at once.
 *
 * The ENGINE was never the blocker: `SlWorldApply` already reads `world.deck`
 * and `plane_audio_test` §10 runs two decks at independent tempos. Everything
 * missing was above the wire.
 */
export interface DeckState {
  session: WorkingSession | null;
  playing: boolean;
  /** The active pattern scene. RUNTIME state — selecting a scene never autosaves. */
  scene: SceneLetter;
  /** A scene switch armed for the next LCM cycle boundary (null = none pending). */
  scheduledScene: SceneLetter | null;
  /** The master step the armed switch fires at — a multiple of lcm(active, target). */
  switchBoundaryStep: number | null;
  /**
   * Per-track launch (▶/■), by section index. RUNTIME, like the desktop's launch gates: it folds
   * into the published world's mutes but never writes the document's `isStopped` — a reload
   * re-seeds from the file, which is the intended semantic.
   */
  stoppedTracks: number[];
  /** Solo, by section index. RUNTIME on the desktop too (never persisted; resets on load). */
  soloedTracks: number[];
  /** Tracks the session names but the kit does not carry — surfaced, never swallowed. */
  missingSamples: string[];
  /** Samples that failed to decode. Same rule. */
  decodeFailures: { name: string; error: string }[];
}

export function idleDeck(): DeckState {
  return {
    session: null,
    playing: false,
    scene: "A",
    scheduledScene: null,
    switchBoundaryStep: null,
    stoppedTracks: [],
    soloedTracks: [],
    missingSamples: [],
    decodeFailures: [],
  };
}

interface CompanionState {
  sessions: SessionSummary[];
  engine: EngineStatus;
  /** One entry per deck, always MAX_DECKS long — a deck with no session is
      `idleDeck()`, never a hole, so `decks[d]` never needs a null check. */
  decks: DeckState[];
  notice: string | null;
  error: string | null;

  refresh(): Promise<void>;
  /** Open `name` INTO `deck`. Deck 0 unless told otherwise, which is what keeps
      every browser-companion call site unchanged — there, deck 0 is the app. */
  open(name: string, deck?: number): Promise<void>;
  /** Let go of a deck's session (a strip dropping its grid element). */
  closeDeck(deck: number): void;
  importFile(file: File): Promise<void>;
  /** A `.scoopySession` DIRECTORY, walked by the shell into path→bytes entries. */
  importEntries(dirName: string, entries: Map<string, Uint8Array>): Promise<void>;
  /** A fresh session from the canonical desktop template — compose from NOTHING, away from the studio. */
  newSession(): Promise<void>;
  /** Assign a library sample (OPFS path) to a track — the browser's half of `fileBrowser load`. */
  loadSample(trackIndex: number, path: string, deck?: number): Promise<void>;
  /** CARVE (P3-U7, STRIP-MODEL's one-way bridge): land a tape's loop region as
      a grid track. The track references the take IN PLACE via the read-only
      `/takes` mount — the carve invariant is ONE take shared by the tape and
      the track, never a copy. Lands on the first EMPTY track; returns false
      (with `error` set) when there is none, or no session is open. */
  carveIntoSession(
    deck: number,
    carved: { takeRef: string; sampleStartMs: number; sampleEndMs: number; name: string },
  ): Promise<boolean>;
  exportCurrent(deck?: number): Promise<void>;
  startEngine(): Promise<void>;
  play(deck?: number): void;
  stop(deck?: number): void;
  /** P3-M-1b: latch/release a beat repeat on this deck (runtime, republishes).
      null releases. */
  setBeatRepeat(
    deck: number,
    br: { startStep: number; length: number; subdivision?: number } | null,
  ): void;
  /** P3-M-1b: whole-session tape reverse (runtime, republishes). */
  setReverse(deck: number, on: boolean): void;
  setBpm(bpm: number, deck?: number): void;
  /**
   * Switch the active pattern scene. While playing, a plain select SCHEDULES the switch at the
   * next cycle boundary (the desktop's default switch mode); `immediate` runs it now
   * (⌘-click / the desktop's R). Selecting the ACTIVE scene cancels a pending switch. Stopped →
   * always immediate.
   */
  selectScene(scene: SceneLetter, opts?: { immediate?: boolean; deck?: number }): void;
  /** Flip a track's launch gate (the grid's ▶/■) — immediate, unquantized. */
  toggleLaunch(trackIndex: number, deck?: number): void;
  /** Flip a track's solo — desktop semantics: peers ride the mixMuted gain ramp, triggers keep firing. */
  toggleSoloTrack(trackIndex: number, deck?: number): void;
  dismissNotice(): void;
}

/** Write one deck's slice, leaving every other deck alone. The one place decks
    are updated, so a partial write cannot lose a peer's session. */
function patchDeck(
  state: CompanionState,
  deck: number,
  patch: Partial<DeckState>,
): Pick<CompanionState, "decks"> {
  return {
    decks: state.decks.map((d, i) => (i === deck ? { ...d, ...patch } : d)),
  };
}

/** A deck's state, or an idle one for an out-of-range index. Never throws and
    never returns undefined: an out-of-range deck is a caller bug that should
    show up as "nothing is loaded there", not as a crash mid-performance. */
export function deckOf(state: CompanionState, deck: number): DeckState {
  return state.decks[deck] ?? idleDeck();
}

/**
 * A live performance tempo (DJ-mixer sync/nudge, via the bridge; the PLANE's per-strip bpm since
 * P3-2). NOT store state and NOT a document edit: it wins over the document bpm on every publish
 * but never reaches the Autosaver — riding a sync fader must not rewrite the session 10×/s, and
 * closing the mixer must leave the document exactly as it was.
 *
 * ⚠️ PER DECK, and it had to become so. It was a single global, which was fine while one mixer
 * drove one tempo — but the plane gives every grid strip its own bpm box, and "decks load into
 * strips, EACH WITH ITS OWN BPM" is the mission sentence. A global override meant strip B's tempo
 * silently became strip A's.
 *
 * And the plane's box reached nothing at all before this: it wrote `element.bpm` in the MAP while
 * the engine kept publishing the session's `pattern.bpm`. So the number moved on screen, the deck
 * did not, and — worse — the sync ratio was computed against a tempo the deck was not running at.
 * Writing the SESSION instead would have been the wrong fix: `GridElement.tsx`'s header is explicit
 * that the strip is scoped to the PERFORMANCE layer precisely so a knob touched from the map cannot
 * bleed into every other map using that session.
 */
const tempoOverrideBpm: (number | null)[] = Array.from({ length: MAX_DECKS }, () => null);

/** The bpm the ENGINE hears: the performance override when one is active, else the document. */
export function resolveWorldBpm(documentBpm: number, override: number | null): number {
  return override ?? documentBpm;
}

/**
 * The deck-mixer extension's per-window fader, when engaged — wins over the session's masterVolume
 * (same override pattern as tempoOverrideBpm). null = the session's own level applies.
 */
let mainGainOverride: number | null = null;

/** P3-M-1b: runtime transport verbs, PER DECK and never the document — a beat
    repeat is a hand gesture; it is restated by every publish and dies with the
    deck (the slot-reuse rule sync already follows). */
const beatRepeatState: ({ startStep: number; length: number; subdivision?: number } | null)[] =
  [null, null, null];
const reverseState: boolean[] = [false, false, false];

/** Push ONE DECK's document at the engine. No-op until the engine is running. */
function publish(state: CompanionState, deck: number, playing: boolean): string[] {
  const d = deckOf(state, deck);
  if (!audio.running || !d.session) return [];
  // The engine hears the ACTIVE SCENE's projection, not the raw base — scene "A" is the identity.
  // bpm precedence: performance override > scene-pinned bpm (already resolved into the
  // projection) > document bpm.
  const pattern = projectScene(d.session.pattern, d.scene);
  const { world, missingSamples } = worldFromSession(
    { ...pattern, bpm: resolveWorldBpm(pattern.bpm as number, tempoOverrideBpm[deck] ?? null) },
    d.session.kit,
    {
      isPlaying: playing,
      startStep: 0,
      sampleRates,
      stoppedTracks: new Set(d.stoppedTracks),
      soloedTracks: new Set(d.soloedTracks),
      // The companion IS the no-return-FX host (BrowserLink answers returnFx: false): dry render,
      // matching the hidden sends row. The document's send values stay untouched.
      disableReturnFx: true,
      // The transport verbs ride every publish (P3-M-1b) — restating them is
      // what makes them survive scene switches and edits.
      beatRepeat: beatRepeatState[deck] ?? null,
      reverseTransport: reverseState[deck] === true,
    },
  );
  // THE DECK AXIS, and it stops here. `worldFromSession` still does all 505
  // lines of document→World work with no idea decks exist — which deck a world
  // lands on is a PUBLISH concern, not a translation one, and threading it
  // through the translator would have put an engine-slot index inside the pure
  // function that has no business knowing about slots.
  audio.publish(world, deck);
  // The session's master level (parity: the desktop's master stage applies masterVolume; the
  // browser's main gain is a plain post-render multiply — no master clipper here, so a >1.0
  // desktop level saturates there and merely pushes toward digital ceiling here; known gap).
  //
  // ⚠️ DECK 0 ONLY. `setMainGain` is the app's ONE output stage, so letting deck
  // 1's session master-volume write it would mean loading a session into a strip
  // silently changed the whole app's output level — and the last deck published
  // would win. On the plane the master is the plane's (`sl_master_set_level`);
  // in the browser there is only deck 0 anyway, so nothing is lost here.
  const masterVolume = d.session.pattern.masterVolume;
  if (deck === 0 && typeof masterVolume === "number") {
    audio.setMainGain(mainGainOverride ?? masterVolume);
  }
  return missingSamples;
}

/** Re-publish every deck that holds a session. For the moments that change what
    ALL decks hear — the engine coming up, a performance tempo engaging. */
function publishAll(state: CompanionState): void {
  for (let d = 0; d < state.decks.length; d++) {
    if (state.decks[d]?.session) publish(state, d, state.decks[d]!.playing);
  }
}

/** Seed the runtime launch gates from the document — the set starts truthful to the file. */
function seedStopped(session: WorkingSession): number[] {
  const rows = (session.pattern.sectionA as { isStopped?: boolean }[] | undefined) ?? [];
  return rows.flatMap((t, i) => (t.isStopped ? [i] : []));
}

export const useCompanion = create<CompanionState>((set, get) => ({
  sessions: [],
  engine: "idle",
  decks: Array.from({ length: MAX_DECKS }, idleDeck),
  notice: null,
  error: null,

  async refresh() {
    try {
      // ⚠️ Do NOT clear `error` here. The mount kicks off a refresh whose first-boot OPFS init can
      // outlive a failed import — and its `error: null` was landing AFTER the import's message,
      // erasing it. A user's very first import failing SILENTLY is exactly how that read on screen.
      set({ sessions: await listSessions() });
    } catch (err) {
      set({ error: `cannot read the session library: ${(err as Error).message}` });
    }
  },

  async open(name, deck = 0) {
    if (deck < 0 || deck >= MAX_DECKS) {
      // REFUSED rather than aliased onto deck 0 — the same rule the engine
      // applies to an out-of-range world (SlWorldApply): silently landing a
      // session on the wrong deck is far worse than declining to load it.
      set({ error: `deck ${deck} does not exist (0–${MAX_DECKS - 1})` });
      return;
    }
    try {
      const session = await openSession(name);
      // Durations BEFORE the session lands in state: the panel reloads the grid on `session`
      // change, reading the runtime infos at that moment — late durations would draw no waveforms.
      await computeDurations(session.kit);
      // A success clears a stale failure — refresh() no longer does it (see the race note there).
      // Scene + launch gates are runtime: a fresh open starts on A, truthful to the file.
      set((s) => ({
        ...patchDeck(s, deck, {
          ...idleDeck(),
          session,
          stoppedTracks: seedStopped(session),
        }),
        error: null,
      }));

      // If the engine is already up, the new kit has to reach it before the world names any of it —
      // a world referring to a sampleId the engine has never been given plays silence.
      if (audio.running) {
        const { failures, rates } = await samples.registerKit(session.kit, audio);
        // MERGED, not replaced — replacing would strip every other deck's
        // sample rates and un-trim their samples. See `sampleRates`.
        mergeRates(rates);
        set((s) => patchDeck(s, deck, { decodeFailures: failures }));
        set((s) => patchDeck(s, deck, { missingSamples: publish(get(), deck, false) }));
      }
      set({ notice: `opened ${name}` });
    } catch (err) {
      set({ error: `cannot open ${name}: ${(err as Error).message}` });
    }
  },

  closeDeck(deck) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    // Publish a STOPPED, empty world before dropping the session, or the engine
    // keeps rendering the deck it was last given: the store forgetting a session
    // is not the same as the engine forgetting it, and a strip whose grid
    // element was removed would keep playing with nothing on screen to stop it.
    set((s) => patchDeck(s, deck, { playing: false }));
    publish(get(), deck, false);
    set((s) => patchDeck(s, deck, idleDeck()));
    // The performance tempo goes with the deck. It is module state, not deck
    // state, so `idleDeck()` does not touch it — and a slot is REUSED, so
    // without this the next session loaded here would start at the tempo the
    // last one was overridden to. Exactly the shape of the sync ratio that
    // outlived its deck (see PlanePanel's dropElement / `slDeck clear`).
    tempoOverrideBpm[deck] = null;
    // The transport verbs go with the deck too (P3-M-1b): a reused slot must
    // not inherit the previous occupant's repeat or reverse.
    beatRepeatState[deck] = null;
    reverseState[deck] = false;
  },

  async importFile(file) {
    try {
      const session = await importSessionFile(file);
      await get().refresh();
      await get().open(session.name);
      set({ notice: `imported ${session.name}`, error: null });
    } catch (err) {
      set({ error: `import failed: ${(err as Error).message}` });
    }
  },

  async importEntries(dirName, entries) {
    try {
      const session = await importSessionEntries(dirName, entries);
      await get().refresh();
      await get().open(session.name);
      set({ notice: `imported ${session.name}`, error: null });
    } catch (err) {
      set({ error: `import failed: ${(err as Error).message}` });
    }
  },

  async newSession() {
    try {
      // The canonical fresh document — the byte-pinned fixture a fresh DESKTOP save writes, so a
      // browser-born session is indistinguishable from a studio-born one. Dynamically imported:
      // it is ~540 KB nobody pays for until they click New.
      const { default: freshText } = await import(
        "../../fixtures/patternfile/fresh-default.json?raw"
      );
      const pattern = decodePatternFileAnyVersion(freshText);
      const taken = new Set((await listSessions()).map((s) => s.name));
      let name = "Untitled";
      for (let n = 2; taken.has(name); n++) name = `Untitled ${n}`;
      const kit = {
        id: crypto.randomUUID().toUpperCase(),
        name: "Session Kit",
        samples: [],
      };
      const session: WorkingSession = { name, pattern, kit, extras: new Map() };
      await saveSession(session);
      await get().refresh();
      await get().open(name);
      set({ notice: `created ${name} — load samples onto tracks from FILES`, error: null });
    } catch (err) {
      set({ error: `new session failed: ${(err as Error).message}` });
    }
  },

  async carveIntoSession(deck, carved) {
    const session = deckOf(get(), deck).session;
    if (!session) {
      set({ error: "carve needs an open session on a grid strip — load one first" });
      return false;
    }
    // The take, referenced IN PLACE through the read-only /takes mount — the
    // carve invariant (carve.ts): a scrubbable tape and a grid track carved
    // from it share ONE take. No copy, so a session never duplicates audio.
    const path = `/takes/${carved.takeRef.split("/").pop() ?? carved.takeRef}`;
    try {
      const buffer = await samples.decode(path);
      sampleDurations.set(path, buffer.duration * 1000);
      // The first EMPTY track — a carve must never overwrite a track someone
      // sequenced. Section A is the emptiness authority: `loadSample` writes
      // every section's row together, so the sections agree.
      const rowsA = (session.pattern as Record<string, unknown>).sectionA;
      const trackIndex = Array.isArray(rowsA)
        ? rowsA.findIndex((t) => !(t as { sampleId?: string | null }).sampleId)
        : -1;
      if (trackIndex < 0) {
        set({ error: "no empty track in this session — free one, then carve" });
        return false;
      }
      const kitList = kitSamples(session.kit);
      let entry = kitList.find((s) => s.filePath === path);
      let kit = session.kit;
      if (!entry) {
        entry = {
          id: crypto.randomUUID().toUpperCase(),
          name: carved.name,
          filePath: path,
          defaultVolume: 0.8,
          defaultPan: 0,
        };
        kit = { ...session.kit, samples: [...kitList, entry] };
      }
      // The region rides as the trim the document already understands — every
      // section's row, the loadSample rule (a hand-typed subset once skipped
      // sections silently).
      const pattern = { ...(session.pattern as Record<string, unknown>) };
      for (const key of SECTION_KEYS) {
        const tracks = pattern[key];
        if (!Array.isArray(tracks) || trackIndex >= tracks.length) continue;
        const copy = [...tracks];
        copy[trackIndex] = {
          ...(copy[trackIndex] as Record<string, unknown>),
          sampleId: entry.id,
          sampleStartMs: carved.sampleStartMs,
          sampleEndMs: carved.sampleEndMs,
        };
        pattern[key] = copy;
      }
      const next: WorkingSession = {
        ...session,
        kit,
        pattern: pattern as WorkingSession["pattern"],
      };
      set((s) => patchDeck(s, deck, { session: next }));
      if (audio.running) {
        const { failures, rates } = await samples.registerKit(kit, audio);
        mergeRates(rates);
        set((s) => patchDeck(s, deck, { decodeFailures: failures }));
        set((s) =>
          patchDeck(s, deck, {
            missingSamples: publish(get(), deck, deckOf(get(), deck).playing),
          }),
        );
      }
      autosaver.schedule(next);
      set({ notice: `${carved.name} → track ${trackIndex + 1}`, error: null });
      return true;
    } catch (err) {
      set({ error: `carve failed: ${(err as Error).message}` });
      return false;
    }
  },

  async loadSample(trackIndex, path, deck = 0) {
    try {
      const session = deckOf(get(), deck).session;
      if (!session) {
        set({ error: "open (or create) a session first — a sample loads into a track" });
        return;
      }
      // Decode FIRST — a sample that cannot decode must fail loudly here, not silently later.
      const buffer = await samples.decode(path);
      sampleDurations.set(path, buffer.duration * 1000);

      const kitList = kitSamples(session.kit);
      let entry = kitList.find((s) => s.filePath === path);
      let kit = session.kit;
      if (!entry) {
        entry = {
          id: crypto.randomUUID().toUpperCase(), // Swift writes uppercase UUIDs
          name: baseNameNoExt(path),
          filePath: path,
          defaultVolume: 0.8,
          defaultPan: 0,
        };
        kit = { ...session.kit, samples: [...kitList, entry] };
      }

      // The sample belongs to the TRACK, so every section's row at this index points at it —
      // writing only the visible section would leave the document self-inconsistent on the desktop.
      // ALL EIGHT keys (a hand-typed list here once stopped at F, silently skipping G and H).
      const pattern = { ...(session.pattern as Record<string, unknown>) };
      for (const key of SECTION_KEYS) {
        const tracks = pattern[key];
        if (!Array.isArray(tracks) || trackIndex >= tracks.length) continue;
        const copy = [...tracks];
        copy[trackIndex] = { ...(copy[trackIndex] as Record<string, unknown>), sampleId: entry.id };
        pattern[key] = copy;
      }

      const next: WorkingSession = {
        ...session,
        kit,
        pattern: pattern as WorkingSession["pattern"],
      };
      set((s) => patchDeck(s, deck, { session: next }));
      if (audio.running) {
        const { failures, rates } = await samples.registerKit(kit, audio);
        mergeRates(rates);
        set((s) => patchDeck(s, deck, { decodeFailures: failures }));
        set((s) =>
          patchDeck(s, deck, {
            missingSamples: publish(get(), deck, deckOf(get(), deck).playing),
          }),
        );
      }
      autosaver.schedule(next);
      set({ notice: `${entry.name} → track ${trackIndex + 1}`, error: null });
    } catch (err) {
      set({ error: `sample load failed: ${(err as Error).message}` });
    }
  },

  async exportCurrent(deck = 0) {
    const session = deckOf(get(), deck).session;
    if (!session) return;
    try {
      const { missing } = await exportSession(session);
      set({
        notice: missing.length
          ? `exported — ⚠️ ${missing.length} sample(s) missing from the library`
          : `exported ${session.name}`,
      });
    } catch (err) {
      set({ error: `export failed: ${(err as Error).message}` });
    }
  },

  /** MUST be reached from a click. See the header. */
  async startEngine() {
    // "failed" must pass — the transport's "retry engine" button calls this very method.
    if (get().engine === "starting" || get().engine === "running") return;
    set({ engine: "starting", error: null });
    try {
      await audio.start(WORKLET_URL);
      installResumeHooks();

      // EVERY deck's kit, not just deck 0's. The engine comes up once and every
      // loaded session has to reach it — registering only one would leave the
      // others publishing worlds that name samples the engine never received,
      // which renders as silence and looks like a broken deck.
      for (let d = 0; d < MAX_DECKS; d++) {
        const session = deckOf(get(), d).session;
        if (!session) continue;
        const { failures, rates } = await samples.registerKit(session.kit, audio);
        mergeRates(rates);
        set((s) => patchDeck(s, d, { decodeFailures: failures }));
      }
      set({ engine: "running" });
      publishAll(get());
    } catch (err) {
      set({ engine: "failed", error: `engine failed to start: ${(err as Error).message}` });
    }
  },

  setBeatRepeat(deck, br) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    beatRepeatState[deck] = br;
    if (audio.running && deckOf(get(), deck).session)
      publish(get(), deck, deckOf(get(), deck).playing);
  },

  setReverse(deck, on) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    reverseState[deck] = on;
    if (audio.running && deckOf(get(), deck).session)
      publish(get(), deck, deckOf(get(), deck).playing);
  },

  play(deck = 0) {
    if (!audio.running || !deckOf(get(), deck).session) return;
    // Play restarts at step 0 — a pending switch armed against the old clock is meaningless.
    set((s) => patchDeck(s, deck, { playing: true, scheduledScene: null, switchBoundaryStep: null }));
    set((s) => patchDeck(s, deck, { missingSamples: publish(get(), deck, true) }));
  },

  stop(deck = 0) {
    if (!audio.running) return;
    set((s) => patchDeck(s, deck, { playing: false, scheduledScene: null, switchBoundaryStep: null }));
    publish(get(), deck, false);
  },

  setBpm(bpm, deck = 0) {
    const session = deckOf(get(), deck).session;
    if (!session) return;
    const next: WorkingSession = { ...session, pattern: { ...session.pattern, bpm } };
    set((s) => patchDeck(s, deck, { session: next }));
    publish(get(), deck, deckOf(get(), deck).playing);
    // The tempo is a document edit like any other — it must survive the reload, which is the whole
    // point of the OPFS library.
    //
    // ⚠️ PER-DECK, which is the mission requirement made literal: "decks load
    // into strips, each with its own BPM". Nothing here reaches another deck,
    // and nothing here is the plane's MASTER tempo — a synced strip's ratio is
    // computed against that separately (`sl_deck_set_tempo_sync`).
    autosaver.schedule(next);
  },

  selectScene(scene, opts) {
    const deck = opts?.deck ?? 0;
    const st = get();
    const d = deckOf(st, deck);
    if (!d.session) return;
    if (d.scene === scene) {
      // The desktop's cancel gesture: clicking the active pad clears the pending switch
      // (BeatSequencer.swift:11754-11764).
      if (d.scheduledScene)
        set((s) => patchDeck(s, deck, { scheduledScene: null, switchBoundaryStep: null }));
      return;
    }
    // Stopped (or engine down): scheduling has no clock to wait on — switch now, like the
    // desktop's scheduled mode when the transport is stopped.
    if (opts?.immediate || !d.playing || !audio.running) {
      set((s) => patchDeck(s, deck, { scene, scheduledScene: null, switchBoundaryStep: null }));
      // Undo entries replay whole grid states through the ACTIVE scene's write path — an entry
      // recorded in scene B must not replay into scene C. Desktop-consistent: Swift scene
      // switches are not undoable either.
      resetUndo();
      // The whole-world republish is phase-continuous mid-play (see publish()) — the desktop's
      // seamless-immediate switch, not a restart.
      set((s) =>
        patchDeck(s, deck, {
          missingSamples: publish(get(), deck, deckOf(get(), deck).playing),
        }),
      );
      // The grid reloads via the panel's effect (it keys on `scene`). No autosave — runtime.
      return;
    }
    // SCHEDULE at the next cycle boundary — the non-owner model (see patternClock.switchBoundary):
    // a multiple of lcm(active, target) is where the target enters on its own step 0 without the
    // pattern anchor the ABI cannot move. Re-clicking another pad simply re-arms (queue replace).
    const step = audio.position()?.step ?? 0;
    const boundary = switchBoundary(
      step,
      lcmForScene(d.session.pattern, d.scene),
      lcmForScene(d.session.pattern, scene),
    );
    set((s) => patchDeck(s, deck, { scheduledScene: scene, switchBoundaryStep: boundary }));
  },

  toggleLaunch(trackIndex, deck = 0) {
    const d = deckOf(get(), deck);
    if (!d.session) return;
    const stopped = new Set(d.stoppedTracks);
    if (stopped.has(trackIndex)) stopped.delete(trackIndex);
    else stopped.add(trackIndex);
    set((s) => patchDeck(s, deck, { stoppedTracks: [...stopped] }));
    publish(get(), deck, d.playing);
    // No autosave — the document's isStopped fields stay untouched; a reload re-seeds from them.
  },

  toggleSoloTrack(trackIndex, deck = 0) {
    const d = deckOf(get(), deck);
    if (!d.session) return;
    const soloed = new Set(d.soloedTracks);
    if (soloed.has(trackIndex)) soloed.delete(trackIndex);
    else soloed.add(trackIndex);
    set((s) => patchDeck(s, deck, { soloedTracks: [...soloed] }));
    // Audio-critical, like the desktop's pushState(critical:true) — republish immediately. The
    // mask lands on mixMuted (worldFromSession), so peers dim in ~4 ms and keep choking at 0 gain.
    publish(get(), deck, d.playing);
    // No autosave — solo is never persisted, on either host.
  },

  dismissNotice() {
    set({ notice: null });
  },
}));

/** A stable identity for an out-of-range deck. Built ONCE: a selector that
    returned a fresh object each call would hand `useSyncExternalStore` a new
    snapshot every time and re-render forever. */
const IDLE_DECK: DeckState = idleDeck();

/**
 * ONE DECK's world flattened over the global fields — the shape this store used
 * to have, for a caller that only cares about one deck.
 *
 * A PROJECTION, computed at read time and never stored. Keeping deck 0 mirrored
 * onto top-level state would have been the smaller diff, and it would have meant
 * two sources of truth for `session` — discoverable only when they disagreed,
 * mid-performance. Same principle as `sl_channel`'s "one surface, two backings":
 * a convenient surface is fine as long as it is not a second copy.
 *
 * Deck 0 by default, because in the browser companion one session IS the app.
 */
export function useCompanionDeck(deck = 0): CompanionState & DeckState {
  // Two subscriptions, spread in the HOOK BODY rather than inside a selector.
  // A selector returning a freshly-built object breaks snapshot caching; both
  // of these return identities the store already holds.
  const global = useCompanion();
  const d = useCompanion((c) => c.decks[deck] ?? IDLE_DECK);
  return { ...global, ...d };
}

/** The non-React read of the same thing. */
export function companionDeck(deck = 0): DeckState {
  return deckOf(useCompanion.getState(), deck);
}

/** The worklet's own error channel — a dead processor outputs zeros and says nothing else. */
export function engineError(): string | null {
  return audio.error;
}

/** The engine's transport position (worklet mirror), or null before the first broadcast. */
export function enginePosition(): EnginePosition | null {
  return audio.position();
}

/**
 * THE SWITCH COMMIT. Position broadcasts arrive finer than one step (the worklet's 1024-frame
 * cadence vs the 1102-frame step floor), so entering the FINAL step before the armed boundary is
 * always observed: publish the target world then, mid-final-step — the install is phase-continuous
 * (no step boundary crossed while it lands), and the boundary onset itself plays the NEW pattern's
 * step 0. Hooked on the message channel, not rAF, so a hidden tab keeps switching on time.
 */
audio.onPosition((pos) => {
  if (!pos.playing) return;
  // EVERY deck with a switch armed, not just deck 0. Two grid strips can each
  // have a scene queued, and they will not share a boundary — their patterns
  // have different LCMs, which is the whole reason the boundary is computed per
  // session rather than taken from a global bar count.
  const st = useCompanion.getState();
  for (let deck = 0; deck < st.decks.length; deck++) {
    const d = st.decks[deck];
    if (!d?.scheduledScene || d.switchBoundaryStep === null) continue;
    if (pos.step < d.switchBoundaryStep - 1) continue;
    const target = d.scheduledScene;
    useCompanion.setState((s) =>
      patchDeck(s, deck, { scene: target, scheduledScene: null, switchBoundaryStep: null }),
    );
    resetUndo(); // same rule as an immediate switch — entries must not replay across scenes
    useCompanion.setState((s) =>
      patchDeck(s, deck, { missingSamples: publish(useCompanion.getState(), deck, d.playing) }),
    );
  }
  // The grid follows via the panel's scene-keyed effect, the pads via scheduledScene clearing.
});

/**
 * The engine's output level, read straight off the audio graph.
 *
 * NOT in the store, deliberately: it changes every frame, and pushing it through a React state
 * update 60×/s would re-render the shell for a number that belongs in one DOM node. The transport
 * meter polls this on rAF and writes the width directly — the same rule the rest of the app follows
 * (hot surfaces never re-render).
 */
export function engineLevel(): number {
  return audio.level();
}

/** Flush the autosave now — `pagehide` does not wait for a debounce. */
export function flushAutosave(): Promise<void> {
  return autosaver.flush();
}

// ── The DJ-mixer bridge's hooks (web/src/companion/) ────────────────────────
// These live here because `audio` is module-scoped on purpose (see the header)
// and the bridge is the one other caller allowed to reach it.

/**
 * Engage / release ONE DECK's performance tempo. Republishes that deck immediately — mid-play this
 * re-latches at the next step boundary (phase-continuous), it does not restart the pattern.
 *
 * `deck` defaults to 0 for the DJ-mixer bridge, whose single-deck call site predates the axis.
 */
export function setTempoOverride(bpm: number | null, deck = 0): void {
  if (deck < 0 || deck >= MAX_DECKS) return;
  tempoOverrideBpm[deck] = bpm;
  // Only this deck republishes. The old global republished ALL of them, which
  // was harmless when there was one tempo and is wrong now: republishing a deck
  // whose tempo did not change is a world swap for nothing.
  publish(useCompanion.getState(), deck, deckOf(useCompanion.getState(), deck).playing);
}

export function getTempoOverride(deck = 0): number | null {
  return tempoOverrideBpm[deck] ?? null;
}

/** Per-window master fader — `sl_engine_set_main_gain`, downstream of the whole session mix.
 *  Engages an override that outlives republish (which otherwise re-seeds the session's level). */
export function setMainGain(value: number): void {
  mainGainOverride = value;
  audio.setMainGain(value);
}

/** RMS + peak of the output, for the mixer's meters. Same tap as `engineLevel`. */
export function engineLevels(): { rms: number; peak: number } {
  return audio.levels();
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GRID EDITING (P8-12). The grid owns the pattern under THE FLIP and publishes a whole track back
// on every edit; these are the store's side of that — the ONLY code that can touch the module's
// `audio` / `samples` / `sampleRates` / `autosaver`, so it lives here rather than in the panel.
//
// The GridBackend (in BrowserLink) applies the edit to its own projected rows and hands the merged
// document rows here; this folds them into the session and re-publishes the world, so the sound
// changes as you edit. Autosave debounces the writes — see the Autosaver.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fold a grid edit into the session document, re-publish the world, and schedule an autosave.
 *
 * SCENE-AWARE (one uniform path; scene A degenerates to "the whole row lands in sectionA"): the
 * grid edited the PROJECTED row, so the write splits it the way a desktop save would — fields in
 * `PATTERN_SCENE_FIELDS` are scene-local and land in the active scene's section; everything else
 * (mix scalars, mute, sample window, playbackMode, …) is global and lands in `sectionA`. A step
 * edit is scene-local; a volume edit is heard in every scene — exactly Swift's rule.
 */
export function applyGridRow(trackIndex: number, row: DocRow, deck = 0): void {
  const state = useCompanion.getState();
  const d = deckOf(state, deck);
  if (!d.session) return;
  const pattern = d.session.pattern as Record<string, unknown>;
  const scene = d.scene;

  // colour + settings live in baseSettings.trackSettings[i], not on the track — write both, or the
  // colour edit is shown and lost (see gridProjection).
  const base = { ...((pattern.baseSettings as Record<string, unknown>) ?? {}) };
  const trackSettings = [...((base.trackSettings as unknown[]) ?? [])];
  trackSettings[trackIndex] = row.settings;
  base.trackSettings = trackSettings;

  type Row = Record<string, unknown>;
  const edited = row.track as Row;
  const sectionA = [...((pattern.sectionA as Row[]) ?? [])];
  let nextPattern: Record<string, unknown>;

  if (scene === "A") {
    sectionA[trackIndex] = edited;
    nextPattern = { ...pattern, sectionA, baseSettings: base };
  } else {
    const key = sectionKeyFor(scene);
    let sceneRows = [...((pattern[key] as Row[]) ?? [])];
    // Swift's lazy materialization (BeatSequencer.swift:11201): the first edit in an empty scene
    // deep-copies A into it. A real document edit — it autosaves; untouched files stay byte-stable.
    if (sceneRows.length === 0) sceneRows = sectionA.map((r) => structuredClone(r));

    const oldBase = (sectionA[trackIndex] as Row) ?? {};
    const oldScene = sceneRows[trackIndex] ?? structuredClone(oldBase);
    const { baseRow, sceneRow } = splitSceneEdit(edited, oldBase, oldScene);
    sceneRows[trackIndex] = sceneRow;
    sectionA[trackIndex] = baseRow;
    nextPattern = { ...pattern, sectionA, [key]: sceneRows, baseSettings: base };
  }

  const nextSession = {
    ...d.session,
    pattern: nextPattern as typeof d.session.pattern,
  };
  useCompanion.setState((s) => patchDeck(s, deck, { session: nextSession }));
  publish(useCompanion.getState(), deck, d.playing);
  autosaver.schedule(nextSession);
}

/**
 * The ↻ locator-repeat toggle. On the desktop `toggleLocatorRepeat` is a selection-scoped Swift op
 * (trackOps.ts:19), so in the browser it fell into BrowserLink's silent accept — the button did
 * nothing. It IS a document field, and a pattern-scoped one (`locatorRepeatActive` is in
 * PATTERN_SCENE_FIELDS), so the browser flips it directly through the same scene-aware write the
 * grid edits use: scene A → sectionA; scene B+ → the scene's section (lazy-materialized).
 * Single-track only here (the desktop fans it across the multi-selection; the companion doesn't).
 */
export function toggleLocatorRepeatTrack(trackIndex: number, deck = 0): void {
  const state = useCompanion.getState();
  const d = deckOf(state, deck);
  if (!d.session) return;
  const pattern = d.session.pattern as Record<string, unknown>;
  const scene = d.scene;
  type Row = Record<string, unknown>;

  const projected = projectScene(d.session.pattern, scene).sectionA as Row[] | undefined;
  const current = Boolean(projected?.[trackIndex]?.locatorRepeatActive);

  const sectionA = [...((pattern.sectionA as Row[]) ?? [])];
  if (!sectionA[trackIndex]) return;
  let nextPattern: Record<string, unknown>;
  if (scene === "A") {
    sectionA[trackIndex] = { ...sectionA[trackIndex], locatorRepeatActive: !current };
    nextPattern = { ...pattern, sectionA };
  } else {
    const key = sectionKeyFor(scene);
    let sceneRows = [...((pattern[key] as Row[]) ?? [])];
    if (sceneRows.length === 0) sceneRows = sectionA.map((r) => structuredClone(r));
    const row = sceneRows[trackIndex] ?? structuredClone(sectionA[trackIndex]);
    sceneRows[trackIndex] = { ...row, locatorRepeatActive: !current };
    nextPattern = { ...pattern, [key]: sceneRows };
  }

  const nextSession = {
    ...d.session,
    pattern: nextPattern as typeof d.session.pattern,
  };
  useCompanion.setState((s) => patchDeck(s, deck, { session: nextSession }));
  publish(useCompanion.getState(), deck, d.playing);
  autosaver.schedule(nextSession); // a real document edit, unlike launch/solo
  // The grid repaints via the panel's session-keyed reload effect.
}

/** Per-track runtime info the grid needs — name + the decoded sample's duration/peak. */
export function gridRuntimeInfos(deck = 0): TrackRuntimeInfo[] {
  const d = deckOf(useCompanion.getState(), deck);
  if (!d.session) return [];
  const byId = new Map(kitSamples(d.session.kit).map((s) => [s.id, s]));
  const tracks = (d.session.pattern.sectionA as { sampleId?: string }[] | undefined) ?? [];
  const stopped = new Set(d.stoppedTracks);
  const soloed = new Set(d.soloedTracks);
  return tracks.map((t, i) => {
    const sample = t.sampleId ? byId.get(t.sampleId) : undefined;
    return {
      name: sample?.name ?? `Track ${i + 1}`,
      sampleKey: sample?.filePath ?? null,
      // A REAL duration, decoded at open — gridWave bails on <= 0 and draws NOTHING. The old
      // hardcoded 0 here (backed by a comment claiming peaks were enough) deleted every cell
      // waveform in the companion.
      sampleDurationMs: sample ? sampleDurations.get(sample.filePath) ?? 0 : 0,
      samplePeakGain: 1,
      // The RUNTIME launch gate — so the grid's ▶/■ shows the truth (it used to show every
      // stopped track as running).
      isStopped: stopped.has(i),
      // Solo lights the S button and drives the recede/halo language (GridPanel reads t.soloed).
      soloed: soloed.has(i),
    };
  });
}

function baseNameNoExt(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Copy a picked audio file into the OPFS library and return its path — the LOAD button's other
 * half (pick → import → assign). Lives here because the module's SampleStore owns the writes.
 */
export async function importAudioFile(file: File): Promise<string> {
  const { imported } = await samples.importFiles("/samples/Imported", [file]);
  if (imported === 0) throw new Error(`${file.name} is not an audio file`);
  return `/samples/Imported/${file.name}`;
}

/** OPFS path per track's sample — so the grid can ask the store for cell waveform peaks. */
export function gridPeakPaths(deck = 0): (string | null)[] {
  const d = deckOf(useCompanion.getState(), deck);
  if (!d.session) return [];
  const byId = new Map(kitSamples(d.session.kit).map((s) => [s.id, s.filePath]));
  const tracks = (d.session.pattern.sectionA as { sampleId?: string }[] | undefined) ?? [];
  return tracks.map((t) => (t.sampleId ? byId.get(t.sampleId) ?? null : null));
}

export { saveSession };
