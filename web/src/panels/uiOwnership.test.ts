import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "ONE CONTROL, ONE HOME" — the acceptance test for Phase 6 (djmode.md §4C).
 *
 * The DJ view was built as an ADDITION to the toolbar rather than a relocation,
 * so master tempo, launch quantize, the crossfader, SYNC+pulse and the session
 * name each ended up rendered in two places. Doubles are worse than a missing
 * control: mid-set you cannot tell which one is authoritative.
 *
 * These are source assertions rather than render assertions on purpose — a
 * duplicate creeps back in as a WRITE (a `paramWrite`/`command` in a second
 * panel), and that is exactly what this greps for. Each rule names the single
 * home and the file that is allowed to own it.
 */

const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");

const DJ_PANEL = read("DjPanel.tsx");
const TRANSPORT = read("TransportPanel.tsx");
const MIXER = read("DeckMixerPanel.tsx");
const MASTER_ROW = read("MasterRow.tsx");
const NUDGE = read("NudgeBox.tsx");

/** Panels that may NOT write a control whose home is elsewhere. */
const ALL = {
  DjPanel: DJ_PANEL,
  TransportPanel: TRANSPORT,
  DeckMixerPanel: MIXER,
  MasterRow: MASTER_ROW,
  // NudgeBox is a component, not a panel — but it OWNS the nudge write, and the
  // rule is about who may render it: only the transport box mounts it.
  NudgeBox: NUDGE,
};

/** Assert exactly one panel writes `token`, and that it is `home`. */
function singleHome(token: string, home: keyof typeof ALL) {
  const owners = Object.entries(ALL)
    .filter(([, src]) => src.includes(token))
    .map(([name]) => name);
  expect(owners, `${token} must be written by exactly one panel`).toEqual([home]);
}

