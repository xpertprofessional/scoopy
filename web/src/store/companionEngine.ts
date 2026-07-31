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
import { oneShotStopStep, shiftBeatRepeatWindow } from "../audio/deckTransport.ts";
import { resolveSwitchAction, type SwitchMode } from "../audio/sceneSwitch.ts";
import {
  clearSceneOverrides as clearLayerOverrides,
  isPinnableKey,
  pinKey,
  pinnedKeysFor,
  pushKeyToAll,
  unpinKey,
  type SceneLayers,
} from "../audio/sceneOverrides.ts";
import {
  SCENE_LETTERS,
  SECTION_KEYS,
  projectScene,
  sectionKeyFor,
  splitSceneEdit,
  type SceneLetter,
} from "../audio/sceneProjection.ts";
import { worldFromSession } from "../audio/worldFromSession.ts";
import { useCapabilitiesStore } from "../state/capabilitiesStore.ts";
import { kitSamples } from "../persist/kit.ts";
import { resetUndo } from "../state/undoStore.ts";
import { decodePatternFileAnyVersion } from "../persist/migrations.ts";
import type { DocRow } from "./gridProjection.ts";
import type { TrackRuntimeInfo } from "./gridBackend.ts";
import { SampleStore } from "./sampleStore.ts";
import {
  Autosaver,
  createSession,
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
  /** P3-M-1b/D4-2: runtime transport verbs, never the document — a beat repeat
      is a hand gesture. IN DeckState (they were module arrays) since D4-2, so
      the deck tile's header lamps can read the per-deck TRUTH reactively;
      restated by every publish; dies with the deck (closeDeck → idleDeck). */
  beatRepeat: { startStep: number; length: number; subdivision?: number } | null;
  reverse: boolean;
  /**
   * ONE-SHOT: the step this deck stops itself at, or null for free-running.
   * RUNTIME like the transport verbs above — a one-shot is a hand gesture, never
   * a document field. Ported from `BeatSequencer.stopTargetStep`
   * (BeatSequencer.swift:2120, armed by `playOnce()` :3573-3587, consumed at
   * :4220-4225 as `currentStep >= target → stop()`).
   */
  stopAtStep: number | null;
  /**
   * What a plain pad click DOES on this deck — the donor's
   * `patternSceneMouseSwitchMode` (BeatSequencer.swift:1672). RUNTIME, like the
   * scene itself: it is a performance preference, and the donor's own default
   * is `scheduled`.
   */
  switchMode: SwitchMode;
  /**
   * CLEAN CUT: at a scene switch the engine chokes every still-ringing voice
   * (~10 ms fade) instead of letting the old scene ring out. FX/send tails keep
   * ringing either way. The donor holds this as a GLOBAL UserDefaults
   * preference (`patternScene.cleanCutSwitch`); per deck here for the same
   * reason TP mode is per strip — D-SL-MORPH-01 left no global deck to hang it
   * on. Default off = today's seamless ring-out, so nothing changes until asked.
   */
  cleanCut: boolean;
  /**
   * SCN — the scene-edit latch. With it on, editing a parameter auto-pins it to
   * the current scene rather than writing the session-global value (the donor's
   * `sceneEditLatched`, pinned by `sceneEditLatchAutoPinsEditedParameters`).
   * The PIN half lands with the override ops; this carries the switch.
   */
  sceneLatched: boolean;
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
    beatRepeat: null,
    reverse: false,
    stopAtStep: null,
    switchMode: "scheduled",
    cleanCut: false,
    sceneLatched: false,
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
  /**
   * P3.5-E8g-h — APPEND AN EMPTY TRACK AT THE END, and return its index.
   *
   * The create half of an UNTARGETED sample load (a FILES double-click names no
   * row, so it must not overwrite one), and the browser's answer to the
   * `addTrack` command that ⌘T and the MasterRow `+` have been firing into a
   * throw. ONE creator behind all three, deliberately: three doors each growing
   * the document their own way is how the eight sections drift apart.
   *
   * Returns `null` when it REFUSED, and a refusal always says why on the store's
   * error line — never a silent no-op. Two refusals exist: no session open, and
   * the `MAX_TRACKS` ceiling.
   */
  appendTrack(deck?: number): Promise<number | null>;
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
  /**
   * B1/P7-T1: ONE-SHOT — play exactly one LCM cycle, then stop. Ported from
   * `BeatSequencer.playOnce()` (BeatSequencer.swift:3573-3587) whole:
   *   · stopped  → arm the stop at `lcm - 1` and start
   *   · playing  → arm it at the end of the CURRENT cycle, do not restart
   * The LCM is the pattern's, not a bar count, so it is the same law the queued
   * scene switch uses (`lcmForScene`) and two strips one-shotting together do
   * NOT share a boundary — correct, and the reason the donor computes it per
   * session too.
   */
  playOnce(deck?: number): void;
  /** P3-M-1b: latch/release a beat repeat on this deck (runtime, republishes).
      null releases. */
  setBeatRepeat(
    deck: number,
    br: { startStep: number; length: number; subdivision?: number } | null,
  ): void;
  /**
   * B1/P7-T2: nudge a LATCHED beat repeat's window one slot left/right. Ported
   * from `BeatSequencer.shiftBeatRepeat(by:)` (BeatSequencer.swift:20390-20427),
   * including its two guards — a shift does nothing unless the deck is PLAYING
   * and a repeat is actually latched — and its sub-cell carry: at subdivision
   * > 1 the window moves by sub-cells and carries whole steps, so the micro
   * stutter walks smoothly rather than jumping a step at a time.
   * Negative starts wrap by a whole LCM, which leaves the audible fold unchanged.
   */
  shiftBeatRepeat(deck: number, delta: number): void;
  /**
   * B1/P7-T1: the DJ INSTANT DOUBLE — clone `from`'s session onto `to` as an
   * unsaved copy. ⚠️ Not "double the pattern length": the donor's DBL is
   * `NativeDJCoordinator.doubleDeck(from:to:)` (DJModeView.swift:899-921), which
   * copies a deck's whole session to the OTHER deck so you can mix a track
   * against itself. Refuses (returns false) when the source has nothing to
   * double or the destination is busy — the same three refusals the donor makes,
   * minus its temp-file round-trip, which existed only because Swift had no
   * in-memory session copy.
   */
  cloneDeck(from: number, to: number): boolean;
  /** P3-M-1b: whole-session tape reverse (runtime, republishes). */
  setReverse(deck: number, on: boolean): void;
  setBpm(bpm: number, deck?: number): void;
  /** P3-D4-1a: the session's master volume (document `masterVolume`, 0..2 —
      >1 drives the master clipper). A document edit like setBpm: republish +
      autosave; the world carries it to the engine's per-deck master stage. */
  setMasterVolume(value: number, deck?: number): void;
  /** P3-D4-1a: the session's master clipper drive (document
      `masterClipperDrive`, 1..32). Same lane as setMasterVolume. */
  setMasterDrive(value: number, deck?: number): void;
  /** P3-X2: the session's master clipper CURVE (document `masterClipperCurve`,
      0 soft · 1 tanh · 2 hard · 3 fold). Same lane as setMasterDrive — this is
      the grid half of the per-strip DRV surface: the strip Inspector's curve
      select writes the SESSION for a grid strip, because the core's per-deck
      drive stage is document-fed (a live channel-tier projection would be
      stomped by the next republish). */
  setMasterDriveCurve(curve: number, deck?: number): void;
  /**
   * Switch the active pattern scene. While playing, a plain select SCHEDULES the switch at the
   * next cycle boundary (the desktop's default switch mode); `immediate` runs it now
   * (⌘-click / the desktop's R). Selecting the ACTIVE scene cancels a pending switch. Stopped →
   * always immediate.
   */
  selectScene(scene: SceneLetter, opts?: { immediate?: boolean; deck?: number }): void;
  /** B2: which way a plain pad click switches on this deck (SCHED/RUN/START). */
  setSwitchMode(mode: SwitchMode, deck?: number): void;
  /** B2: clean-cut switching — choke ringing voices at the boundary. `on`
      omitted TOGGLES, mirroring the donor's menu-checkbox gesture. */
  setCleanCut(on?: boolean, deck?: number): void;
  /** B2: SCN — the scene-edit latch. */
  toggleSceneLatch(deck?: number): void;
  /**
   * B2: pin a parameter to the deck's CURRENT scene, so it forks off the shared
   * base (`BeatSequencer.pinToCurrentScene`). Returns false when the key is
   * outside the pinnable vocabulary — the caller should not have offered it.
   */
  pinToScene(key: string, deck?: number): boolean;
  /** B2: "reset to global" — the value reverts to the base everywhere. */
  unpinFromScene(key: string, deck?: number): void;
  /**
   * B2: make this key global again — writes the current value into the base and
   * drops the pin from EVERY scene. ⚠️ Not "copy into every scene".
   */
  pushSceneKeyToAll(key: string, deck?: number): void;
  /** B2: drop every override of a scene, so it mirrors the base again. */
  clearSceneOverrides(scene: SceneLetter, deck?: number): void;
  /** B2: the keys pinned to this deck's current scene — what a control reads to
      wear its pinned ring. */
  pinnedKeys(deck?: number): string[];
  /**
   * P3-U8: grow (or shrink) the session's scene row — a DOCUMENT edit
   * (`pattern.enabledSceneCount`, clamped 1..8), autosaved like any other.
   * Shrinking below the active/queued scene falls back to scene A immediately:
   * a pad that no longer exists must not stay the one playing.
   */
  setEnabledSceneCount(count: number, deck?: number): void;
  /** Flip a track's launch gate (the grid's ▶/■) — immediate, unquantized. */
  toggleLaunch(trackIndex: number, deck?: number): void;
  /** Flip a track's solo — desktop semantics: peers ride the mixMuted gain ramp, triggers keep firing. */
  toggleSoloTrack(trackIndex: number, deck?: number): void;
  dismissNotice(): void;
}

