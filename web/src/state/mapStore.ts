/**
 * The plane's document store — the ONE place a `.scoopyMap` lives while it is
 * being performed.
 *
 * WIZARD'S LAW, KEPT: TS owns the document, the engine follows. Nothing here
 * asks the engine what is true; the map is the truth and the engine is made to
 * match it. The one exception is `captureMap`, which reads the ROUTING graph
 * back out — because routing is the one thing that can change outside this
 * store's view (a default installed at boot, a cable added by another surface),
 * and a save that recorded intent rather than reality would silently drop it.
 *
 * WHY THERE IS NO SECOND APPLIER. `persist/mapApply.ts::planApply` already
 * turns a map into an ORDERED list of engine ops, and its ordering rules are
 * separately and exhaustively tested with no engine in the room. This module is
 * the `for` loop that finally issues them. Adding a second path that "just
 * writes the channel directly on load" is how the two drift.
 */
import { create } from "zustand";
import type { EngineLink } from "../engineLink.ts";
import { ask, send } from "../plane/send.ts";
import {
  captureRoutes,
  planApply,
  type EngineOp,
  type LiveRoute,
} from "../persist/mapApply.ts";
import {
  LANE_BUDGET,
  elementLanes,
  emptyMap,
  lanesUsed,
  type Element,
  type PlaneMap,
  type Strip,
} from "../persist/mapDocument.ts";
import { TEMPO_MODE_ID, mapTempoIntents } from "../persist/tempo.ts";
import { setTempoOverride } from "../store/companionEngine.ts";

/* ── the store ────────────────────────────────────────────────────────────── */

type MapState = {
  map: PlaneMap;
  /** The strip the Inspector targets. A key, not an index: strips are keyed so
      a strip that gains material does not remount, and an index would shift
      under any insert or removal. */
  selectedKey: string | null;
  /** Set by every mutation, cleared by save. Drives the "unsaved" affordance;
      never used to decide whether to apply anything. */
  dirty: boolean;
  /** The map's name on disk, or null for one never saved. Autosave will not
      touch an unnamed map — scattering "untitled-3" documents nobody asked for
      is worse than losing an experiment, and the first explicit save is what
      says "this one is worth keeping". */
  name: string | null;
};

export const useMapStore = create<MapState>(() => ({
  map: emptyMap(),
  selectedKey: null,
  dirty: false,
  name: null,
}));

/** Non-React readers (the rAF drawers, the command coalescer). */
export const getMap = (): PlaneMap => useMapStore.getState().map;

// A debug/gate handle on the store, mirroring `window.__scoopyLink`. The layout
// gate drives the plane through the real UI wherever it can, but there is no
// affordance for "make this strip a grid strip" yet — the element is chosen at
// creation and increment 3's creation gesture is not built. Exposing the store
// is how a canvas-and-menus surface stays measurable at all; the alternative is
// a gate that can only ever check the default state.
if (typeof window !== "undefined")
  (window as unknown as { __planeStore?: unknown }).__planeStore = useMapStore;

/** Replace the map wholesale — a load. Does NOT touch the engine; call
    `applyMap` for that. Kept separate so a load can be validated, previewed and
    refused before anything audible changes. */
export function setMap(map: PlaneMap): void {
  useMapStore.setState({ map, dirty: false, selectedKey: null });
}

export const getMapName = (): string | null => useMapStore.getState().name;

export function setSelected(key: string | null): void {
  useMapStore.setState({ selectedKey: key });
}

/** Immutably update one strip by key. Every strip mutation goes through here,
    so `dirty` cannot be forgotten at a call site. */
export function updateStrip(key: string, fn: (s: Strip) => Strip): void {
  useMapStore.setState((st) => ({
    map: {
      ...st.map,
      strips: st.map.strips.map((s) => (s.key === key ? fn(s) : s)),
    },
    dirty: true,
  }));
}

export function updatePlaneView(plane: PlaneMap["plane"]): void {
  // Deliberately NOT dirty: panning and zooming are looking, not editing. If
  // they marked the document dirty, simply reading your own patch would prompt
  // to save it, and the prompt would stop meaning anything.
  useMapStore.setState((st) => ({ map: { ...st.map, plane } }));
}

