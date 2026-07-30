/**
 * THE GRID BACKEND — what makes `GridPanel` editable in the browser, unmodified.
 *
 * Under THE FLIP the grid is the OWNER of the pattern: it applies its own reducers and publishes the
 * result via `publishTrackPattern`, reading the document back over three topics — `gridMeta`,
 * `gridPattern/<i>`, `gridRuntime/<i>`. On the desktop Swift serves those and receives the publish
 * (`WebGridBinding`). There is no Swift in a browser, so this does both halves, over the document,
 * using the projection in `gridProjection.ts`.
 *
 * The panel does not learn it is talking to this instead of Swift — same three topics, same
 * `publishTrackPattern`, same `{applied,error}` reply. That is the whole `EngineLink` promise: a
 * panel cannot tell who is answering it.
 *
 * ⚠️ THE ROUND TRIP IS THE POINT, AND IT IS WHERE A COMPANION EARNS TRUST. The panel sends a whole
 * `GridPatternState` on every edit; this folds it back into the document (`applyGridPattern`), and
 * the document is what autosaves and exports. A field the writer dropped is an edit the user made,
 * saw, and lost on save — so the projection's write side is round-trip-tested (gridProjection.test).
 *
 * It owns NOTHING it can avoid owning: the document lives in the companion store, the engine is the
 * store's, the sample peaks come from the store's SampleStore. This is a translator, given callbacks.
 */
import type { GridMetaState, GridPatternState, GridRuntimeState } from "../../protocol/schema.ts";
import { applyGridPattern, docRows, toGridPattern, toGridRuntime, type DocRow } from "./gridProjection.ts";

/**
 * The topic family one backend serves (P3-D4-1). The compose grid reads
 * `gridMeta`/`gridPattern/<i>`/`gridRuntime/<i>`; `GridPanel@dj` reads
 * `djMeta/<d>`/`djPattern/<d>/<i>`/`djRuntime/<d>/<i>` — same shapes, different
 * addresses. Parameterizing the ADDRESS (not forking the backend) is what lets
 * the plane's deck tiles mount the real dj panel against the same document
 * machinery the composer already trusts.
 */
export interface GridTopicNames {
  meta: string;
  patternPrefix: string;
  runtimePrefix: string;
}

export const COMPOSE_TOPICS: GridTopicNames = {
  meta: "gridMeta",
  patternPrefix: "gridPattern/",
  runtimePrefix: "gridRuntime/",
};

/** The dj deck `deck`'s topic family — the exact strings `djSource(deck)` reads. */
export function djGridTopics(deck: number): GridTopicNames {
  return {
    meta: `djMeta/${deck}`,
    patternPrefix: `djPattern/${deck}/`,
    runtimePrefix: `djRuntime/${deck}/`,
  };
}

/**
 * Meta the DOCUMENT cannot supply — deck identity, keyboard arbitration, the
 * sync law's resolved tempo. Owned by whoever mounts the backend (the plane's
 * deck-tile binding); the compose defaults are the historical values.
 */
export interface GridMetaFacts {
  /** Which engine deck this grid IS — hides/shows the sends cluster and keys
      the focus ring. null = the compose grid's "no deck behind me". */
  deckIndex: number | null;
  /** EXACTLY ONE mounted dj panel may hold this, or every panel answers every
      arrow key (the D4-M arbitration note). Compose keeps false — its panel
      ignores meta keyboard state (no djSlotIndex). */
  keyboardActive: boolean;
  /** The sync law's resolved tempo, struck through over the session bpm when
      the deck is synced/nudged — null = free-running. */
  syncedBpm: number | null;
  /** PERF (DJ perform mode): a drag sets a track's locator window live instead
      of selecting cells. Mount-owned because the DECK ROW owns the toggle —
      the compose grid has no transport strip to put it on, which is why this
      was hardcoded false until B1 built one. */
  performActive: boolean;
}

