import { useEffect, useRef, useState } from "react";
import {
  DjUiState,
  HotFrameLayout,
  ToolbarUiState,
  type DeckSectionState,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, GeoRange, Select } from "../design/controls.tsx";
import { DragBox } from "../design/DragBox.tsx";
import { semanticColor } from "../design/tokens.ts";
import { NudgeBox } from "./NudgeBox.tsx";
import { ScenePads } from "./ScenePads.tsx";
import { attachScenes } from "../state/scenesStore.ts";
import { deckInSlot, toggleProjection, type Slot } from "./djProjection.ts";
import { WaitingForState } from "./WaitingForState.tsx";
import { attachMenuBridge } from "../commands/menuBridge.ts";
import "./deckmixer.css";

/**
 * Transport row — mirrors the native structure (GlobalToolbarView
 * DeckSectionView): each deck is a bordered block of stacked control
 * rows plus a full-width LCM bar, side by side after the DJ master block.
 *   row 1: select · C · GRID | open · transport · nudge | dbl · eject | save · name
 *   row 2: SYNC‹pulse› · TR‹±n› · WIN · BR‹›
 *   row 3: scene pads
 *   row 4: LCM progress (full width, hot canvas)
 * Text labels only — no emoji (design language).
 *
 * In DJ mode the blocks are SLOT-keyed (two of them, flipping with the deck-C
 * projection) so each sits column-aligned above the DJ deck window it drives
 * (djmode.md §7 item 12); in compose they are deck-keyed (2–3) so every deck
 * stays selectable. C and GRID moved here from the deleted DJ deck header
 * (2026-07-14) — their state is Swift-owned (DJModeManager) because this strip
 * and the deck windows are different WKWebViews.
 */

const DECK_NAMES = ["A", "B", "C"] as const;
const WIN_NODES_MS = [25, 60, 120, 240, 480, 960];

function winMs(texture: number): number {
  const t = Math.min(Math.max(texture, 0), 1) * (WIN_NODES_MS.length - 1);
  const i = Math.min(Math.floor(t), WIN_NODES_MS.length - 2);
  const lo = WIN_NODES_MS[i]!;
  const hi = WIN_NODES_MS[i + 1]!;
  return lo * Math.pow(hi / lo, t - i);
}

/**
 * The beat-repeat length readout — ONE fused scale, two notations.
 *
 * `nudgeBeatRepeatScale` walks 16…2, 1, then 1/2…1/32, where the tail is a re-triggering roll:
 * length pins to 1 and the SUBDIVISION carries the value (BeatSequencer:19436). So the number on
 * screen comes from whichever half of the scale is live — read `beatRepeatLength` alone and the
 * six micro settings all render "1", which is why the subdivision had to join the wire.
 */
export function beatRepeatLabel(s: {
  beatRepeatLength: number;
  beatRepeatSubdivision: number;
}): string {
  return s.beatRepeatSubdivision > 1 ? `1/${s.beatRepeatSubdivision}` : `${s.beatRepeatLength}`;
}