/** The plane's master tempo. Takes the link because IT HAS TO REACH THE ENGINE:
    this used to be a pure document write, which is why the master knob did
    nothing. See `applyTempo`.

    `link` is REQUIRED, with no default. A default of `null` would compile at
    every call site and silently restore the exact bug this signature exists to
    fix — a master tempo that moves on screen and reaches nothing. A caller that
    genuinely has no engine passes `null` and says so. */
export function setMasterBpm(masterBpm: number, link: EngineLink | null): void {
  useMapStore.setState((st) => ({
    map: { ...st.map, transport: { ...st.map.transport, masterBpm } },
    dirty: true,
  }));
  void applyTempo(link);
}

export function setMasterLevel(masterLevel: number): void {
  useMapStore.setState((st) => ({
    map: { ...st.map, transport: { ...st.map.transport, masterLevel } },
    dirty: true,
  }));
}

/* ── the lane budget ──────────────────────────────────────────────────────── */

export type BudgetCheck =
  | { ok: true }
  | { ok: false; used: number; wanted: number; budget: number };

/**
 * Would giving `key` this element overspend the mixer's lane budget?
 *
 * Checked BEFORE the element is added rather than at save: `loadMap` already
 * refuses an overspent map, so allowing one to be built would create a document
 * that cannot be reloaded — the worst moment to find out is the next time you
 * open it.
 */
export function checkBudget(key: string, next: Element): BudgetCheck {
  const map = getMap();
  const current = map.strips.find((s) => s.key === key);
  const used = lanesUsed(map) - (current ? elementLanes(current.element) : 0);
  const wanted = used + elementLanes(next);
  return wanted <= LANE_BUDGET
    ? { ok: true }
    : { ok: false, used, wanted, budget: LANE_BUDGET };
}

/* ── issuing ops ──────────────────────────────────────────────────────────── */

/**
 * One `EngineOp` → one command. The op list's shape is `mapApply`'s; this is
 * only the translation to the wire, so an op that gains a field there needs no
 * decision here.
 */
async function issue(link: EngineLink, op: EngineOp): Promise<void> {
  switch (op.op) {
    case "routeClearAll":
      await ask(link, "slRoute", { action: "clearAll" });
      return;
    case "channelSetSource":
      await ask(link, "slChannel", {
        action: "setSource",
        channel: op.channel,
        kind: op.kind,
        index: op.index,
      });
      return;
    case "channelSetLevel":
      await ask(link, "slChannel", {
        action: "setLevel",
        channel: op.channel,
        level: op.level,
      });
      return;
    case "channelSetMute":
      await ask(link, "slChannel", {
        action: "setMute",
        channel: op.channel,
        muted: op.muted,
      });
      return;
    case "channelSetMonitor":
      await ask(link, "slChannel", {
        action: "setMonitor",
        channel: op.channel,
        on: op.on,
      });
      return;
    case "channelSetSend":
      await ask(link, "slChannel", {
        action: "setSend",
        channel: op.channel,
        send: op.send,
        level: op.level,
      });
      return;
    case "tapeSetLoop":
      await ask(link, "slTape", {
        action: "setLoop",
        tape: op.tape,
        enabled: op.enabled,
        start: op.start,
        end: op.end,
      });
      return;
    case "tapeSetRate":
      await ask(link, "slTape", { action: "setRate", tape: op.tape, rate: op.rate });
      return;
    case "tapeLoadTake":
      // NOT ON THE WIRE YET, and deliberately not faked. Loading a take means
      // DECODING A FILE into a tape, which is host work (an off-thread decode,
      // then sl_tape_load, which allocates) and has no ABI entry point that
      // takes a path. A strip whose take cannot be loaded is an "unresolved
      // strip" — the take library already models exactly that, and preserving
      // the reference is what lets recording over it be a repair rather than a
      // loss. Silently succeeding here would instead give a silent tape with
      // nothing anywhere saying why.
      return;
    case "deckSetTempoSync":
      // This one DOES have an ABI point (`sl_deck_set_tempo_sync`), and lumping
      // it with the scene ops below was a mistake — a synced deck would have
      // loaded at whatever ratio the previous map left behind.
      await ask(link, "slDeck", {
        action: "setTempoSync",
        deck: op.deck,
        ratio: op.ratio,
      });
      return;
    case "deckSetTempoMode":
      await ask(link, "slDeck", { action: "setTempoMode", deck: op.deck, value: op.mode });
      return;
    case "deckSetTranspose":
      await ask(link, "slDeck", { action: "setTranspose", deck: op.deck, value: op.semitones });
      return;
    case "sceneSelect":
    case "sceneSetSwitch":
      // These do NOT. `sl_deck_*` has no scene entry point at all, because a
      // scene is a projection of the DOCUMENT rather than an engine parameter —
      // so scene state travels inside the published world (`slWorld`) with the
      // rest of the session. Skipped here rather than refused: a map with a
      // grid strip must still load its tapes and its routing.
      return;
    case "routeAdd":
      await ask(link, "slRoute", {
        action: "add",
        srcKind: op.srcKind,
        srcIndex: op.srcIndex,
        srcSub: op.srcSub,
        dstKind: op.dstKind,
        dstIndex: op.dstIndex,
        gain: op.gain,
        feedback: op.feedback,
      });
      return;
  }
}

