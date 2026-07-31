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

const MIXER = read("DeckMixerPanel.tsx");
const MASTER_ROW = read("MasterRow.tsx");
/**
 * ⚠️ `TransportPanel`, `DjPanel`, `ScenePads` and `NudgeBox` ARE GONE
 * (B1-RETIRE). Every verb they spoke — deckSection, transportDeck, djSetting,
 * toggleDjMode, the transportGlobal trio — was answered by no host, so the
 * panels were a complete DJ surface that did nothing.
 *
 * Their rules did NOT die with them. Each control they owned now names the
 * surface that owns it TODAY, which is the P11-5b rule: a pin whose home moves
 * gets REPOINTED, never deleted, or the duplicate it was guarding against comes
 * back unobserved. Where a control has no home at all any more, the rule says
 * so explicitly rather than vanishing.
 */
const DECK_ROWS = readFileSync(new URL("../plane/deckRows.tsx", import.meta.url), "utf8");
const DECK_TILE = readFileSync(new URL("../plane/deckTile.tsx", import.meta.url), "utf8");
const STRIP = readFileSync(new URL("../plane/Strip.tsx", import.meta.url), "utf8");
const GRID_ELEMENT = readFileSync(new URL("../plane/GridElement.tsx", import.meta.url), "utf8");
/** Not a panel — the plane's master BAR (P11-5 gave it the engine-health read).
    Read separately from `ALL` on purpose: `ALL` is the set of surfaces that may
    not write someone else's control, and the master bar is a home, not a
    contender. */
const MASTER = readFileSync(new URL("../plane/Master.tsx", import.meta.url), "utf8");

/** Panels that may NOT write a control whose home is elsewhere. */
const ALL = {
  DeckMixerPanel: MIXER,
  MasterRow: MASTER_ROW,
  // The plane surfaces that inherited the retired panels' controls. They are
  // contenders now for the same reason the panels were: each may own some
  // controls and must not write anyone else's.
  DeckRows: DECK_ROWS,
  DeckTile: DECK_TILE,
  Strip: STRIP,
  GridElement: GRID_ELEMENT,
};

/** Assert exactly one panel writes `token`, and that it is `home`. */
function singleHome(token: string, home: keyof typeof ALL) {
  const owners = Object.entries(ALL)
    .filter(([, src]) => src.includes(token))
    .map(([name]) => name);
  expect(owners, `${token} must be written by exactly one panel`).toEqual([home]);
}