/** What the engine/store must tell the grid about each track's loaded sample. */
export interface TrackRuntimeInfo {
  name: string;
  sampleKey: string | null;
  sampleDurationMs: number;
  samplePeakGain: number;
  /** The RUNTIME launch gate — the grid's ▶/■ reads this, not the document. */
  isStopped?: boolean;
  /** RUNTIME solo — lights the S button and the recede/halo language. */
  soloed?: boolean;
}

export interface GridBackendHooks {
  /** Publish a topic to the panel (`gridMeta`, `gridPattern/<i>`, `gridRuntime/<i>`). */
  publish(topic: string, state: unknown): void;
  /**
   * A track's pattern was edited. The store folds BOTH rows back into the document — `track` into
   * `sectionA[i]`, `settings` into `baseSettings.trackSettings[i]` (colour lands there, not on the
   * track) — re-publishes the world to the engine, and schedules an autosave. A throw becomes
   * `{applied:false}`, so an edit the document rejected is never shown as if it took.
   */
  onEdit(trackIndex: number, row: DocRow): void;
  /** Peak envelope for a track's sample — the cell waveforms. Empty arrays if none loaded. */
  peaks(trackIndex: number, points: number): Promise<{ minMax: number[]; rms: number[] }>;
}

export class GridBackend {
  private rows: DocRow[] = [];
  private runtime: TrackRuntimeInfo[] = [];
  private bpm = 120;
  // The document's master stage (P3-D4-1a). Was hardcoded 1/1 — the MasterRow
  // rendered a VOL/DRV the session never had, and its edits went nowhere. The
  // values now come from the loaded pattern (masterVolume / masterClipperDrive,
  // the same two fields the world publishes to the engine's per-deck master).
  private masterVolume = 1;
  private masterDrive = 1;
  private playing = false;
  private selected = 0;
  /**
   * WHICH DOCUMENT the rows currently came from (P3.5-E8g-e) — the caller's own
   * identity string, compared only for equality; this class never interprets it.
   * `undefined` means "the caller did not say", which is read as a different
   * document, so a caller that never passes one keeps the old reset-always
   * behaviour rather than silently inheriting a stale cursor.
   */
  private docId: string | undefined = undefined;
  // The per-track armed cell-parameter lane (which lane a vertical value-drag /
  // ö-ä edits). RUNTIME UI state, not a pattern-wire field, so it has no home
  // in the document — the browser must remember it here or per-cell editing has
  // no idea which parameter to change. Defaults to "pitch", matching Swift's
  // Track.activeCellParameter default (an unarmed drag edits pitch).
  private activeParams: string[] = [];
  private facts: GridMetaFacts = {
    deckIndex: null,
    keyboardActive: false,
    syncedBpm: null,
    performActive: false,
  };

  constructor(
    private hooks: GridBackendHooks,
    private topics: GridTopicNames = COMPOSE_TOPICS,
  ) {}

  /** Update the mount-owned meta facts and republish meta if anything moved. */
  setMetaFacts(facts: Partial<GridMetaFacts>): void {
    const next = { ...this.facts, ...facts };
    // ⚠️ EXHAUSTIVE BY CONSTRUCTION. This dedup used to name its three fields
    // one by one, which meant every field added to GridMetaFacts was silently
    // omitted from the comparison — a new fact would set `this.facts` and never
    // republish, so the control driving it would move and the grid would not.
    // `performActive` was the fourth and would have been the first to hit it.
    const keys = Object.keys(next) as (keyof GridMetaFacts)[];
    if (keys.every((k) => next[k] === this.facts[k])) return;
    this.facts = next;
    this.publish(this.topics.meta, this.meta());
  }