export function TransportPanel({ link }: { link: EngineLink | null }) {
  const [state, setState] = useState<ToolbarUiState | null>(null);
  // The `dj` topic is read by BOTH the master box (tempo mode, quantize) and
  // every deck box (dry-mute), so it is subscribed ONCE here and passed down.
  const [dj, setDj] = useState<DjUiState | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  // MB-4: THIS page hosts the registry's Transport + DJ sections — it owns the
  // state their labels read (per-deck isPlaying, djModeEnabled, the editing
  // deck), which the grid host cannot honestly evaluate (its meta.isPlaying is
  // ITS deck's — wrong for the menu label the moment DJ view is up). The
  // Play/Pause label follows the single-space rule's target: DJ mode = the
  // global toolbar transport, compose = the editing deck.
  const menuIsPlaying = state
    ? state.djModeEnabled
      ? state.masterIsPlaying
      : state.deckPlaying[state.editingDeckIndex ?? 0] ?? false
    : false;
  const menuStateRef = useRef<() => import("../commands/registry.ts").CommandState>(
    () => {
      throw new Error("menu state read before first render");
    },
  );
  menuStateRef.current = () => ({
    // Edit/Track/Pattern are the GRID host's sections — inert here.
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    isPlaying: menuIsPlaying,
    djMode: state?.djModeEnabled ?? false,
    isBouncing: state?.activeIsBouncing ?? false,
    isOutputRecording: state?.activeIsOutputRecording ?? false,
    sessionNew: () => void link?.command("menuSession", { op: "new" }).catch(() => {}),
    sessionSave: () => void link?.command("menuSession", { op: "save" }).catch(() => {}),
    sessionSaveAs: () => void link?.command("menuSession", { op: "saveAs" }).catch(() => {}),
    sessionLoad: () => void link?.command("menuSession", { op: "load" }).catch(() => {}),
    sessionExportZip: () =>
      void link?.command("menuSession", { op: "exportZip" }).catch(() => {}),
    sessionBounceToggle: () =>
      void link?.command("menuSession", { op: "bounceToggle" }).catch(() => {}),
    performUndo: () => {},
    transportPlay: () => void link?.command("menuTransport", { op: "play" }).catch(() => {}),
    transportStop: () => void link?.command("menuTransport", { op: "stop" }).catch(() => {}),
    transportRestart: () =>
      void link?.command("menuTransport", { op: "restart" }).catch(() => {}),
    addTrack: () => {},
    requestClearAll: () => {},
    toggleDjMode: () => void link?.command("toggleDjMode", {}).catch(() => {}),
  });
  const menuBridgeRef = useRef<import("../commands/menuBridge.ts").MenuBridge | null>(null);
  useEffect(() => {
    if (!link) return;
    const bridge = attachMenuBridge(link, {
      // Session too: its four lifecycle items are stateless labels, and THIS
      // link carries the toolbar's active-sequencer resolver the Swift
      // handler targets (menuSession, v78).
      state: () => menuStateRef.current(),
      sections: ["Session", "Transport", "DJ"],
    });
    menuBridgeRef.current = bridge;
    return () => {
      menuBridgeRef.current = null;
      bridge.detach();
    };
  }, [link]);
  useEffect(() => {
    menuBridgeRef.current?.publish();
  }, [
    menuIsPlaying,
    state?.djModeEnabled,
    state?.activeIsBouncing,
    state?.activeIsOutputRecording,
  ]);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("toolbar", (raw) => {
      const parsed = ToolbarUiState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    const offDj = link.onUiState("dj", (raw) => {
      const parsed = DjUiState.safeParse(raw);
      if (parsed.success) setDj(parsed.data);
    });
    link.command("getUiState", { topic: "toolbar" }).catch(() => {});
    link.command("getUiState", { topic: "dj" }).catch(() => {});
    // Scene snapshots live in each deck's box (below), so this link owns the
    // `scenes/<d>` topics. Every panel is its own WKWebView — a subscription in
    // another page cannot serve this one.
    const offScenes = attachScenes(link);
    return () => {
      off();
      offDj();
      offScenes();
    };
  }, [link]);

  // The host frame cannot know our row count (scene pads added one; the
  // bar-height token rescales them all), and anything taller than the frame is
  // CLIPPED with no error. Measure the real content and let the host follow.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !link) return;
    let last = 0;
    const report = () => {
      const h = Math.ceil(el.scrollHeight);
      if (h > 0 && h !== last) {
        last = h;
        link.command("setPanelHeight", { heightPx: h }).catch(() => {});
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [link, state]);

  if (!state) {
    return <WaitingForState topics={["toolbar"]} className="deckmixer mono dim" />;
  }

  const setTempo = (v: number) => {
    const clamped = Math.min(Math.max(v, 0), 300);
    setState({ ...state, masterTempo: clamped });
    link?.paramWrite("masterTempo", clamped);
  };

  const deckCount = state.deckCEnabled ? 3 : 2;

  // Deck-C projection + per-deck DJ-grid collapse — Swift-owned shared state
  // (DJModeManager, revised 2026-07-14): the flip/GRID buttons live HERE while
  // the deck windows live in the djmode webview, so both read the `dj` topic.
  // `dj` can be null for a beat at first paint — default to no projection /
  // nothing hidden, which renders plain A/B correctly until the first push.
  const projection: Slot | null =
    dj?.deckCProjectedSlot === "a" || dj?.deckCProjectedSlot === "b"
      ? dj.deckCProjectedSlot
      : null;
  const gridHidden = dj?.gridHidden ?? [];
  const performMode = dj?.performMode ?? [];

  const setting = (op: string, value: string, deck?: number) =>
    link
      ?.command("djSetting", { op, value, ...(deck === undefined ? {} : { deck }) })
      .catch((err) => console.error("djSetting failed:", err));

  const deckBlock = (d: number, slot?: Slot) => (
    <DeckBlock
      // Keyed by DECK, not slot: a projection flip then REMOUNTS the block, so
      // LcmBar's [link, deck] effect, NudgeBox and the ScenePads store binding
      // all rebind cleanly instead of straddling a deck change.
      key={`d${d}`}
      link={link}
      deck={d}
      name={DECK_NAMES[d]!}
      section={state.deckSections[d]}
      playing={state.deckPlaying[d] ?? false}
      pending={state.deckQuantizePending[d] ?? false}
      // Which deck the compose grid below is showing. Without this the
      // selector had no lit state, so clicking a deck read as a dead
      // button even once the grid started following it.
      editing={state.editingDeckIndex === d}
      // The C flip (DJ mode only): this slot's block and the DJ deck window
      // below it swap to deck C together — one shared projection.
      projected={d === 2}
      canProject={slot !== undefined && state.deckCEnabled}
      onProject={() =>
        slot && setting("deckCProjection", toggleProjection(projection, slot) ?? "none")
      }
      gridHidden={gridHidden[d] ?? false}
      onToggleGrid={() => setting("gridHidden", gridHidden[d] ? "off" : "on", d)}
      performOn={performMode[d] ?? false}
      onTogglePerform={() => setting("performMode", performMode[d] ? "off" : "on", d)}
      onTexture={(v) =>
        setState((s) =>
          s
            ? {
                ...s,
                deckSections: s.deckSections.map((sec, i) =>
                  i === d ? { ...sec, texture: v } : sec,
                ),
              }
            : s,
        )
      }
    />
  );

  return (
    <main className="transport-strip" ref={rootRef}>
      {/* P6-07 — DJ MASTER BOX: horizontal, spanning the full width ABOVE the
          deck boxes. Everything GLOBAL to the set lives here exactly once
          (djmode.md §4C): the view toggle, global transport, the master tempo,
          how synced decks follow it, the launch quantize, and the glide time.
          Lifting it out of the deck strip is what lets the deck boxes below
          column-ALIGN with the DJ view's deck columns. */}
      <DjMasterBox link={link} state={state} dj={dj} setTempo={setTempo} />

      {/* DJ mode: TWO slot-keyed blocks that flip with the C projection, so
          each box always sits column-aligned above the DJ deck window it
          drives (djmode.md §7 item 12) — including through a projection.
          Compose: one block per deck (2–3), so every deck stays selectable
          as the compose edit target. */}
      <div className="deck-blocks">
        {state.djModeEnabled
          ? (["a", "b"] as const).map((s) =>
              deckBlock(deckInSlot(s, projection, state.deckCEnabled), s),
            )
          : DECK_NAMES.slice(0, deckCount).map((_, d) => deckBlock(d))}
      </div>
    </main>
  );
}

/**
 * The DJ master box (P6-07). ONE home for every global performance control —
 * see the ownership map in panels/djmode.md §4C. Horizontal by design: it used
 * to be a deck-width column in the deck strip, which starved the deck boxes and
 * made it impossible to align them with the DJ view's deck columns.
 *
 * Two controls MOVED here rather than being re-drawn:
 *  · launch quantize — was the Tools row's `Q:` button, which cycled
 *    `globalLaunchQuantize` through `toolbarTool.cycleQuantize` while the DJ
 *    view's picker wrote the SAME state through `djSetting`. Two controls, one
 *    value. Unified on `djSetting.launchQuantize` (the cycler is gone).
 *  · RAMP — the master-tempo ramp time (native GlobalToolbarView:602).
 *
 * On RAMP (user, 2026-07-13). This box used to be GLIDE: one shared number that
 * drove the motorized tempo ramp AND the ⌥-click morph on every geo slider. The
 * morph is NOT migrated and will not be — it never gave the results we wanted,
 * and per-cell glide has its own parameter anyway. What survives is the platter
 * ramp, which is worth keeping on its own terms: ramp the tempo to 0 with a long
 * RAMP and the decks tape-stop like a turntable powering off.
 *
 * So the number got its own home (DJModeManager.masterTempoRampSeconds) and sits
 * next to the tempo it belongs to. 0 = OFF (snap). Stored in UserDefaults and read
 * LIVE by Swift each ramp tick, so it rides the generic settings channel — no
 * schema change, and a write takes effect mid-ramp.
 */
const RAMP_KEY = "djMode.masterTempoRampSeconds";
const RAMP_MS_MIN = 0; // 0 = no ramp. DJModeManager.masterTempoRampRange 0…5 s
const RAMP_MS_MAX = 5000;
const RAMP_MS_DEFAULT = 300; // DJModeManager.masterTempoRampDefault 0.30 s

const TEMPO_MODES = [
  { value: "timePitch", label: "TP" },
  { value: "timeStretch", label: "TS" },
  { value: "tempoOnly", label: "TEMPO" },
];
const QUANTIZE = ["off", "1", "2", "4", "8", "16", "cycle"];

function DjMasterBox({
  link,
  state,
  dj,
  setTempo,
}: {
  link: EngineLink | null;
  state: ToolbarUiState;
  dj: DjUiState | null;
  setTempo: (v: number) => void;
}) {
  const [rampMs, setRampMs] = useState(RAMP_MS_DEFAULT);

  useEffect(() => {
    if (!link) return;
    link
      .command("getSetting", { key: RAMP_KEY })
      .then((raw) => {
        const v = (raw as { value?: unknown } | null)?.value;
        // `>= 0`, not `> 0`: 0 is a real, meaningful value here (ramp OFF), and
        // testing truthiness would silently snap a saved OFF back to the default.
        if (typeof v === "number" && v >= 0) setRampMs(Math.round(v * 1000));
      })
      .catch(() => {});
  }, [link]);

  const setting = (op: string, value: string) =>
    link?.command("djSetting", { op, value }).catch((err) => console.error("djSetting failed:", err));

  const writeRamp = (ms: number) => {
    const clamped = Math.min(Math.max(Math.round(ms), RAMP_MS_MIN), RAMP_MS_MAX);
    setRampMs(clamped);
    // Swift reads this key live (DJModeManager.preferredMasterTempoRamp) — seconds.
    link?.command("setSetting", { key: RAMP_KEY, value: clamped / 1000 }).catch(() => {});
  };

  return (
    <section className="dj-master-box">
      <Button
        label="DJ"
        hot
        active={state.djModeEnabled}
        onClick={() => link?.command("toggleDjMode", {}).catch(() => {})}
      />
      <button
        className="ds-button ds-hot"
        title="stop · ⌥ = restart playing decks from step 0"
        onClick={(e) =>
          link?.command(e.altKey ? "transportGlobalRestart" : "transportGlobalStop", {})
            .catch(() => {})
        }
      >
        ■
      </button>
      <Button
        label="▶"
        hot
        active={state.masterIsPlaying}
        onClick={() => link?.command("transportGlobalPlay", {}).catch(() => {})}
      />

      <span className="vsep" />

      {/* Master tempo — the sync system's reference. */}
      <span className="dmb-label mono dim">MASTER</span>
      <Button label="−" hot onClick={() => setTempo(state.masterTempo - 1)} />
      <DragBox
        id="transport/bpm"
        value={state.masterTempo}
        display={state.masterTempo.toFixed(state.masterTempo % 1 ? 2 : 0)}
        min={0}
        max={300}
        step={1}
        defaultValue={120}
        onChange={setTempo}
        // The DJ master tempo is its own learn target natively
        // (GlobalToolbarView :762) — NOT the session's `master_bpm`, which is
        // the per-deck value on the master row. Same id, so a CC learned in
        // SwiftUI drives this box (CM-6).
        learn={{ kind: "singleton", learnId: "dj_master_tempo" }}
      />
      <Button label="+" hot onClick={() => setTempo(state.masterTempo + 1)} />
      <GeoRange
        label="TEMPO"
        hot
        value={state.masterTempo}
        min={0}
        max={300}
        step={0.01}
        onChange={setTempo}
      />

      {/* RAMP — how long the platter takes to REACH a new tempo. Lives beside the
          tempo because it belongs to it: at 0 BPM a long ramp is the turntable
          power-off (TP tape-stops via varispeed → 0; TS freezes). OFF = snap. */}
      <span className="dmb-label mono dim">RAMP</span>
      <DragBox
        id="transport/ramp"
        value={rampMs}
        display={rampMs <= 0 ? "OFF" : `${rampMs}ms`}
        min={RAMP_MS_MIN}
        max={RAMP_MS_MAX}
        step={10}
        defaultValue={RAMP_MS_DEFAULT}
        onChange={writeRamp}
      />

      <span className="vsep" />

      {/* How a SYNCED deck follows that tempo (TP varispeed / TS pitch-locked /
          TEMPO = step clock only). The sync system answers all BPM questions. */}
      <span className="dmb-label mono dim">MODE</span>
      <Select
        value={dj?.tempoMode ?? "timePitch"}
        options={TEMPO_MODES}
        onChange={(v) => setting("tempoMode", v)}
      />

      {/* Launch quantize — one control now (was Tools `Q:` + the DJ picker). */}
      <span className="dmb-label mono dim">QUANT</span>
      <Select
        value={dj?.launchQuantize ?? "cycle"}
        options={QUANTIZE.map((q) => ({ value: q, label: q.toUpperCase() }))}
        onChange={(v) => setting("launchQuantize", v)}
      />

      {/* NK-3 — THE NOTE KEYBOARD. `toolbar.md:37` parked these controls as
          "still unmigrated, and now homeless" when TB-1 deleted the tools row;
          this is the re-home. They belong in the MASTER box, not a deck box,
          because there is exactly one keyboard and exactly one pin for the whole
          set — the pin's entire purpose is to outlive the deck you are looking
          at, so homing it per-deck would contradict it. */}
      <span className="vsep" />
      <NoteKeyboardCluster link={link} state={state} />
    </section>
  );
}

/**
 * NK-3: Musical Keyboard Mode + the MIDI input pin.
 *
 * There is no on-screen piano in this app and never was — the mode REMAPS the
 * computer keyboard into a piano layout (A W S E D F… = C C# D D#…) and plays
 * one track at pitch. So the surface is a toggle and two steppers, not a keybed:
 * the keys are already under your fingers.
 *
 * TARGET is the honest part. Note input routes via the PIN and only the pin
 * (which survives a deck switch — that is the point). The old "else the
 * selected track" fallback is gone: it re-routed the keyboard on every cursor
 * move, invisibly. Unpinned = silent, and the readout says "no target".
 */
function NoteKeyboardCluster({
  link,
  state,
}: {
  link: EngineLink | null;
  state: ToolbarUiState;
}) {
  const kbd = state.musicalKeyboard;
  const pin = state.midiPin;
  const op = (o: string) => link?.command("musicalKeyboard", { op: o }).catch(() => {});
  const octave = `${kbd.octaveOffset > 0 ? "+" : ""}${kbd.octaveOffset}`;

  return (
    <>
      {/* Text label, not a piano glyph: it sits in the same row as DJ / SYNC / TR,
          which are all mono caps. (Native uses the `pianokeys` SF Symbol, but an
          SF Symbol is not an emoji — dropping one into the web row would be the
          only pictograph on the strip.) */}
      <Button
        label="KEYS"
        hot
        active={kbd.enabled}
        title="Musical Keyboard Mode (⌘K) — the computer keyboard becomes a piano (A W S E D F… = C C# D D#…), playing whatever TARGET names. Silent until a track is pinned with IN. While it is on, Q W E R T Z U I stop being finger-drum pads."
        onClick={() => op("toggle")}
      />
      {kbd.enabled && (
        <>
          <span className="dmb-label mono dim">OCT</span>
          <Button label="−" onClick={() => op("octaveDown")} />
          <span className="ds-value mono">{octave}</span>
          <Button label="+" onClick={() => op("octaveUp")} />

          <span className="dmb-label mono dim">VEL</span>
          <Button label="−" onClick={() => op("velocityDown")} />
          <span className="ds-value mono">{kbd.velocity}</span>
          <Button label="+" onClick={() => op("velocityUp")} />
        </>
      )}
      {/* Shown whether or not the mode is on: a MIDI keyboard plays the pin too,
          and the pin is the answer to "why is nothing sounding?" */}
      <span className="dmb-label mono dim">TARGET</span>
      <span
        className={`ds-value note-target${pin ? " pinned" : ""}`}
        title={
          pin
            ? `Locked: track ${pin.trackIndex + 1} on deck ${"ABC"[pin.deck] ?? "?"} — it keeps answering the keys while you work another deck. Release it with IN on the track row.`
            : "No note target — external MIDI and the ⌘K keyboard are silent. Press IN on a track row to lock note input to it."
        }
      >
        {/* Locked = the track's NAME, in --signal. Unpinned = "no target",
            dimmed. The two states never render the same shape, so the readout
            needs no badge or icon to tell them apart. */}
        {pin ? pin.name : "no target"}
      </span>
    </>
  );
}

function DeckBlock(props: {
  link: EngineLink | null;
  deck: number;
  name: string;
  section: DeckSectionState | undefined;
  playing: boolean;
  pending: boolean;
  editing: boolean;
  /** This block shows deck C via the projection (identity cue on the letter). */
  projected: boolean;
  /** DJ mode + deck C enabled: show the C flip button for this SLOT. */
  canProject: boolean;
  onProject: () => void;
  gridHidden: boolean;
  onToggleGrid: () => void;
  performOn: boolean;
  onTogglePerform: () => void;
  onTexture: (v: number) => void;
}) {
  const { link, deck, section } = props;
  if (!section) return null;
  const op = (o: string) => link?.command("deckSection", { deck, op: o }).catch(() => {});
  const transport = (o: string, alt = false) =>
    link?.command("transportDeck", { deck, op: alt ? "playOnce" : o }).catch(() => {});

  return (
    <section
      // `.editing` rings the WHOLE block in the deck's identity color — the
      // compose-focus cue, now that the DJ deck header (the letter badge) is
      // gone. editingDeckIndex is nil in DJ mode, so the ring is compose-only.
      className={`deck-block sem${props.editing ? " editing" : ""}`}
      style={{ "--sem-color": semanticColor("deck", deck) } as React.CSSProperties}
    >
      {/* Row 1 — transport + file */}
      <div className="block-row">
        <button
          className={`ds-button ds-hot deck-select${props.editing ? " editing" : ""}`}
          title={`Edit deck ${props.name} in the compose view`}
          onClick={() => op("select")}
        >
          {props.name}
        </button>
        {/* The C projection flip (moved here from the DJ deck header, 2026-07-14):
            flipping projects deck C into THIS slot — the box and the deck window
            below it swap to C together, both wearing C's identity color. */}
        {props.canProject && (
          <Button
            label={props.projected ? "C ▸ ON" : "C"}
            active={props.projected}
            title="Project deck C into this slot (the deck window below follows)"
            onClick={props.onProject}
          />
        )}
        {/* GRID + PERF moved to the scene row's right-bound tools cluster
            (2026-07-16) — this transport row was overloaded. */}
        <span className="vsep" />
        <Button label="OPEN" onClick={() => op("open")} />
        <button className="ds-button ds-hot" title="stop" onClick={() => transport("stop")}>■</button>
        <button
          className={`ds-button ds-hot${props.pending ? " pending" : props.playing ? " active" : ""}`}
          title="play · ⌥ = play once"
          onClick={(e) => transport("play", e.altKey)}
        >
          ▶
        </button>
        <button className="ds-button" title="skip step" onClick={() => transport("skipStep")}>»</button>
        {/* REV: global "session plays backwards" toggle. Whole session reverses — step order
            mirrors and every sample plays backwards (true tape reverse), non-destructive to each
            track's own direction. DJ view also drives this via Q (deck A) / A (deck B). */}
        <Button
          label="REV"
          active={section.reverseActive}
          title="Play the whole session backwards (DJ: Q = deck A, A = deck B)"
          onClick={() => op("toggleReverse")}
        />
        {/* NUDGE (P6-09): a transport/sync gesture, so it lives here beside the
            deck's transport — not in the DJ view, where it was a second copy. */}
        <NudgeBox link={link} deck={deck} />
        <span className="vsep" />
        <Button label="DBL" onClick={() => op("double")} />
        <Button label="EJECT" onClick={() => op("eject")} />
        <span className="vsep" />
        <Button label="SAVE" onClick={() => op("quickSave")} />
        <span className="ds-value dim session-name" title={section.sessionName}>
          {section.sessionName}
        </span>
      </div>

      {/* Row 2 — performance */}
      <div className="block-row">
        <Button label="SYNC" hot active={section.syncEnabled} onClick={() => op("toggleSync")} />
        <button className="ds-button ds-hot chev" onClick={() => op("pulsePrev")}>‹</button>
        <span className="ds-value pulse">{section.pulse}</span>
        <button className="ds-button ds-hot chev" onClick={() => op("pulseNext")}>›</button>
        <span className="vsep" />
        <Button label="TR" active={section.transposeEnabled} onClick={() => op("toggleTranspose")} />
        <button className="ds-button chev" onClick={() => op("trDown")}>‹</button>
        <span className="ds-value tr">
          {section.transposeSemitones >= 0 ? "+" : ""}
          {Math.round(section.transposeSemitones)}
        </span>
        <button className="ds-button chev" onClick={() => op("trUp")}>›</button>
        <span className="vsep" />
        <GeoRange
          label="WIN"
          display={`≈${winMs(section.texture).toFixed(0)}ms`}
          value={section.texture}
          min={0}
          max={1}
          step={0.001}
          onChange={(v) => {
            props.onTexture(v);
            link?.paramWrite("deckBusTexture", v, deck);
          }}
        />
        <span className="vsep" />
        {/* BR is a live playback-only effect — the engine can only loop a MOVING playhead, so
            toggling it while the deck is stopped is a no-op with no possible UI feedback. Disable
            the whole cluster (toggle + length + shift) while stopped so it reads as unavailable
            instead of a dead click. `playing` = state.deckPlaying[d]. */}
        <Button
          label="BR"
          active={section.beatRepeatActive}
          disabled={!props.playing}
          onClick={() => op("toggleBeatRepeat")}
        />
        {/* LENGTH — ‹ N › walks the one fused scale (16…1 │ 1/2…1/32); ‹ zooms finer, › coarser.
            While PLAYING it stays enabled even with BR off (dial the length, THEN engage), exactly
            like native; it is only greyed while the deck is stopped. The `brFiner`/`brCoarser` ops
            existed on the wire from the start — this cluster is what was missing, so the scale's
            whole micro half was unreachable. */}
        <button
          className="ds-button chev"
          disabled={!props.playing}
          title="Beat repeat length: 16…1 steps, then micro 1/2…1/32 of a step (a re-triggering roll). Or Ctrl+↑/↓. Editable while off."
          onClick={() => op("brFiner")}
        >
          ‹
        </button>
        <span className={`ds-value br-len${section.beatRepeatActive ? " active" : ""}`}>
          {beatRepeatLabel(section)}
        </span>
        <button
          className="ds-button chev"
          disabled={!props.playing}
          title="Beat repeat length: 16…1 steps, then micro 1/2…1/32 of a step (a re-triggering roll). Or Ctrl+↑/↓. Editable while off."
          onClick={() => op("brCoarser")}
        >
          ›
        </button>
        {/* SHIFT — ◀ ▶ slide the ENGAGED region a step, length intact. Filled triangles, not
            chevrons: native draws the two pairs with different glyphs because they do different
            things, and the web had only this pair — wearing the length pair's glyphs. */}
        <button
          className="ds-button chev"
          disabled={!props.playing || !section.beatRepeatActive}
          title="Shift the engaged beat-repeat region one step earlier (◀) or later (▶), keeping its length. Or Ctrl+←/→."
          onClick={() => op("brShiftLeft")}
        >
          ◀
        </button>
        <button
          className="ds-button chev"
          disabled={!props.playing || !section.beatRepeatActive}
          title="Shift the engaged beat-repeat region one step earlier (◀) or later (▶), keeping its length. Or Ctrl+←/→."
          onClick={() => op("brShiftRight")}
        >
          ▶
        </button>
      </div>

      {/* Row 3 — this deck's pattern SNAPSHOTS (user, 2026-07-13): 1–8 · S/R/0 ·
          SCN · MUTE, on a row of their own at regular button size. Snapshot
          switching is a TRANSPORT act — it schedules against the pattern
          boundary exactly like launching a deck — so the cluster belongs in the
          deck's transport box, not in the master row. Scenes are per-sequencer,
          so each deck operates its own set independently (djmode.md §4C). */}
      <div className="block-row scene-row">
        <ScenePads link={link} deck={deck} />
        {/* Grid TOOLS, right-bound to the box edge (user, 2026-07-16): GRID and
            PERF are per-deck grid modes, not transport, so they form their own
            cluster at the right rather than crowding row 1. GRID collapses this
            deck's DJ-view cells; PERF makes the grid a locator surface (drag =
            set + engage the repeat window, click = disengage). Both reachable
            from compose too — PERF there sets locator points by dragging instead
            of typing, so the compose grid follows the active deck's mode. */}
        <div className="deck-tools">
          <Button
            label="GRID"
            active={!props.gridHidden}
            title={
              props.gridHidden
                ? "Show this deck's pattern grid in the DJ view"
                : "Hide this deck's pattern grid in the DJ view (rows stay live)"
            }
            onClick={props.onToggleGrid}
          />
          <Button
            label="PERF"
            active={props.performOn}
            title={
              props.performOn
                ? "Perform mode ON: drag on the grid sets the locator repeat window (click a row to disengage) — click to return to composing"
                : "Perform mode: grid drags set the locator repeat window instead of editing the pattern (works in compose too, for setting locator points by hand)"
            }
            onClick={props.onTogglePerform}
          />
        </div>
      </div>

      {/* Row 4 — LCM progress, full block width */}
      <LcmBar link={link} deck={deck} />
    </section>
  );
}

/** Per-deck LCM cycle bar (hot surface, full block width). */
function LcmBar({ link, deck }: { link: EngineLink | null; deck: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !link) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const posIdx = [HotFrameLayout.lcmPosDeck0, HotFrameLayout.lcmPosDeck1, HotFrameLayout.lcmPosDeck2][deck]!;
    const lenIdx = [HotFrameLayout.lcmLenDeck0, HotFrameLayout.lcmLenDeck1, HotFrameLayout.lcmLenDeck2][deck]!;
    let pos = 0;
    let len = 16;
    let raf = 0;
    const off = link.onHotFrame((frame) => {
      pos = frame[posIdx] ?? 0;
      len = Math.max(1, frame[lenIdx] ?? 16);
    });
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = css("--bg-raised");
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = css("--accent");
      ctx.fillRect(0, 0, ((pos % len) / len) * w, h);
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, [link, deck]);

  return <canvas ref={canvasRef} className="lcm-bar-wide" />;
}