describe("one control, one home (djmode.md §4C)", () => {
  it("master tempo has NO param writer left — it is a document value now", () => {
    // REPOINTED (B1-RETIRE). Its home was TransportPanel's DJ master box, which
    // wrote `paramWrite("masterTempo")`. The plane's master bar owns the tempo
    // now and writes the DOCUMENT (`setMasterBpm` → `applyTempo` → per-deck
    // sync ratios), because per-deck BPM isolation is a mission requirement and
    // a single global param cannot express it. So the rule inverts: no panel
    // may resurrect the param write.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not write masterTempo as a param`).not.toContain(
        'paramWrite("masterTempo"',
      );
  });

  it("the launch quantum has ONE home, and it is not the old spelling", () => {
    // REPOINTED (B1-RETIRE + D-SL-QUANTUM-01). `launchQuantize` was the donor's
    // ONE GLOBAL quantize, written by TransportPanel's picker. It is
    // `launchQuantum` now: the SCALE map-wide on the plane's master bar, the
    // REFERENCE per strip. Two names for one idea is exactly the duplicate this
    // file guards, so the old spelling must not come back anywhere.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not resurrect launchQuantize`).not.toContain('"launchQuantize"');
    expect(MASTER, "the quantum's scale lives on the plane's master bar").toContain(
      "master-quantum",
    );
  });

  it("the engine-health + output meters each render ONCE (TB-1, rehomed by P11-5)", () => {
    // The tools row held both; it also held three controls that did nothing.
    // Deleting it must RELOCATE the meters, not clone them: OUT onto CAPTURE
    // (which records exactly what it meters) and CPU into the console's global
    // block. A second copy of either is the thing this file exists to stop.
    //
    // P11-5 MOVED THE AUDIO-LOAD READ AGAIN, and kept that rule while moving
    // it. The console block turned out to be a home nobody could reach:
    // `deckmixer` is not in `PANEL_MENU_SURFACES`, P3-P1 retired it, and it
    // hangs on "waiting for state" in the merged host. So the read — now
    // `HealthReadout`, `DSP n%` plus a monotonic overrun total — lives in the
    // plane's MASTER BAR, which is always on screen. The old `CpuMeter` was
    // DELETED rather than left mounted behind the dead door: two live readings
    // of `callbackLoad` is precisely the duplicate this file exists to stop.
    expect(MASTER, "the engine-health readout's one home is the plane's master bar")
      .toContain("<HealthReadout");
    for (const [name, src] of Object.entries(ALL)) {
      expect(src, `${name} must not render a second engine-health readout`)
        .not.toContain("HealthReadout");
      expect(src, `${name} must not render a second output meter`).not.toContain("OutputMeter");
    }
    // And the retired widget stays retired. A reintroduced CpuMeter would be a
    // second live read of the same scalar, under a name that means something
    // ELSE in this codebase — PerfPanel's "CPU" is paint cost (p95 < 2 ms per
    // frame), not audio load, and that collision is how the app ended up with
    // one health-sounding door that reported on the UI.
    for (const [name, src] of Object.entries({ ...ALL, Master: MASTER })) {
      expect(src, `${name} must not bring back the CpuMeter widget`).not.toContain("CpuMeter");
    }
  });

  it("tempo mode is a per-ELEMENT document field, written through one lane", () => {
    // REPOINTED. It was a global in the DJ master box; D-SL-MORPH-01 made it a
    // per-element musical choice, so it is written by `updateGridTempo` /
    // `updateTapeTempo` from whichever face is showing — the collapsed strip's
    // mode button or the deck row's. Both faces, ONE write lane: that is the
    // second-rendering rule (D-SL-FACES-01), not a duplicate.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not write tempoMode as a global param`).not.toContain(
        'paramWrite("tempoMode"',
      );
  });

  it("the crossfader + X·MIX live ONLY on the mixer XFADE row", () => {
    singleHome('paramWrite("crossfaderPosition"', "DeckMixerPanel");
    singleHome('paramWrite("crossfaderEngaged"', "DeckMixerPanel");
    singleHome('paramWrite("xmixEnabled"', "DeckMixerPanel");
    singleHome('paramWrite("xmixStrength"', "DeckMixerPanel");
    singleHome('paramWrite("xmixShimmer"', "DeckMixerPanel");
    // The DJ view that used to hold a second X·MIX bar is deleted outright
    // (B1-RETIRE), so the assertion moves to the survivors: no panel may grow
    // one back. P11-4 brings the crossfader to the plane with ASSIGNABLE sides
    // (D-SL-XFADER-01) — when it lands, its home is named here.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not grow a second X·MIX bar`).not.toContain("dj-xmix");
  });

  it("nudge lives ONLY on the deck row, through the nudge store", () => {
    // REPOINTED. `NudgeBox` was the shared write and only TransportPanel
    // mounted it; both are gone. The gesture survives on the deck row's ‹ ›
    // pair, which goes through `nudgeStore.setNudge` — a HOLD, released on
    // pointer-up, never the document (the U5 distinction).
    expect(DECK_ROWS, "the deck row owns the nudge gesture").toContain("setNudge");
    for (const [name, src] of Object.entries(ALL)) {
      if (name === "DeckRows") continue;
      expect(src, `${name} must not render a second nudge`).not.toContain("NudgeBox");
    }
  });

  it("DRY× is gone everywhere (user, 2026-07-13)", () => {
    // It was the SP1/SP2 spectral takeover: kill the dry main, keep the wet SP
    // send. The carve-down retired that send pool (spectral FX = the standalone
    // plugin), leaving a button that merely duplicated the deck output mute.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not resurrect DRY×`).not.toContain("deckDryMute");
  });

  it("SYNC + pulse are written through ONE lane, on two faces", () => {
    // REPOINTED, and this is the rule D-SL-FACES-01 refines rather than breaks.
    // SYNC appears on the collapsed strip's grid row AND on the expanded deck
    // row — deliberately, as second renderings of one state. What must stay
    // single is the WRITE: both go through `updateGridTempo`, so there is no
    // second source of truth about whether a deck follows the master.
    expect(GRID_ELEMENT, "the collapsed face renders SYNC").toContain("syncToMaster");
    expect(DECK_ROWS, "the expanded face renders it too — one state, two faces").toContain(
      "syncToMaster",
    );
    for (const src of [GRID_ELEMENT, DECK_ROWS])
      expect(src, "both faces write through updateGridTempo, never a param").not.toContain(
        'paramWrite("deckSyncEnabled"',
      );
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

  it("the pattern-scene cluster lives on the plane, and `ScenePads` stays retired", () => {
    // REPOINTED. `ScenePads` was TransportPanel's cluster and died with it. The
    // pads live on the collapsed strip (`GridScenes`) and the switch-mode / CU /
    // SCN / MUTE controls on the expanded deck row — the same
    // one-state-two-faces split as SYNC, and still a TRANSPORT act.
    expect(GRID_ELEMENT, "the pads are on the collapsed face").toContain("GridScenes");
    expect(DECK_ROWS, "the scene controls are on the expanded face").toContain("SCENE");
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not bring back the retired ScenePads`).not.toContain("<ScenePads");
  });

  it("the master track row owns session BPM + volume and nothing transport-ish", () => {
    expect(MASTER_ROW).toContain('"sessionBpm"');
    // SCN / MUTE / snapshot switching are transport, not master-row, controls.
    for (const foreign of ["sendSceneToggleLatch", "sendSceneToggleMute", "sendSceneClick"]) {
      expect(MASTER_ROW, `${foreign} belongs to the transport box`).not.toContain(foreign);
    }
  });

  it("GRID + PERF live on the deck tile; the C projection is gone entirely", () => {
    // REPOINTED (B1-RETIRE). These were TransportPanel's, and B1 moved the pair
    // onto the expanded tile's view row where they belong — the tile IS the
    // deck view now, so the controls that shape it sit on it.
    expect(DECK_ROWS, "GRID's one home is the deck view row").toContain('GRID');
    expect(DECK_ROWS, "PERF's one home is the deck view row").toContain('PERF');
    // PERF reaches the grid as a mount-owned META FACT rather than a param, so
    // exactly one surface can assert it.
    expect(DECK_TILE, "PERF rides the tile's meta facts").toContain("performActive");

    // ⚠️ `deckCProjection` HAS NO HOME AND MUST NOT GET ONE. It meant "project
    // deck C into slot A/B" — a fixed-three-deck idea that D-SL-MORPH-01
    // retired outright when the plane became N strips of one kind each. A
    // reintroduction would be reviving a model, not restoring a control.
    for (const [name, src] of Object.entries(ALL))
      expect(src, `${name} must not revive the deck-C projection`).not.toContain(
        '"deckCProjection"',
      );
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