  /**
   * Load a session's document. Projects every track and publishes all three topics, so a panel that
   * mounts after this — or calls `getUiState` on mount — gets a complete grid.
   *
   * `docId` IDENTIFIES THE DOCUMENT, and it is what makes this safe to call on every edit
   * (P3.5-E8g-e). The bindings' reload effect is keyed on the session OBJECT, and every document
   * edit replaces that object — so this runs constantly, not just when a session opens. It used
   * to reset the cursor to track 0 unconditionally, which produced a defect nobody had reported
   * because nobody walks two doors in a row:
   *
   *   select track 5 → edit any cell → double-click a file in FILES → IT LANDS ON TRACK 1
   *
   * because `fileBrowser load` with no explicit `trackIndex` targets `grid.selectedIndex`
   * (browserLink.ts:392), and the cell edit had silently moved it home. The armed cell-parameter
   * lane was lost the same way, so every value-drag fell back to pitch after one edit.
   *
   * So the reset is now conditional on the document actually CHANGING. A genuinely new document
   * must still reset: a cursor pointing at "track 5" means nothing once track 5 is a different
   * track, and carrying it over would put the next dropped sample on a row the user never chose.
   * The caller passes `session.name`, which is the session's identity on disk (unique by
   * construction — `createSession` de-duplicates and `renameSession` refuses a collision). A SCENE
   * switch deliberately keeps the cursor: same document, same tracks, only the pattern-scoped
   * fields differ.
   */
  load(pattern: Record<string, unknown>, runtime: TrackRuntimeInfo[], docId?: string): void {
    // Compared BEFORE the rows are swapped, and `undefined !== undefined` is not the test — an
    // absent id must count as a different document in both directions, so a caller that never
    // opts in behaves exactly as it did before this parameter existed.
    const sameDocument = docId !== undefined && docId === this.docId;
    this.rows = docRows(pattern);
    this.runtime = runtime;
    this.docId = docId;
    this.bpm = typeof pattern.bpm === "number" ? pattern.bpm : 120;
    this.masterVolume = typeof pattern.masterVolume === "number" ? pattern.masterVolume : 1;
    this.masterDrive = typeof pattern.masterClipperDrive === "number" ? pattern.masterClipperDrive : 1;
    // Clamped even when the document is the same: an edit that DELETES tracks can leave the
    // cursor past the end, and a `selectedIndex` no row answers to is where a dropped sample
    // would vanish. `selectTrack` already refuses an out-of-range index; this is the same rule
    // applied to an index that was in range when it was set.
    this.selected = sameDocument ? Math.min(this.selected, Math.max(0, this.rows.length - 1)) : 0;
    // The armed lanes ride with the cursor for the same reason — they are per-track UI state
    // about the document that is open, not about the session file. A fresh session arms the
    // default lane (pitch).
    if (!sameDocument) this.activeParams = [];
    this.publishAll();
  }

