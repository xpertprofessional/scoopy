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
  // The per-track armed cell-parameter lane (which lane a vertical value-drag /
  // ö-ä edits). RUNTIME UI state, not a pattern-wire field, so it has no home
  // in the document — the browser must remember it here or per-cell editing has
  // no idea which parameter to change. Defaults to "pitch", matching Swift's
  // Track.activeCellParameter default (an unarmed drag edits pitch).
  private activeParams: string[] = [];

  constructor(private hooks: GridBackendHooks) {}

  /**
   * Load a session's document. Projects every track and publishes all three topics, so a panel that
   * mounts after this — or calls `getUiState` on mount — gets a complete grid.
   */
  load(pattern: Record<string, unknown>, runtime: TrackRuntimeInfo[]): void {
    this.rows = docRows(pattern);
    this.runtime = runtime;
    this.bpm = typeof pattern.bpm === "number" ? pattern.bpm : 120;
    this.masterVolume = typeof pattern.masterVolume === "number" ? pattern.masterVolume : 1;
    this.masterDrive = typeof pattern.masterClipperDrive === "number" ? pattern.masterClipperDrive : 1;
    this.selected = 0;
    this.activeParams = []; // a fresh session arms the default lane (pitch)
    this.publishAll();
  }

  /** Reflect transport state into `gridMeta` (the playhead's on/off, not its position). */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.hooks.publish("gridMeta", this.meta());
  }

  /**
   * Runtime state changed under the same document (a launch toggle) — swap the infos and
   * republish every `gridRuntime/<i>` so the ▶/■ buttons repaint. Cheap: a handful of tracks,
   * human-rate clicks.
   */
  updateRuntime(runtime: TrackRuntimeInfo[]): void {
    this.runtime = runtime;
    this.rows.forEach((_, i) => this.publish(`gridRuntime/${i}`, this.runtimeState(i)));
  }

  /** No session open — an empty grid rather than a stale one. */
  clear(): void {
    this.rows = [];
    this.runtime = [];
    this.publish("gridMeta", this.meta());
  }

  private publishAll(): void {
    this.hooks.publish("gridMeta", this.meta());
    this.rows.forEach((_, i) => {
      this.hooks.publish(`gridPattern/${i}`, this.pattern(i));
      this.hooks.publish(`gridRuntime/${i}`, this.runtimeState(i));
    });
  }

  private publish(topic: string, state: unknown): void {
    this.hooks.publish(topic, state);
  }

  /** Deterministic pull — the panel calls `getUiState` on mount; re-run the provider. */
  republish(topic: string): void {
    if (topic === "gridMeta") return this.publish("gridMeta", this.meta());
    const m = topic.match(/^gridPattern\/(\d+)$/);
    if (m) return this.publish(topic, this.pattern(Number(m[1])));
    const r = topic.match(/^gridRuntime\/(\d+)$/);
    if (r) return this.publish(topic, this.runtimeState(Number(r[1])));
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
      keyboardActive: false,
      // The companion composes; perform mode is a studio DJ surface it has no
      // transport strip to toggle, so it stays off here.
      performActive: false,
      bpm: this.bpm,
      muteGroupActive: false,
      masterVolume: this.masterVolume,
      masterDrive: this.masterDrive,
      syncedBpm: null,
      // No deck behind the companion grid — and no focus ring (it never renders
      // beside sibling decks, so there is nothing to disambiguate). No deck also
      // means no master sends (the row hides the cluster on deckIndex null).
      deckIndex: null,
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
    this.publish(`gridRuntime/${i}`, this.runtimeState(i));
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
    this.publish("gridMeta", this.meta());
  }
}