describe("one control, one home (djmode.md §4C)", () => {
  it("master tempo lives ONLY in the DJ master box", () => {
    // It was in the transport DJ block AND the DJ view's X·MIX bar.
    singleHome('paramWrite("masterTempo"', "TransportPanel");
  });

  it("launch quantize lives ONLY in the DJ master box", () => {
    // Two controls wrote the same globalLaunchQuantize: the Tools row's `Q:`
    // cycler (toolbarTool.cycleQuantize) and the DJ view's picker. The tools
    // row itself is gone (TB-1) — this now just guards the survivor.
    singleHome('"launchQuantize"', "TransportPanel");
  });

  it("the CPU + output meters each render ONCE (TB-1)", () => {
    // The tools row held both; it also held three controls that did nothing.
    // Deleting it must RELOCATE the meters, not clone them: OUT onto CAPTURE
    // (which records exactly what it meters) and CPU into the console's global
    // block. A second copy of either is the thing this file exists to stop.
    expect(MIXER, "the CPU meter's one home is the console utility block")
      .toContain("<CpuMeter");
    for (const [name, src] of Object.entries(ALL)) {
      if (name === "DeckMixerPanel") continue;
      expect(src, `${name} must not render a second CPU meter`).not.toContain("CpuMeter");
      expect(src, `${name} must not render a second output meter`).not.toContain("OutputMeter");
    }
  });

  it("tempo mode lives ONLY in the DJ master box", () => {
    singleHome('"tempoMode"', "TransportPanel");
  });

  it("the crossfader + X·MIX live ONLY on the mixer XFADE row", () => {
    singleHome('paramWrite("crossfaderPosition"', "DeckMixerPanel");
    singleHome('paramWrite("crossfaderEngaged"', "DeckMixerPanel");
    singleHome('paramWrite("xmixEnabled"', "DeckMixerPanel");
    singleHome('paramWrite("xmixStrength"', "DeckMixerPanel");
    singleHome('paramWrite("xmixShimmer"', "DeckMixerPanel");
    expect(DJ_PANEL, "the DJ view's X·MIX bar must be gone").not.toContain("dj-xmix");
  });

  it("nudge lives ONLY in the deck's transport box", () => {
    // The nudge WRITE lives in the shared NudgeBox…
    singleHome('paramWrite("deckNudgeBpm"', "NudgeBox");
    // …and only the transport box may MOUNT it (it was also in the DJ header).
    expect(TRANSPORT).toContain("<NudgeBox");
    expect(DJ_PANEL, "the DJ view must not render a second nudge").not.toContain("NudgeBox");
  });

  it("DRY× is gone everywhere (user, 2026-07-13)", () => {
    // It was the SP1/SP2 spectral takeover: kill the dry main, keep the wet SP
    // send. The carve-down retired that send pool (spectral FX = the standalone
    // plugin), leaving a button that merely duplicated the deck output mute.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not resurrect DRY×`).not.toContain("deckDryMute");
  });

  it("SYNC + pulse + the session name live ONLY in the deck's transport box", () => {
    expect(TRANSPORT).toContain('op("toggleSync")');
    expect(DJ_PANEL, "SYNC must not be re-rendered in the DJ view").not.toContain("toggleSync");
    expect(DJ_PANEL).not.toContain("pulseNext");
    expect(DJ_PANEL).not.toContain("sessionName");
  });

  it("session BPM + master volume live ONLY in the master track row", () => {
    singleHome('"sessionBpm"', "MasterRow");
    singleHome('"sessionMasterVolume"', "MasterRow");
  });

  it("the deck MASTER sends live ONLY in the master track row (mixer overhaul)", () => {
    // They were vertical micro-faders on the mixer's deck strips — the one
    // control outside the app's slider+box language, and a second home waiting
    // to happen once the master row grew real sends. RELOCATED, not cloned:
    // the deck header is the deck's master track, so its sends live there.
    singleHome('paramWrite("deckMasterSend"', "MasterRow");
  });

  it("add-track lives ONLY in the compose master row", () => {
    // Track topology had NO web home at all: with the web grid on, the app
    // could not create a track (the native `+` buttons are dead code, and the
    // Track menu targets `activeSequencer`, not the grid). The `+` is the one
    // web home — and it must not sprout a second copy in a deck row, which is
    // why it is gated on `showAdd` rather than rendered unconditionally.
    singleHome('"addTrack"', "MasterRow");
    expect(MASTER_ROW, "the `+` is compose-only — a deck row is not a place to build")
      .toContain("showAdd");
  });

  it("the pattern-scene cluster lives ONLY in the deck's transport box", () => {
    // Snapshot switching schedules against the pattern boundary — it is a
    // TRANSPORT act, so pads + S/R/0 + SCN + MUTE ride the deck's transport box
    // (user, 2026-07-13), on a row of their own.
    expect(TRANSPORT).toContain("<ScenePads");
    expect(MASTER_ROW, "the master row must not render a second cluster").not.toContain(
      "ScenePads",
    );
    expect(DJ_PANEL, "the DJ view must not render a second cluster").not.toContain("ScenePads");
  });

  it("the master track row owns session BPM + volume and nothing transport-ish", () => {
    expect(MASTER_ROW).toContain('"sessionBpm"');
    // SCN / MUTE / snapshot switching are transport, not master-row, controls.
    for (const foreign of ["sendSceneToggleLatch", "sendSceneToggleMute", "sendSceneClick"]) {
      expect(MASTER_ROW, `${foreign} belongs to the transport box`).not.toContain(foreign);
    }
  });

  it("the DJ deck header is GONE — GRID + the C projection live in the transport box", () => {
    // 2026-07-14: the header (letter badge · GRID · C) was the DJ view's last
    // own chrome, and it left. The letter's job went to the identity-colored
    // transport box aligned above each slot; GRID and C moved into that box so
    // they are reachable from compose too. The DJ panel now only READS the
    // shared state (dj.deckCProjectedSlot / dj.gridHidden) — a write creeping
    // back in here is the double this file exists to stop.
    expect(DJ_PANEL, "the header row itself must stay deleted").not.toContain("dj-deck-head");
    singleHome('label="GRID"', "TransportPanel");
    singleHome('"deckCProjection"', "TransportPanel");
    singleHome('"gridHidden"', "TransportPanel");
    // PERF rides the same pattern: written ONLY from the transport deck box;
    // DjPanel/GridPanel read dj.performMode (property access, not a write).
    singleHome('label="PERF"', "TransportPanel");
    singleHome('"performMode"', "TransportPanel");
    // …and nothing that has a home elsewhere.
    for (const foreign of ["masterTempo", "crossfaderPosition", "deckNudgeBpm", "xfaderSide"]) {
      expect(DJ_PANEL, `${foreign} has a home outside the DJ view`).not.toContain(foreign);
    }
  });

  it("NO panel writes an X-MIX side (mixer overhaul)", () => {
    // The per-channel picker retired: sides are fixed policy in DJModeManager.init
    // (A→a, B→b, rest own) until the X-MIX matrix lands. A `setXmixSide` write
    // reappearing in any panel means a second (now UI-less) writer crept back.
    for (const [name, src] of Object.entries(ALL)) {
      expect(src, `${name} must not write an X-MIX side — sides are fixed policy`).not.toContain(
        "setXmixSide",
      );
    }
  });
});