  /** Reflect transport state into the meta topic (the playhead's on/off, not its position). */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.hooks.publish(this.topics.meta, this.meta());
  }

  /**
   * Runtime state changed under the same document (a launch toggle) — swap the infos and
   * republish every `gridRuntime/<i>` so the ▶/■ buttons repaint. Cheap: a handful of tracks,
   * human-rate clicks.
   */
  updateRuntime(runtime: TrackRuntimeInfo[]): void {
    this.runtime = runtime;
    this.rows.forEach((_, i) =>
      this.publish(`${this.topics.runtimePrefix}${i}`, this.runtimeState(i)),
    );
  }

  /**
   * P3.5-E8g-d — ONE TRACK'S **DOCUMENT** ROW CHANGED, UNDER THE SAME SESSION.
   *
   * The pattern-wire sibling of `updateRuntime`, and it had no equivalent: the
   * only way a document edit made OUTSIDE this backend could reach the panel was
   * `load()`, i.e. the binding's session-keyed reload effect. That is the exact
   * dependency P3.5-E8g-a removed from the sample doors — except a sample lands
   * on the RUNTIME wire, so `updateRuntime` sufficed there. `locatorRepeatActive`
   * is a `toGridPattern` field (gridProjection.ts:181) and appears **nowhere** in
   * `toGridRuntime`, so a runtime push cannot repaint it. Hence this.
   *
   * Takes the whole (scene-projected) document rather than a `DocRow`, because
   * `docRows` is the one place that knows a row is `sectionA[i]` PAIRED WITH
   * `baseSettings.trackSettings[i]` — a caller assembling that pair by hand is
   * the drift `docRows` exists to prevent.
   *
   * ⚠️ IT DELIBERATELY DOES NOT RESET THE CURSOR. `load()` sets `selected = 0`
   * and clears the armed lanes, which is right for a NEW document and wrong for
   * an edit to the open one — a repaint that moves the user's selection is its
   * own defect (P3.5-E8g-e). Republishing one topic is also why an edit on track
   * 3 cannot disturb a drag in flight on track 5.
   */
  updatePatternRow(trackIndex: number, pattern: Record<string, unknown>): void {
    const row = docRows(pattern)[trackIndex];
    // No such track (no session, or an index past the document) ⇒ nothing to
    // repaint. Guarded rather than assumed: publishing `toGridPattern` of an
    // absent row would push a default pattern over a real one.
    if (!row) return;
    this.rows[trackIndex] = row;
    this.publish(`${this.topics.patternPrefix}${trackIndex}`, this.pattern(trackIndex));
  }

  /** No session open — an empty grid rather than a stale one. */
  clear(): void {
    this.rows = [];
    this.runtime = [];
    this.publish(this.topics.meta, this.meta());
  }

  private publishAll(): void {
    this.hooks.publish(this.topics.meta, this.meta());
    this.rows.forEach((_, i) => {
      this.hooks.publish(`${this.topics.patternPrefix}${i}`, this.pattern(i));
      this.hooks.publish(`${this.topics.runtimePrefix}${i}`, this.runtimeState(i));
    });
  }

  private publish(topic: string, state: unknown): void {
    this.hooks.publish(topic, state);
  }

  /** Deterministic pull — the panel calls `getUiState` on mount; re-run the provider. */
  republish(topic: string): void {
    if (topic === this.topics.meta) return this.publish(topic, this.meta());
    const index = (prefix: string): number | null => {
      if (!topic.startsWith(prefix)) return null;
      const n = Number(topic.slice(prefix.length));
      return Number.isInteger(n) && n >= 0 ? n : null;
    };
    const p = index(this.topics.patternPrefix);
    if (p !== null) return this.publish(topic, this.pattern(p));
    const r = index(this.topics.runtimePrefix);
    if (r !== null) return this.publish(topic, this.runtimeState(r));
  }

  private meta(): GridMetaState {
    return {
      trackCount: this.rows.length,
      horizontalZoom: 16,
      displayMode: "split",
      isPlaying: this.playing,
      activeCellParameterName: "",
      selectedTrackIndex: this.selected,
      selectedTrackIndices: [],
      // ⚠️ THE LOAD-BEARING FIELD. false would put the grid in intent mode — it would fire
      // gridEdit/trackEdit and wait for Swift to echo a result that never comes, and every edit
      // would appear to do nothing. true = the grid applies its own reducers and publishes, which
      // is the only mode that can work with no Swift behind it.
      ownerPatterns: true,
      noteKeyboardActive: false,
      keyboardActive: this.facts.keyboardActive,
      // Mount-owned since B1: the compose grid has no transport strip to toggle
      // it (so it stays false there, as it always has), but an expanded deck
      // tile now HAS one — the deck view row.
      performActive: this.facts.performActive,
      bpm: this.bpm,
      muteGroupActive: false,
      masterVolume: this.masterVolume,
      masterDrive: this.masterDrive,
      // Mount-owned facts (P3-D4-1): the compose defaults are the historical
      // values (no deck, no keyboard claim, free-running); a deck tile's
      // binding sets its own. masterSends stays [] on every host — the merged
      // dispatch answers returnFx:false, and an empty array is how the row
      // hides the cluster honestly.
      syncedBpm: this.facts.syncedBpm,
      deckIndex: this.facts.deckIndex,
      masterSends: [],
    } as GridMetaState;
  }

  private pattern(i: number): GridPatternState {
    return toGridPattern(this.rows[i]!);
  }

  private runtimeState(i: number): GridRuntimeState {
    const info = this.runtime[i] ?? {
      name: `Track ${i + 1}`,
      sampleKey: null,
      sampleDurationMs: 0,
      samplePeakGain: 1,
    };
    // Carry the armed lane (toGridRuntime can't know it — it's not in the doc).
    return { ...toGridRuntime(info), activeCellParameterName: this.activeParams[i] ?? "pitch" };
  }

  /** Arm the cell-parameter lane a value-drag/ö-ä edits, and republish so the
   *  chip lights and the editor knows which parameter to change. Mirrors the
   *  desktop `setActiveCellParameter` trackEdit, which the browser otherwise
   *  drops (the field is not on the pattern wire). */
  setActiveCellParameter(i: number, mode: string): void {
    if (i < 0) return;
    this.activeParams[i] = mode;
    this.publish(`${this.topics.runtimePrefix}${i}`, this.runtimeState(i));
  }

  /**
   * The write path. The panel hands back a whole `GridPatternState`; fold it into the document and
   * tell the store. Returns the same `{applied,error}` Swift does — a refusal must never be silent,
   * because the grid would then be showing an edit the engine never heard.
   */
  handlePublish(params: { trackIndex: number; json: string }): { applied: boolean; error: string | null } {
    const i = params.trackIndex;
    const row = this.rows[i];
    if (!row) return { applied: false, error: `no track ${i}` };

    try {
      const state = JSON.parse(params.json) as GridPatternState;
      const next = applyGridPattern(state, row);
      this.rows[i] = next;
      // The store owns the document — hand it BOTH merged rows so the world re-publishes and the
      // session autosaves. If that throws, the edit did NOT take, and we say so.
      this.hooks.onEdit(i, next);
      return { applied: true, error: null };
    } catch (err) {
      return { applied: false, error: (err as Error).message };
    }
  }

  /**
   * `getSamplePeaks` — the cell waveforms. Mirrors Swift's result shape
   * EXACTLY (the schema result is `.strict()` and panels parse with the
   * throwing `.parse`): sampleKey, minMax, rms, brightness, durationMs —
   * nothing more. No spectrum colour in the browser (no per-column FFT),
   * so `brightness` stays empty; a failure degrades to the empty shape.
   */
  async samplePeaks(params: {
    trackIndex: number;
    points: number;
  }): Promise<{
    sampleKey: string | null;
    minMax: number[];
    rms: number[];
    brightness: number[];
    durationMs: number;
  }> {
    const i = params.trackIndex;
    try {
      const { minMax, rms } = await this.hooks.peaks(i, params.points);
      return {
        // ⚠️ REQUIRED, not decoration: the grid's fetcher discards any reply whose sampleKey is
        // missing (strict parse) or null (no sample to cache under) — omitting this field is how
        // the companion shipped hollow cells.
        sampleKey: this.runtime[i]?.sampleKey ?? null,
        minMax,
        rms,
        brightness: [],
        durationMs: this.runtime[i]?.sampleDurationMs ?? 0,
      };
    } catch {
      return {
        sampleKey: null,
        minMax: [],
        rms: [],
        brightness: [],
        durationMs: 0,
      };
    }
  }

  /** The grid cursor's row — where a `fileBrowser load` without an explicit destination lands. */
  get selectedIndex(): number {
    return this.selected;
  }

  /** A cursor move (`gridEdit selectTrack`) — the only intent the grid still fires in owner mode. */
  selectTrack(index: number): void {
    if (index < 0 || index >= this.rows.length) return;
    this.selected = index;
    this.publish(this.topics.meta, this.meta());
  }
}