/**
 * Make the engine match `map`. THE LOAD PATH, and the only caller of
 * `planApply`.
 *
 * Ops are issued IN ORDER and awaited one at a time. That is not caution about
 * threading — the commands are ordered on the wire anyway — it is that a
 * failure must stop the sequence rather than let the rest of a patch land on a
 * half-configured engine. It is ~40 calls on a load and never runs while
 * anything is being performed, so the cost is irrelevant.
 */
export async function applyMap(link: EngineLink | null, map: PlaneMap): Promise<void> {
  if (!link) return;
  for (const op of planApply(map)) await issue(link, op);
  // The master is transport state, not a strip's — `planApply` has no op for
  // it, and adding one would mean a second place that decides load ORDER. It
  // goes last, with the rest of the output section.
  await ask(link, 'slMaster', { action: 'setLevel', level: map.transport.masterLevel });
}

/**
 * THE MASTER TEMPO, PUSHED AT THE ENGINE.
 *
 * ⚠️ `setMasterBpm` USED TO REACH NOTHING. It mutated the document and stopped
 * there — no engine call anywhere on the path — so turning the plane's master
 * tempo changed the audio only by accident, at whatever unrelated world publish
 * happened next (which re-derived the ratios on its way past). The master is
 * the plane's control, so the plane has to carry it.
 *
 * Every synced deck is re-resolved through the tempo law, because the master
 * moving changes more than a number: `auto` can resolve to a different pulse
 * relation at a different master tempo, and only the law knows when.
 *
 * Awaited in order, like `applyMap`: a few calls at human rate, and a refusal
 * must stop the sequence rather than leave half the decks at the old tempo.
 */
export async function applyTempo(link: EngineLink | null): Promise<void> {
  if (!link) return
  const map = getMap()
  for (const intent of mapTempoIntents(map)) {
    // All three sent every time rather than diffed: the engine is the only
    // thing that knows what it is currently carrying, and a diff against a
    // stale local guess is how a deck ends up stretched with the UI at 1:1.
    await ask(link, 'slDeck', {
      action: 'setTempoMode',
      deck: intent.deck,
      value: TEMPO_MODE_ID[intent.tempoMode],
    })
    await ask(link, 'slDeck', { action: 'setTempoSync', deck: intent.deck, ratio: intent.syncRatio })
    await ask(link, 'slDeck', {
      action: 'setTranspose',
      deck: intent.deck,
      value: intent.transpose,
    })
  }
}

/** A grid element's tempo fields — the ones `applyTempo` resolves. */
type GridElement = Extract<Element, { kind: 'grid' }>
type TempoPatch = Partial<
  Pick<GridElement, 'bpm' | 'syncToMaster' | 'tempoMode' | 'pulseRelation' | 'transpose'>
>