/**
 * THE PIN HELPERS (B2). Kept beside `patchDeck` because they are the same kind
 * of thing: the one place a particular slice of the document is written.
 */

/** This pattern's scene layers, always an object so callers need no null dance. */
function sceneLayersOf(pattern: Record<string, unknown>): SceneLayers {
  const raw = pattern.sceneSettingsLayers;
  return raw && typeof raw === "object" ? ({ ...(raw as SceneLayers) }) : {};
}

/**
 * What a pin forks OFF — the settings as they sound right now: the shared base
 * with the current scene's layer already applied.
 *
 * The donor calls this `captureLiveSettings` and flushes it into the base before
 * forking, so a pin starts from what you are hearing rather than from what was
 * last written to disk. Here the base IS the document, so the capture is the
 * overlay rather than a separate live buffer.
 */
function captureLiveSettings(
  pattern: Record<string, unknown>,
  scene: SceneLetter,
): Record<string, unknown> {
  const base = (pattern.baseSettings as Record<string, unknown> | undefined) ?? {};
  const layer = sceneLayersOf(pattern)[scene];
  return { ...base, ...(layer?.values ?? {}) };
}

/**
 * Merge ONE key's live value into the base — push-to-all's other half. Only the
 * pushed key moves: writing the whole live capture would drag every other
 * currently-forked value into the base with it, silently globalising things
 * nobody asked about.
 */