/**
 * NK-5 — "ONE KEYBOARD, ONE DECK".
 *
 * The same disease as the doubles above, in the keyboard domain. `DjPanel` mounts
 * TWO `GridPanel`s in ONE page, and each registers its own `window` keydown
 * listener with no knowledge of the other — so every arrow moved BOTH decks'
 * cursors, and once NK-3 made the cursor publish a native selection, the two decks
 * raced to claim `activeSequencer` on every press: the keyboard landed wherever the
 * last listener happened to run.
 *
 * The gate is one line, and losing it would be silent — the UI would look right and
 * the keys would go to the wrong deck. So it is asserted at the source, like the
 * ownership rules: a grid that is not the keyboard's yields EVERYTHING to native.
 */
describe("one keyboard, one deck (NK-5)", () => {
  const GRID = readFileSync(new URL("./GridPanel.tsx", import.meta.url), "utf8");

  // It yields by FORWARDING, never by swallowing: a bare `return` would kill the
  // whole native shortcut library (transport, undo, record-arm) for the non-active
  // deck, instead of routing it to the deck that IS active. The exact string is the
  // assertion — that is the difference between the two behaviours.
  it("a grid that does not hold the keyboard forwards every key", () => {
    expect(GRID).toContain('if (!keyboardActiveRef.current) return "forward"');
  });

  it("the gate reads a ref, not state — the listener is registered once per link", () => {
    // Reading `meta.keyboardActive` inside the keydown closure would answer with
    // whatever was true at MOUNT, so the gate would freeze on the first deck.
    // NAV-11: the DEFAULT is one owner, not all — compose or DJ slot 0, matching
    // Swift's nil-activeSequencer rule, so both DJ decks don't race at launch.
    expect(GRID).toContain(
      "const keyboardActiveRef = useRef(djSlotIndex === undefined || djSlotIndex === 0)",
    );
    expect(GRID).toContain("keyboardActiveRef.current = meta.keyboardActive");
  });

  it("clicking a non-keyboard deck's track still publishes, so a click switches deck", () => {
    // Without the `!keyboardActiveRef.current` arm, clicking the track the other
    // deck's cursor already sat on would publish nothing — and the one gesture that
    // hands the keyboard to a deck would silently do nothing. NAV-8 added the
    // third arm: a plain select while a multi-selection exists must publish even
    // with no track change, so Swift can COLLAPSE the set (Finder semantics).
    expect(GRID).toContain("prev?.trackIndex !== cell.trackIndex ||");
    expect(GRID).toContain("!keyboardActiveRef.current ||");
    expect(GRID).toContain("selectedTracksRef.current.length > 1");
  });
});