/**
 * Edit one grid strip's tempo AND tell the engine.
 *
 * ⚠️ THE STRIP'S SYNC TOGGLE USED TO REACH THE ENGINE BY ACCIDENT. It called
 * `updateStrip` and stopped, so nothing was pushed — and it appeared to work
 * only because the next world publish ran `reapplyAfterPublish`, which re-sent
 * every strip's ratio for an unrelated reason. Deleting that hook (the engine
 * no longer stomps the ratio, so there is nothing to re-assert) removed the
 * accident with it, which is why this exists.
 *
 * The whole map is re-pushed rather than just this deck: `masterBpm` is shared,
 * so in principle only this strip changed — but the cost is three calls per
 * grid strip at human rate, and a targeted push is one more place that has to
 * be right about which decks a change can reach.
 */
export function updateGridTempo(
  key: string,
  link: EngineLink | null,
  patch: TempoPatch,
): void {
  updateStrip(key, (s) =>
    s.element.kind === 'grid' ? { ...s, element: { ...s.element, ...patch } } : s,
  )
  // ⚠️ THE STRIP'S BPM HAS TO REACH THE ENGINE TOO, and it is not the sync path
  // that carries it. `element.bpm` is what the SYNC RATIO is computed against;
  // what the deck actually PLAYS at is the bpm in its published world. Those
  // were two different numbers — the box moved, the deck did not, and the ratio
  // was resolved against a tempo the deck was not running at.
  //
  // It goes through the performance OVERRIDE rather than writing the session,
  // and that is the design rather than the cheap option: `GridElement.tsx`'s
  // header scopes the strip to the performance layer precisely so a knob touched
  // from the map cannot bleed into every other map using that session. The
  // override wins on every publish and never reaches the Autosaver.
  if (patch.bpm !== undefined) {
    const el = getMap().strips.find((s) => s.key === key)?.element
    if (el?.kind === 'grid') setTempoOverride(patch.bpm, el.deck)
  }
  void applyTempo(link)
}

/**
 * Boot. What the panel calls once, and NOT the same thing as `applyMap`.
 *
 * THE BUG THIS EXISTS TO PREVENT. `planApply` starts with `routeClearAll` —
 * correctly, because a saved patch must not layer on top of the boot wiring.
 * But a FRESH map has no routes at all, so applying one to a new engine clears
 * the 40 boot defaults (every channel → main, every send → its FX bus) and
 * installs nothing in their place. The plane would then look completely normal
 * and make no sound whatsoever, with no cable anywhere explaining it.
 *
 * So a map that has never been saved BOOTS INTO THE DEFAULTS and immediately
 * captures them into itself. From that moment the document carries every cable
 * as an ordinary route — which is the design ("a fresh engine is wired straight
 * through the way a mixer's channel 1 is wired to jack 1, but the matrix can
 * show those cables and a document can re-point them") — and every subsequent
 * load takes the ordinary `applyMap` path.
 */
export async function bootMap(link: EngineLink | null): Promise<void> {
  if (!link) return
  const map = getMap()
  const fresh = map.routes.length === 0 && map.strips.length === 0
  if (!fresh) {
    await applyMap(link, map)
    return
  }
  await ask(link, 'slRoute', { action: 'clearAll' })
  await ask(link, 'slRoute', { action: 'installDefaults' })
  // Read them back rather than reconstructing them here: the engine owns what
  // "the default wiring" means, and a TS copy of that list would be a second
  // definition that drifts the first time the engine's defaults change.
  const captured = await captureMap(link)
  useMapStore.setState({ map: captured, dirty: false })
}

/**
 * The map as it should be SAVED: the store's document, with its routing graph
 * replaced by what the engine actually has patched.
 *
 * If the read fails the store's own routes are kept rather than an empty list
 * written — a save that silently dropped every cable because one command timed
 * out would destroy the patch it was trying to preserve.
 */
export async function captureMap(link: EngineLink | null): Promise<PlaneMap> {
  const map = getMap();
  if (!link) return map;
  try {
    const raw = await ask(link, "slRouteList", {});
    const routes = (raw as { routes?: LiveRoute[] })?.routes;
    if (!Array.isArray(routes)) return map;
    return { ...map, routes: captureRoutes(routes) };
  } catch {
    return map;
  }
}