function mergeKeyIntoBase(
  pattern: Record<string, unknown>,
  key: string,
  live: Record<string, unknown>,
): Record<string, unknown> {
  const base = { ...((pattern.baseSettings as Record<string, unknown> | undefined) ?? {}) };
  if (key === "bpm") {
    if (live.bpm !== undefined) base.bpm = live.bpm;
    return base;
  }
  const [, idxRaw, field] = key.split(".");
  const idx = Number(idxRaw);
  const liveTracks = (live.trackSettings as Record<string, unknown>[] | undefined) ?? [];
  const src = liveTracks[idx];
  if (!Number.isInteger(idx) || !src || !field) return base;
  const tracks = [...(((base.trackSettings as Record<string, unknown>[] | undefined) ?? []))];
  tracks[idx] = { ...(tracks[idx] ?? {}), [field]: src[field] };
  base.trackSettings = tracks;
  return base;
}

/** Write a deck's layers (and optionally its base) back, republish, autosave. */
function writeSceneLayers(
  deck: number,
  layers: SceneLayers,
  baseSettings?: Record<string, unknown>,
): void {
  const st = useCompanion.getState();
  const d = deckOf(st, deck);
  if (!d.session) return;
  const pattern = {
    ...(d.session.pattern as Record<string, unknown>),
    sceneSettingsLayers: layers,
    ...(baseSettings ? { baseSettings } : {}),
  };
  const next: WorkingSession = { ...d.session, pattern: pattern as typeof d.session.pattern };
  useCompanion.setState((s) => patchDeck(s, deck, { session: next }));
  // Audible NOW — a pin that only took effect after a reload would read as
  // broken at exactly the moment it is used.
  publish(useCompanion.getState(), deck, deckOf(useCompanion.getState(), deck).playing);
  // Persisted, unlike the runtime scene state: the point of a pin is that the
  // scene keeps its own value across a reload.
  autosaver.schedule(next);
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

// (P3-M-1b's beatRepeatState/reverseState module arrays moved INTO DeckState at
// D4-2 — the deck tile's header lamps need the per-deck truth reactively.)

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
      // The HOST decides (P6-3): the merged shell hosts return plugins now and
      // answers returnFx true, so the tracks' send levels must travel; the
      // browser companion still answers false (a WASM worklet hosts no AU) and
      // renders dry, matching its hidden sends row. The document's send values
      // stay untouched either way — this only gates what the ENGINE hears.
      disableReturnFx: !useCapabilitiesStore.getState().caps.returnFx,
      // The transport verbs ride every publish (P3-M-1b) — restating them is
      // what makes them survive scene switches and edits.
      beatRepeat: d.beatRepeat,
      reverseTransport: d.reverse,
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

/**
 * THE TRACK CEILING — 16, and MEASURED rather than assumed (P3.5-E8g-h).
 *
 * ⚠️ NOTHING IN THIS STACK ENFORCED IT. The number is stated in exactly one
 * place, `MasterRow.tsx:10`, where it only greys the `+` button; the schema's
 * `addTrack` comment says a refusal "comes back as an error, not a silent no-op
 * — native's `addTrackInternal` only prints, which is how you get a button that
 * does nothing", but that enforcement is SWIFT'S, and there is no Swift in
 * either shipping host. The pattern-file decoder types the sections as
 * `arr(TRACK)` with no length bound (`patternFile.ts:672-679`), `worldFromSession`
 * iterates whatever it is given, and neither the WASM engine nor `SlWorldApply`
 * caps the count. So the ceiling is a UI CONVENTION, and this is the first
 * place that actually holds it.
 *
 * It is held here rather than at each door because a limit enforced per-door is
 * a limit the next door forgets. `trackCeiling.test.ts` pins this against
 * MasterRow's literal by reading its source — the two cannot be imported into
 * one another (MasterRow is the shared GridPanel chrome and mounts on the
 * native host too, where this store does not exist), so the drift is caught
 * instead of prevented.
 */
export const MAX_TRACKS = 16;

/**
 * THE CANONICAL EMPTY TRACK, from the same template a fresh session is made of.
 *
 * A new track is not hand-built. `createSession` (sessionStore.ts:129) decodes
 * `fresh-default.json` — the byte-pinned fresh-DESKTOP-save — and every one of
 * its eight tracks is identical except for `id` and `colorHex` (measured). So
 * "an empty track" already has an exact definition on disk, and copying it is
 * the only shape that cannot drift: a hand-typed field list would be the
 * `SECTION_KEYS` injury one level down (a subset that silently skips G and H),
 * except across ~155 track fields instead of eight sections.
 *
 * Decoded ONCE and cached. The import is the same code-split chunk `createSession`
 * already pulls, so a session that never adds a track pays nothing for this.
 *
 * ⚠️ CHECKED FIELD-BY-FIELD AGAINST THE SHIPPING APP, which is what this is a port
 * of — `BeatSequencer.makeEmptyTrack` (`../scoopyloops`, :15507). Everything agrees
 * with the template except ONE field, and the divergence is the ORIGINAL'S:
 *
 *   16 steps          — `templateStepCount` defaults to 16 (:15508); the fixture's
 *                       arrays are all length 16. Note the original reads a
 *                       PREFERENCE, not the open session's step count, so a
 *                       32-step session there also gets a 16-step new track.
 *   volume 0.8        — :15529, matches.
 *   pan 0, chokeGroup 0, playbackMode regular (`templateSamplerMode` default),
 *                       cellLengths all 1 — all match.
 *   palette[i % 8]    — :15493-15503. The eight `colorHex` values in this fixture
 *                       ARE that palette (warm red · orange · yellow · lime ·
 *                       teal · blue · violet · magenta), channel for channel;
 *                       verified all eight. The ramp is READ OUT OF THE DOCUMENT
 *                       rather than restated here — which is both why
 *                       `check:tokens` stays green and why a palette change on
 *                       the desktop would arrive with no code edit at all.
 *   trackGain         — **the one divergence, and the one place we do NOT follow
 *                       the original.** `makeEmptyTrack` sets 0.80 (:15576) while
 *                       `createDefaultTracks` leaves it 1.0, so in the shipping
 *                       app an ADDED track is quieter than a FRESH-SESSION track.
 *                       **RULED 2026-07-30 (user): 1.0.** See below.
 */
/** Unity, deliberately — and this is a departure from the original, so it is
    written down rather than left to look like an oversight.

    `makeEmptyTrack` gives an appended track 0.80 (BeatSequencer.swift:15576)
    while a fresh session's tracks sit at 1.0, so in the shipping app the same
    sample is quieter depending on how its track came to exist. That is the
    original's own inconsistency, not a considered headroom policy.

    **RULED 2026-07-30 (user): unity, and NO normalisation on load.** A loaded
    sample plays at the level it was authored at — the track adds nothing and
    takes nothing away. So a quiet sample stays quiet and a hot one stays hot,
    and the relative balance a person built into a kit survives being loaded.

    ⚠️ **Do not "fix" this by adding load-time gain analysis.** It was considered
    and ruled out by the user. `sampleStore.peakEnvelope` already computes a
    peak/RMS envelope for the waveform, so the measurement is sitting right
    there and is easy to reach for — which is exactly why this note exists.
    Analysing it into a gain would silently move levels a person set on purpose.

    Read as `gain` by `toGridPattern` (:154) and multiplied into the world's
    per-track volume (`worldFromSession.ts:351`). */
const TRACK_GAIN_ON_ADD = 1.0;
interface TrackTemplate {
  track: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** The fresh document's eight track colours, in order — cycled past track 8. */
  colors: string[];
}
let trackTemplate: Promise<TrackTemplate> | null = null;
function blankTrackTemplate(): Promise<TrackTemplate> {
  trackTemplate ??= (async () => {
    const { default: freshText } = await import("../../fixtures/patternfile/fresh-default.json?raw");
    const pattern = decodePatternFileAnyVersion(freshText) as unknown as Record<string, unknown>;
    const tracks = (pattern.sectionA as Record<string, unknown>[] | undefined) ?? [];
    const base = pattern.baseSettings as { trackSettings?: Record<string, unknown>[] } | undefined;
    const settings = base?.trackSettings ?? [];
    return {
      track: tracks[0] ?? {},
      settings: settings[0] ?? {},
      // Only the ones the document actually states — no literal fallback, so this
      // module never carries a colour of its own (`check:tokens`).
      colors: settings.flatMap((s) => (typeof s.colorHex === "string" ? [s.colorHex] : [])),
    };
  })();
  return trackTemplate;
}

/** A deep copy of a pure-JSON document subtree. The template is shared across every
    append, so a shallow spread would let one new track's `steps` array alias another's. */
function cloneRow<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
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
    // (The transport verbs — beatRepeat/reverse — live in DeckState since
    // D4-2, so idleDeck() above already cleared them with the slot.)
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
      // Create on disk (sessionStore owns the fresh document + unique naming —
      // P3-L1 moved it there so the plane's library can create WITHOUT
      // loading), then open: the companion's New is create-and-open.
      const { name } = await createSession();
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

  async appendTrack(deck = 0) {
    const session = deckOf(get(), deck).session;
    if (!session) {
      set({ error: "open (or create) a session first — a track needs a document" });
      return null;
    }
    const pattern = { ...(session.pattern as Record<string, unknown>) };
    // Section A is the track-count authority, the same rule `carveIntoSession`
    // states ("Section A is the emptiness authority") — every section carries
    // one row per track and A is the one every projection reads.
    const rowsA = pattern.sectionA;
    if (!Array.isArray(rowsA)) {
      set({ error: "this session has no track list — it cannot take another track" });
      return null;
    }
    const index = rowsA.length;
    if (index >= MAX_TRACKS) {
      // THE REFUSAL, SPOKEN. ⚠️ The alternative — returning null quietly — is
      // this codebase's recurring injury: an intent accepted and discarded
      // (P3.5-E8c's dropped `asStretch`, the inert `launchQuantize`). A door
      // that cannot do the thing must say so where the user is already looking,
      // which is the same line `loadSample` and `carveIntoSession` refuse on.
      set({
        error: `this session is full — ${MAX_TRACKS} tracks is the ceiling; free one, then load again`,
        notice: null,
      });
      return null;
    }

    const template = await blankTrackTemplate();
    // ONE id shared across the eight sections, because they are eight views of
    // the SAME track — the fresh template's rows are id-identical per track
    // (measured), and a per-section id would make the track eight tracks.
    const id = crypto.randomUUID().toUpperCase(); // Swift writes uppercase UUIDs
    for (const key of SECTION_KEYS) {
      const tracks = pattern[key];
      if (!Array.isArray(tracks)) continue;
      // EVERY section gets the row, exactly as the original appends one
      // `PatternData` to all eight `patternScene*Patterns` arrays
      // (BeatSequencer.swift:15645-15652) — a track that exists in scene A and
      // nowhere else is a document that renumbers when you switch scenes.
      pattern[key] = [...tracks, { ...cloneRow(template.track), id, trackGain: TRACK_GAIN_ON_ADD }];
    }
    const base = pattern.baseSettings as Record<string, unknown> | undefined;
    if (base && Array.isArray(base.trackSettings)) {
      pattern.baseSettings = {
        ...base,
        trackSettings: [
          ...base.trackSettings,
          // The palette CYCLES — `palette[index % palette.count]`, the original's own
          // rule (BeatSequencer.swift:15515) — so past track 8 the ramp starts over
          // rather than repeating one colour.
          {
            ...cloneRow(template.settings),
            // Spread LAST and only when the document stated a ramp — a template with
            // no colours leaves the copied row's own `colorHex` standing, rather than
            // this module inventing one.
            ...(template.colors.length
              ? { colorHex: template.colors[index % template.colors.length] }
              : {}),
            // Both copies carry the gain, because both are in the file and a
            // desktop re-save reads the settings side.
            trackGain: TRACK_GAIN_ON_ADD,
          },
        ],
      };
    }

    const next: WorkingSession = { ...session, pattern: pattern as WorkingSession["pattern"] };
    set((s) => patchDeck(s, deck, { session: next }));
    // A document edit like `setBpm`: the world carries the new (silent) track to
    // the engine, and the session autosaves. Republishing here rather than
    // leaving it to the caller is what makes the `addTrack` door — which has no
    // follow-up load — land in the engine at all.
    publish(get(), deck, deckOf(get(), deck).playing);
    autosaver.schedule(next);
    set({ notice: `track ${index + 1} added`, error: null });
    return index;
  },

  async loadSample(trackIndex, path, deck = 0) {
    try {
      const session = deckOf(get(), deck).session;
      if (!session) {
        set({ error: "open (or create) a session first — a sample loads into a track" });
        return;
      }
      // NO SUCH TRACK — REFUSED, NOT SKIPPED (P3.5-E8g-h).
      //
      // The section loop below skips every section whose length the index is past,
      // so an out-of-range index used to fall through the whole method and still set
      // `<name> → track 99` on the notice line: a load that changed nothing and said
      // it worked. Measured while routing the untargeted load, and it is the same
      // silent-accept species this row exists to close. The original refuses the same
      // case out loud — "No such track." (`WebFileBrowserBinding.loadBrowserSample`,
      // ../scoopyloops:212).
      const rowCount = Array.isArray(session.pattern.sectionA) ? session.pattern.sectionA.length : 0;
      if (trackIndex < 0 || trackIndex >= rowCount) {
        set({ error: `no track ${trackIndex + 1} in this session`, notice: null });
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
    set((s) => patchDeck(s, deck, { beatRepeat: br }));
    if (audio.running && deckOf(get(), deck).session)
      publish(get(), deck, deckOf(get(), deck).playing);
  },

  setReverse(deck, on) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    set((s) => patchDeck(s, deck, { reverse: on }));
    if (audio.running && deckOf(get(), deck).session)
      publish(get(), deck, deckOf(get(), deck).playing);
  },

  play(deck = 0) {
    if (!audio.running || !deckOf(get(), deck).session) return;
    // Play restarts at step 0 — a pending switch armed against the old clock is meaningless.
    // A plain play also DISARMS a one-shot: pressing ▶ means "keep going".
    set((s) =>
      patchDeck(s, deck, {
        playing: true,
        scheduledScene: null,
        switchBoundaryStep: null,
        stopAtStep: null,
      }),
    );
    set((s) => patchDeck(s, deck, { missingSamples: publish(get(), deck, true) }));
  },

  stop(deck = 0) {
    if (!audio.running) return;
    set((s) =>
      patchDeck(s, deck, {
        playing: false,
        scheduledScene: null,
        switchBoundaryStep: null,
        stopAtStep: null,
      }),
    );
    publish(get(), deck, false);
  },

  playOnce(deck = 0) {
    const d = deckOf(get(), deck);
    if (!audio.running || !d.session) return;
    const cycle = lcmForScene(d.session.pattern, d.scene);
    const stopAtStep = oneShotStopStep(cycle, d.playing, audio.position()?.step ?? 0);
    if (stopAtStep === null) return; // no cycle to play once

    if (d.playing) {
      // ALREADY PLAYING → arm the stop at the end of the cycle in flight, and do
      // NOT restart. Landing this on `play()` instead would jump the playhead
      // back to 0, which is the opposite of "let this one finish".
      set((s) => patchDeck(s, deck, { stopAtStep }));
      return;
    }
    // STOPPED → one full cycle from the top. Armed AFTER the playing flag but in
    // its own write, because `play()` clears the arm — going through play() here
    // would disarm what we just set. Order is load-bearing, not style.
    set((s) => patchDeck(s, deck, { playing: true, scheduledScene: null, switchBoundaryStep: null }));
    set((s) => patchDeck(s, deck, { stopAtStep, missingSamples: publish(get(), deck, true) }));
  },

  shiftBeatRepeat(deck, delta) {
    if (deck < 0 || deck >= MAX_DECKS || delta === 0) return;
    const d = deckOf(get(), deck);
    // BOTH donor guards. A shift with nothing latched, or on a stopped deck, is
    // not an error — it is a no-op, and making it one keeps the control live on
    // screen without it doing something invisible.
    if (!d.playing || !d.beatRepeat || !d.session) return;

    const br = d.beatRepeat;
    const sub = Math.max(1, br.subdivision ?? 1);
    const moved = shiftBeatRepeatWindow(
      { startStep: br.startStep, startSubcell: (br as { startSubcell?: number }).startSubcell ?? 0 },
      delta,
      sub,
      lcmForScene(d.session.pattern, d.scene),
    );
    set((s) =>
      patchDeck(s, deck, {
        beatRepeat: {
          ...br,
          startStep: moved.startStep,
          ...(sub > 1 ? { startSubcell: moved.startSubcell } : {}),
        },
      }),
    );
    if (audio.running) publish(get(), deck, deckOf(get(), deck).playing);
  },

  cloneDeck(from, to) {
    if (from < 0 || from >= MAX_DECKS || to < 0 || to >= MAX_DECKS || from === to) return false;
    const src = deckOf(get(), from);
    const dst = deckOf(get(), to);
    // The donor's three refusals, in its order: nothing to double, destination
    // busy, copy failed. The third cannot happen here — Swift needed a temp-file
    // save/load round-trip to copy a session and this is a structural clone — so
    // it is two, and saying which two is the point.
    if (!src.session) return false;
    const srcRows = src.session.pattern.sectionA;
    if (!Array.isArray(srcRows) || srcRows.length === 0) return false;
    if (dst.playing) return false;

    // UNSAVED COPY, AND THE NAME IS WHAT MAKES IT ONE. `name` is this model's
    // file identity — it is the key `open()` and the autosaver write back
    // through — so a clone that kept it would autosave the double straight over
    // the original the first time anyone touched a step. The donor gets the same
    // property from `loadSessionAsUnsavedCopy` dropping the file URL while
    // keeping the display name; here, renaming IS dropping the identity.
    //
    // The pattern is deep-cloned (the double must edit independently) but the
    // KIT is shared by reference on purpose: it is decoded audio, registered
    // with the engine under content ids, and copying it would re-register every
    // sample to say the same thing.
    const copy: WorkingSession = {
      ...src.session,
      name: `${src.session.name} (double)`,
      pattern: structuredClone(src.session.pattern),
      extras: new Map(src.session.extras),
    };
    set((s) => patchDeck(s, to, { ...idleDeck(), session: copy, scene: src.scene }));
    if (audio.running) {
      set((s) => patchDeck(s, to, { missingSamples: publish(get(), to, false) }));
    }
    set({ notice: `doubled onto strip ${to + 1}` });
    return true;
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

  setMasterVolume(value, deck = 0) {
    const session = deckOf(get(), deck).session;
    if (!session) return;
    const v = Math.min(2, Math.max(0, value));
    const next: WorkingSession = {
      ...session,
      pattern: { ...session.pattern, masterVolume: v },
    };
    set((s) => patchDeck(s, deck, { session: next }));
    // The publish is what makes the edit AUDIBLE: the world carries
    // masterVolume to the engine's per-deck master stage (worldFromSession's
    // masterStage block). Document edit → autosave, like setBpm.
    publish(get(), deck, deckOf(get(), deck).playing);
    autosaver.schedule(next);
  },

  setMasterDrive(value, deck = 0) {
    const session = deckOf(get(), deck).session;
    if (!session) return;
    const v = Math.min(32, Math.max(1, value));
    const next: WorkingSession = {
      ...session,
      pattern: { ...session.pattern, masterClipperDrive: v },
    };
    set((s) => patchDeck(s, deck, { session: next }));
    publish(get(), deck, deckOf(get(), deck).playing);
    autosaver.schedule(next);
  },

  setMasterDriveCurve(curve, deck = 0) {
    const session = deckOf(get(), deck).session;
    if (!session) return;
    // Only the four named curves — a wrong id would pick DSP the user never
    // chose (the engine's own deck-scope guard, applied at the document too).
    if (!Number.isInteger(curve) || curve < 0 || curve > 3) return;
    const next: WorkingSession = {
      ...session,
      pattern: { ...session.pattern, masterClipperCurve: curve },
    };
    set((s) => patchDeck(s, deck, { session: next }));
    publish(get(), deck, deckOf(get(), deck).playing);
    autosaver.schedule(next);
  },

  setSwitchMode(mode, deck = 0) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    set((s) => patchDeck(s, deck, { switchMode: mode }));
  },

  setCleanCut(on, deck = 0) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    set((s) => patchDeck(s, deck, { cleanCut: on ?? !deckOf(get(), deck).cleanCut }));
  },

  toggleSceneLatch(deck = 0) {
    if (deck < 0 || deck >= MAX_DECKS) return;
    set((s) => patchDeck(s, deck, { sceneLatched: !deckOf(get(), deck).sceneLatched }));
  },

  /**
   * THE PIN OPS. All four rewrite `pattern.sceneSettingsLayers`, which
   * `resolveSceneSettings` has read since P5-06 and NOTHING has ever written —
   * the read half shipped without its writer, so every pinnable control on the
   * desktop had no counterpart here at all.
   *
   * A document edit like `setBpm`: republish so the change is audible now, then
   * autosave. Pins are persisted state, not runtime — the whole point is that a
   * scene keeps its own value across a reload.
   */
  pinToScene(key, deck = 0) {
    const d = deckOf(get(), deck);
    if (!d.session || !isPinnableKey(key)) return false;
    // The live capture the fork starts from — the donor flushes live settings
    // into the base first (`commitLiveSettings`) so the scene's copy is what you
    // are HEARING, not what was last written to disk.
    const live = captureLiveSettings(d.session.pattern, d.scene);
    const layers = pinKey(sceneLayersOf(d.session.pattern), d.scene, key, live);
    writeSceneLayers(deck, layers);
    return true;
  },

  unpinFromScene(key, deck = 0) {
    const d = deckOf(get(), deck);
    if (!d.session) return;
    writeSceneLayers(deck, unpinKey(sceneLayersOf(d.session.pattern), d.scene, key));
  },

  pushSceneKeyToAll(key, deck = 0) {
    const d = deckOf(get(), deck);
    if (!d.session || !isPinnableKey(key)) return;
    // THE VALUE GOES TO THE BASE, and the forks go away. Writing it into every
    // layer instead would leave eight values that agree today and drift the
    // moment one is touched — the opposite of what the gesture means.
    const live = captureLiveSettings(d.session.pattern, d.scene);
    const { layers } = pushKeyToAll(sceneLayersOf(d.session.pattern), key);
    writeSceneLayers(deck, layers, mergeKeyIntoBase(d.session.pattern, key, live));
  },

  clearSceneOverrides(scene, deck = 0) {
    const d = deckOf(get(), deck);
    if (!d.session) return;
    writeSceneLayers(deck, clearLayerOverrides(sceneLayersOf(d.session.pattern), scene));
  },

  pinnedKeys(deck = 0) {
    const d = deckOf(get(), deck);
    return d.session ? pinnedKeysFor(d.session.pattern, d.scene) : [];
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
    // WHICH WAY THIS DECK SWITCHES is the deck's own mode now (B2), not a hard
    // "schedule unless told otherwise". `resolveSwitchAction` carries the
    // donor's rule that a STOPPED deck collapses scheduled into immediate —
    // arming a boundary against a clock that is not running would light the pad
    // and then never fire. An engine that is down is the same case.
    const action =
      !d.playing || !audio.running
        ? "seamless"
        : resolveSwitchAction(d.switchMode, d.playing, opts?.immediate);

    if (action !== "schedule") {
      set((s) => patchDeck(s, deck, { scene, scheduledScene: null, switchBoundaryStep: null }));
      // Undo entries replay whole grid states through the ACTIVE scene's write path — an entry
      // recorded in scene B must not replay into scene C. Desktop-consistent: Swift scene
      // switches are not undoable either.
      resetUndo();
      // The whole-world republish is phase-continuous mid-play (see publish()) — the desktop's
      // SEAMLESS-immediate switch. `restart` is the other mode and needs the
      // extra half: stop then play, which re-enters at step 0. Doing it as
      // stop+play rather than seeking is the same reasoning the transport's
      // restart uses — a publish cannot double as a retrigger.
      set((s) =>
        patchDeck(s, deck, {
          missingSamples: publish(get(), deck, deckOf(get(), deck).playing),
        }),
      );
      if (action === "restart" && deckOf(get(), deck).playing) {
        get().stop(deck);
        get().play(deck);
      }
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

  setEnabledSceneCount(count, deck = 0) {
    const st = get();
    const d = deckOf(st, deck);
    if (!d.session) return;
    const n = Math.min(SCENE_LETTERS.length, Math.max(1, Math.round(count)));
    const current =
      typeof d.session.pattern.enabledSceneCount === "number"
        ? d.session.pattern.enabledSceneCount
        : SCENE_LETTERS.length;
    if (n === current) return;
    const next: WorkingSession = {
      ...d.session,
      pattern: { ...d.session.pattern, enabledSceneCount: n },
    };
    // A scene past the new edge cannot stay active or armed. Fall back to A the
    // seamless-immediate way rather than leaving the engine on a pad the UI no
    // longer shows. (The add-pad only grows, so this is the defensive half.)
    const orphaned = SCENE_LETTERS.indexOf(d.scene) >= n;
    const orphanedQueue = d.scheduledScene !== null && SCENE_LETTERS.indexOf(d.scheduledScene) >= n;
    set((s) =>
      patchDeck(s, deck, {
        session: next,
        ...(orphaned ? { scene: "A" as SceneLetter } : {}),
        ...(orphaned || orphanedQueue ? { scheduledScene: null, switchBoundaryStep: null } : {}),
      }),
    );
    // Republish only when the audible projection changed — the count itself is
    // pad-row bookkeeping, but an orphan fallback re-projects the world.
    if (orphaned) publish(get(), deck, deckOf(get(), deck).playing);
    autosaver.schedule(next);
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
  // ⚠️ THIS BROADCAST BELONGS TO ONE DECK (P11-3a-b), and both lines below
  // depend on it. It used to carry a bare step with no owner while this handler
  // looped over every deck against it, so on the plane — three decks at three
  // tempos — a scene queued on strip B committed on strip A's grid. And this
  // early-return read DECK 0's transport, so a stopped strip A silently gated
  // B and C entirely. The sink stamps the owner now: `playing` is this deck's,
  // and the work below is this deck's.
  //
  // Two grid strips can each have a scene queued and they will NOT share a
  // boundary — their patterns have different LCMs, which is the whole reason
  // the boundary is computed per session rather than from a global bar count.
  if (!pos.playing) return;
  const deck = pos.deck;
  const st = useCompanion.getState();
  {
    // THE ONE-SHOT STOP, on the same broadcast as the scene commit below and for
    // the same reason: it must fire on the message channel rather than rAF, or a
    // hidden tab one-shots forever. The donor's law verbatim
    // (BeatSequencer.swift:4220-4225) — `currentStep >= target → stop()`, which
    // stops on ENTERING the final step of the cycle.
    const d = st.decks[deck];
    if (d && d.stopAtStep !== null && d.playing && pos.step >= d.stopAtStep) {
      useCompanion.setState((s) => patchDeck(s, deck, { stopAtStep: null }));
      useCompanion.getState().stop(deck);
    }
  }
  {
    const d = st.decks[deck];
    if (!d?.scheduledScene || d.switchBoundaryStep === null) return;
    if (pos.step < d.switchBoundaryStep - 1) return;
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
  // ⚠️ THE REPAINT IS THE CALLER'S (P3.5-E8g-d). This used to read "the grid repaints
  // via the panel's session-keyed reload effect" — the same indirect path the sample
  // doors had, and E8g-a is the row about what that costs: a door whose only route to
  // the screen is an effect in another component is indistinguishable from a dead
  // button whenever that effect does not fire. The store cannot push it itself (it
  // holds no link), so every registration site follows this with
  // `gridBackend.updatePatternRow(i, gridDocument(deck))` — the PATTERN-wire twin of
  // the `updateRuntime` launch and solo already do. Not `updateRuntime`, which is what
  // the row proposed: `locatorRepeatActive` is a `toGridPattern` field
  // (gridProjection.ts:181) and is absent from `toGridRuntime` entirely, so a runtime
  // push would repaint everything about the row EXCEPT the lamp that was clicked.
}

/**
 * The DOCUMENT the grid backend is currently showing: the ACTIVE SCENE's projection —
 * byte-for-byte what the bindings' reload effect feeds `GridBackend.load`
 * (CompanionPanel.tsx:80, useComposeBinding.ts:63, deckTile.tsx:113).
 *
 * Exported for P3.5-E8g-d so a door that edits the document can refresh the backend's
 * copy from its OWN handler instead of waiting for that effect. It must stay the scene
 * projection and never raw `session.pattern`: the grid shows and edits the ACTIVE
 * scene, so pushing sectionA while scene C is live would repaint the row with a
 * pattern the engine is not playing.
 */
export function gridDocument(deck = 0): Record<string, unknown> {
  const d = deckOf(useCompanion.getState(), deck);
  // No session ⇒ an empty document, so `docRows` finds no row and the republish is a
  // no-op. Same guard shape as `gridRuntimeInfos`/`gridPeakPaths`.
  if (!d.session) return {};
  return projectScene(d.session.pattern, d.scene) as unknown as Record<string, unknown>;
}

/**
 * The DOCUMENT'S IDENTITY for `GridBackend.load` — the same `session.name` the three
 * bindings pass (CompanionPanel.tsx:82, useComposeBinding.ts:65, deckTile.tsx:115).
 *
 * Exported for P3.5-E8g-h, which is the first door that changes the TOPOLOGY of the
 * document from its own handler: a new row cannot be published by `updateRuntime`
 * (it only walks rows the backend already has) nor by `updatePatternRow` (it refuses
 * an index past the end), so the door must call `load` — and calling `load` without
 * the id would send the cursor home to track 0 on every append, which is exactly the
 * defect E8g-e closed. `undefined` with no session open, which reads as a different
 * document, which is the right answer when there is nothing to keep a cursor into.
 */
export function gridDocumentId(deck = 0): string | undefined {
  return deckOf(useCompanion.getState(), deck).session?.name;
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