/* ── live edits ───────────────────────────────────────────────────────────── */

/**
 * A fader drag is not a document load: it must not go through `applyMap`, which
 * would clear the patchbay on every pointermove.
 *
 * COALESCED TO ONE PER rAF PER TARGET, the same discipline `link.paramWrite`
 * uses for the core's parameters. A pointermove fires far faster than 60 Hz and
 * every one of these is a round trip; without this, dragging a fader queues
 * hundreds of commands and the audible move lags the finger. Only the LATEST
 * value for a target matters — an intermediate fader position that was
 * superseded before it was ever sent is not information anyone can hear.
 */
const pending = new Map<string, () => void>();
let frame = 0;

function flush(): void {
  frame = 0;
  const due = [...pending.values()];
  pending.clear();
  for (const send of due) send();
}

function coalesce(key: string, send: () => void): void {
  pending.set(key, send);
  if (frame === 0) {
    frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(flush)
        : (setTimeout(flush, 16) as unknown as number);
  }
}

/** Live channel level. Writes the store immediately (so the UI tracks the
    finger with no round trip) and coalesces the engine call. */
export function liveSetLevel(link: EngineLink | null, strip: Strip, level: number): void {
  updateStrip(strip.key, (s) => ({ ...s, level }));
  if (!link) return;
  coalesce(`level/${strip.channel}`, () => {
    send(link, "slChannel", { action: "setLevel", channel: strip.channel, level });
  });
}

export function liveSetSend(
  link: EngineLink | null,
  strip: Strip,
  index: number,
  level: number,
): void {
  updateStrip(strip.key, (s) => {
    const sends = [...s.sends] as Strip["sends"];
    sends[index] = level;
    return { ...s, sends };
  });
  if (!link) return;
  coalesce(`send/${strip.channel}/${index}`, () => {
    send(link, "slChannel", {
      action: "setSend",
      channel: strip.channel,
      send: index,
      level,
    });
  });
}

export function liveSetRate(link: EngineLink | null, strip: Strip, rate: number): void {
  if (strip.element.kind !== "tape") return;
  const tape = strip.element.index;
  updateStrip(strip.key, (s) =>
    s.element.kind === "tape" ? { ...s, element: { ...s.element, rate } } : s,
  );
  if (!link) return;
  coalesce(`rate/${tape}`, () => {
    send(link, "slTape", { action: "setRate", tape, rate });
  });
}

/** Mute is a DISCRETE edit and is deliberately NOT coalesced: it happens once
    per click, and delaying it by a frame would make the button feel late. */
export function setMute(link: EngineLink | null, strip: Strip, mute: boolean): void {
  updateStrip(strip.key, (s) => ({ ...s, mute }));
  send(link, "slChannel", { action: "setMute", channel: strip.channel, muted: mute });
}

/** The MONITOR switch — same discrete, un-coalesced treatment as mute, and for
    a sharper reason: this is the control you reach for when a mic starts
    feeding back, so a frame of deliberate latency is the wrong trade. */
export function setMonitor(link: EngineLink | null, strip: Strip, on: boolean): void {
  updateStrip(strip.key, (s) => ({ ...s, monitor: on }));
  send(link, "slChannel", { action: "setMonitor", channel: strip.channel, on });
}

/** Record what the ENGINE did to a monitor switch, without re-sending it.
    The engine opens the switch at record-start and closes it at the Law C-3
    handoff (D-WZ-MON-01/02), so the document has to FOLLOW rather than lead —
    otherwise a save would store an intent the engine had already overruled, and
    reopening the map would put the strip back into the state the handoff just
    took it out of. */
export function noteMonitor(strip: Strip, on: boolean): void {
  if (strip.monitor === on) return;
  updateStrip(strip.key, (s) => (s.monitor === on ? s : { ...s, monitor: on }));
}

/** Flush anything queued right now — for pointer-up, so the final value of a
    drag is on the wire before the gesture is considered finished, and for
    tests, which have no animation frames. */
export function flushLiveEdits(): void {
  if (frame !== 0) {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    else clearTimeout(frame);
  }
  flush();
}
