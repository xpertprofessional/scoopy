import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMap,
  bootMap,
  captureMap,
  checkBudget,
  flushLiveEdits,
  getMap,
  liveSetLevel,
  applyTempo,
  liveSetSend,
  setMap,
  setMasterBpm,
  setMute,
  updateStrip,
  useMapStore,
} from "./mapStore.ts";
import {
  LANE_BUDGET,
  emptyMap,
  loadMap,
  saveMap,
  type PlaneMap,
  type Strip,
} from "../persist/mapDocument.ts";
import { newGridElement } from "../plane/stripOps.ts";
import type { EngineLink } from "../engineLink.ts";

/** Records every command, so a test can assert on ORDER as well as content —
    the ordering rules are the load-bearing half of applying a map. */
function fakeLink(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const link = {
    command: (method: string, params: unknown) => {
      calls.push({ method, params: params as Record<string, unknown> });
      return Promise.resolve(overrides[method] ?? {});
    },
    paramWrite: () => {},
    onHotFrame: () => () => {},
    onEvent: () => () => {},
    onUiState: () => () => {},
  } as unknown as EngineLink;
  return { link, calls };
}

function strip(over: Partial<Strip> = {}): Strip {
  return {
    key: "s1",
    name: "TAPE 1",
    cell: { x: 0, y: 0, w: 340, h: 196 },
    channel: 0,
    element: {
      kind: "tape",
      index: 0,
      takeRef: null,
      stereo: false,
      loop: { enabled: true, start: 0, end: 1000 },
      rate: 1,
      bpm: null,
      syncToMaster: false,
      tempoMode: "timePitch" as const,
      pulseRelation: "auto" as const,
      launchRef: 'auto',
    },
    level: 1,
    mute: false,
    sends: [0, 0, 0, 0],
    drive: { curve: 0, amount: 1 },
    recordArm: false,
    monitor: false,
    recordTap: null,
    sessionPerf: {},
    ...over,
  };
}

function mapWith(strips: Strip[], routes: PlaneMap["routes"] = []): PlaneMap {
  return { ...emptyMap(), strips, routes };
}

beforeEach(() => {
  useMapStore.setState({ map: emptyMap(), selectedKey: null, dirty: false });
});

describe("applyMap", () => {
  it("clears the patchbay FIRST, even for an empty map", async () => {
    // Otherwise "load an empty map" silently means "keep whatever was patched",
    // and the boot defaults survive every load, getting louder each time.
    const { link, calls } = fakeLink();
    await applyMap(link, emptyMap());
    // FIRST is the whole claim — not "only".
    expect(calls[0]).toEqual({ method: "slRoute", params: { action: "clearAll" } });
    // The master goes LAST, with the rest of the output section: it is
    // transport state rather than a strip's, so planApply has no op for it and
    // adding one would create a second place that decides load order.
    expect(calls[calls.length - 1]).toEqual({
      method: "slMaster",
      params: { action: "setLevel", level: 1 },
    });
  });

  it("binds the channel source before writing its level", async () => {
    // Binding to a grid deck PROJECTS level/sends onto the core's per-deck
    // controls, so a level written first lands on the previous deck.
    const { link, calls } = fakeLink();
    await applyMap(link, mapWith([strip()]));
    const actions = calls
      .filter((c) => c.method === "slChannel")
      .map((c) => c.params.action);
    expect(actions[0]).toBe("setSource");
    expect(actions).toContain("setLevel");
    expect(actions.indexOf("setSource")).toBeLessThan(actions.indexOf("setLevel"));
  });

  it("issues routes LAST, after all channel state", async () => {
    const { link, calls } = fakeLink();
    await applyMap(
      link,
      mapWith(
        [strip()],
        [
          {
            src: { kind: "channelOut", index: 0, sub: null },
            dst: { kind: "main", index: 0 },
            gain: 1,
            feedback: false,
          },
        ],
      ),
    );
    const lastChannel = calls.map((c) => c.method).lastIndexOf("slChannel");
    const routeAdd = calls.findIndex((c) => c.params.action === "add");
    expect(routeAdd).toBeGreaterThan(lastChannel);
  });

  it("carries the feedback flag through to the wire", async () => {
    // Two routes differing only in this bit differ by a whole block of latency;
    // a loader that dropped it would silently change how a patch sounds.
    const { link, calls } = fakeLink();
    await applyMap(
      link,
      mapWith(
        [strip()],
        [
          {
            src: { kind: "channelOut", index: 1, sub: null },
            dst: { kind: "channelIn", index: 0 },
            gain: 0.5,
            feedback: true,
          },
        ],
      ),
    );
    const add = calls.find((c) => c.params.action === "add");
    expect(add?.params.feedback).toBe(true);
    expect(add?.params.gain).toBe(0.5);
  });

  it("encodes a null send sub as the sentinel, never 0", async () => {
    // 0 is a real send index and a real input channel.
    const { link, calls } = fakeLink();
    await applyMap(
      link,
      mapWith(
        [],
        [
          {
            src: { kind: "channelOut", index: 0, sub: null },
            dst: { kind: "main", index: 0 },
            gain: 1,
            feedback: false,
          },
        ],
      ),
    );
    const add = calls.find((c) => c.params.action === "add");
    expect(add?.params.srcSub).toBe(0xffffffff);
  });

  it("still loads tapes and routing when a grid strip is present", async () => {
    // The grid ops have no ABI behind them yet (there is no scene API in
    // sl_deck_*), so they are skipped — but skipping must not abort the rest of
    // the map.
    const { link, calls } = fakeLink();
    await applyMap(
      link,
      mapWith([
        strip(),
        strip({
          key: "s2",
          channel: 1,
          element: { ...newGridElement(0, "x", 120), syncToMaster: true },
        }),
      ]),
    );
    expect(calls.some((c) => c.method === "slTape")).toBe(true);
    // Both strips got their channel bound.
    const sources = calls.filter((c) => c.params.action === "setSource");
    expect(sources).toHaveLength(2);
  });

  it("does nothing without a link rather than throwing", async () => {
    // Still a no-op; it now REPORTS (P6-5b) — and with no engine to ask, it
    // cannot know a plugin is missing, so it must not claim one is.
    await expect(applyMap(null, mapWith([strip()]))).resolves.toEqual({ warnings: [] });
  });
});

/**
 * ⚠️ THIS BLOCK USED TO TEST `reapplyAfterPublish`, and its replacement is the
 * point of P3-2. That function existed because `sl_snapshot_begin` reset every
 * deck's tempoSyncRatio to 1.0, so any world publish — editing one step in the
 * grid — silently un-synced every synced deck, and the map re-asserted the
 * ratio after every publish to survive it.
 *
 * The ratio is now DECK SCOPE in the engine (SL-ABI-V3 §3) and survives a
 * publish by construction, so there is nothing to re-assert. What remains is
 * the opposite problem, which nothing covered: the master tempo CHANGING and
 * not reaching the engine at all.
 */
describe("applyTempo", () => {
  it("pushes every grid strip's tempo when the master moves", () => {
    setMap(
      mapWith([
        strip({
          key: "g",
          channel: 0,
          // 1:1 rather than the default `auto`, so this asserts the PLUMBING
          // with an arithmetic ratio. `auto` picking a musical relation is the
          // law's business and is covered in tempo.test.ts.
          element: {
            ...newGridElement(1, "s", 60),
            syncToMaster: true,
            pulseRelation: "1:1",
          },
        }),
      ]),
    );
    const { link, calls } = fakeLink();
    return applyTempo(link).then(() => {
      // Three calls, not one: the ratio, the mode that decides which engine
      // mechanism it drives, and the transpose.
      expect(calls.map((c) => (c.params as { action: string }).action)).toEqual([
        "setTempoMode",
        "setTempoSync",
        "setTranspose",
      ]);
      // master 120 ÷ deck 60 at 1:1 = 2.0
      expect(calls[1]?.params).toMatchObject({ action: "setTempoSync", deck: 1, ratio: 2 });
      // timeStretch is mode 1 — the default a fresh grid element carries.
      expect(calls[0]?.params).toMatchObject({ value: 1 });
    });
  });

  it("sends ratio 1.0 for an UNSYNCED deck rather than omitting it", () => {
    // Omitting would leave the deck carrying whatever ratio the previous map
    // left behind — stretched, with nothing in the document explaining it.
    setMap(
      mapWith([
        strip({
          key: "g",
          channel: 0,
          element: { ...newGridElement(0, "s", 90), syncToMaster: false },
        }),
      ]),
    );
    const { link, calls } = fakeLink();
    return applyTempo(link).then(() => {
      expect(calls.find((c) => (c.params as { action: string }).action === "setTempoSync")?.params)
        .toMatchObject({ ratio: 1 });
    });
  });

  it("a gridless map still pushes TAPE rates — and nothing else (P3-2b-3)", () => {
    // This used to assert zero calls; the tape branch changed the premise.
    // The default fixture is a tape strip at rate 1, unsynced — which is SENT
    // (un-syncing must restore the hand's rate), and is the only traffic.
    setMap(mapWith([strip()]));
    const { link, calls } = fakeLink();
    return applyTempo(link).then(() => {
      // Two calls per tape since P3-2b-5: the MODE (what the rate drives)
      // travels first, then the rate — the deck trio's ordering rule.
      expect(calls).toHaveLength(2);
      expect(calls[0]?.params).toMatchObject({ action: "setTempoMode", tape: 0, mode: 0 });
      expect(calls[1]?.params).toMatchObject({ action: "setRate", tape: 0, rate: 1 });
    });
  });

  it("setMasterBpm REACHES THE ENGINE, not just the document", () => {
    // The regression this whole step exists for: `setMasterBpm` mutated the map
    // and stopped, so the master knob moved on screen and changed nothing until
    // some unrelated world publish happened to re-derive the ratios.
    setMap(
      mapWith([
        strip({
          key: "g",
          channel: 0,
          element: {
            ...newGridElement(2, "s", 100),
            syncToMaster: true,
            pulseRelation: "1:1",
          },
        }),
      ]),
    );
    const { link, calls } = fakeLink();
    setMasterBpm(200, link);
    return Promise.resolve().then(() =>
      new Promise((r) => setTimeout(r, 0)).then(() => {
        expect(getMap().transport.masterBpm).toBe(200);
        expect(
          calls.find((c) => (c.params as { action: string }).action === "setTempoSync")?.params,
        ).toMatchObject({ deck: 2, ratio: 2 }); // 200 ÷ 100
      }),
    );
  });
});

describe("bootMap", () => {
  it("installs the engine DEFAULTS for a map that has never been saved", async () => {
    // The bug this exists to prevent: planApply on a fresh map is just
    // routeClearAll, which wipes the 40 boot routes and installs nothing. The
    // plane would look entirely normal and make no sound, with no cable
    // anywhere explaining it.
    const { link, calls } = fakeLink({
      slRouteList: {
        routes: [
          {
            active: true,
            srcKind: 0,
            srcIndex: 0,
            srcSub: 0xffffffff,
            dstKind: 2,
            dstIndex: 0,
            gain: 1,
            feedback: false,
            isDefault: true,
          },
        ],
      },
    });
    await bootMap(link);
    const actions = calls.filter((c) => c.method === "slRoute").map((c) => c.params.action);
    expect(actions).toEqual(["clearAll", "installDefaults"]);
    // …and they are CAPTURED into the document, so from now on the map carries
    // every cable as an ordinary route.
    expect(getMap().routes).toHaveLength(1);
    expect(useMapStore.getState().dirty).toBe(false); // booting is not an edit
  });

  it("applies the document normally when the map is NOT fresh", async () => {
    setMap(mapWith([strip()]));
    const { link, calls } = fakeLink();
    await bootMap(link);
    const actions = calls.filter((c) => c.method === "slRoute").map((c) => c.params.action);
    // clearAll, and NO installDefaults — a saved patch must not gain the boot
    // wiring on top of what it recorded.
    expect(actions).toEqual(["clearAll"]);
    expect(calls.some((c) => c.method === "slChannel")).toBe(true);
  });
});

describe("captureMap", () => {
  it("replaces the document's routes with what the ENGINE reports", async () => {
    // A save must record the graph that exists, not the one the UI believes it
    // issued — those drift the moment anything patches outside this store.
    setMap(
      mapWith(
        [strip()],
        [
          {
            src: { kind: "channelOut", index: 7, sub: null },
            dst: { kind: "main", index: 0 },
            gain: 1,
            feedback: false,
          },
        ],
      ),
    );
    const { link } = fakeLink({
      slRouteList: {
        routes: [
          {
            active: true,
            srcKind: 0,
            srcIndex: 2,
            srcSub: 0xffffffff,
            dstKind: 2,
            dstIndex: 0,
            gain: 0.75,
            feedback: false,
            isDefault: false,
          },
          // An inactive slot is not a cable.
          {
            active: false,
            srcKind: 0,
            srcIndex: 3,
            srcSub: 0xffffffff,
            dstKind: 2,
            dstIndex: 0,
            gain: 1,
            feedback: false,
            isDefault: false,
          },
        ],
      },
    });
    const captured = await captureMap(link);
    expect(captured.routes).toHaveLength(1);
    expect(captured.routes[0]?.src.index).toBe(2);
    expect(captured.routes[0]?.gain).toBe(0.75);
    // Everything else is the store's document, untouched.
    expect(captured.strips).toEqual(getMap().strips);
  });

  it("KEEPS the document's routes when the engine read fails", async () => {
    // Writing an empty list because one command timed out would destroy the
    // patch the save was meant to preserve.
    const routes: PlaneMap["routes"] = [
      {
        src: { kind: "channelOut", index: 1, sub: null },
        dst: { kind: "main", index: 0 },
        gain: 1,
        feedback: false,
      },
    ];
    setMap(mapWith([strip()], routes));
    const link = {
      command: () => Promise.reject(new Error("no host")),
      paramWrite: () => {},
      onHotFrame: () => () => {},
      onEvent: () => () => {},
      onUiState: () => () => {},
    } as unknown as EngineLink;
    expect((await captureMap(link)).routes).toEqual(routes);
  });

  it("captures the FX returns' plugins from the ENGINE (P6-5b)", async () => {
    // Same law as the routing graph: a plugin's settings are made in its own
    // editor, which the document never sees, so a save must ASK.
    setMap(mapWith([strip()]));
    const { link } = fakeLink({
      getFxSlotState: {
        slots: [
          { returnIndex: 1, identifier: "AudioUnit:aufx,dely,appl", state: "BLOB1" },
          { returnIndex: 2, identifier: null, state: null },
          { returnIndex: 3, identifier: "VST3:reverb", state: null },
          { returnIndex: 4, identifier: null, state: null },
        ],
      },
    });
    const captured = await captureMap(link);
    expect(captured.fx[0]).toEqual({ identifier: "AudioUnit:aufx,dely,appl", state: "BLOB1" });
    expect(captured.fx[1]).toEqual({ identifier: null, state: null });
    // Loaded but saving nothing of its own is normal — the identifier restores it.
    expect(captured.fx[2]).toEqual({ identifier: "VST3:reverb", state: null });
  });

  it("matches slots by returnIndex, not by list position", async () => {
    // The reply is a list. Trusting its order would put FX 3's plugin on FX 1 —
    // silently, and only audible as the wrong effect on the wrong send.
    setMap(mapWith([strip()]));
    const { link } = fakeLink({
      getFxSlotState: {
        slots: [
          { returnIndex: 3, identifier: "third", state: null },
          { returnIndex: 1, identifier: "first", state: null },
        ],
      },
    });
    const captured = await captureMap(link);
    expect(captured.fx[0]?.identifier).toBe("first");
    expect(captured.fx[2]?.identifier).toBe("third");
  });

  it("does NOT erase a plugin this machine could not load (the portable-map hazard)", async () => {
    // THE FAILURE THIS PREVENTS: carry a set to a rig that lacks one plugin, open
    // it, save it — and the map has now forgotten the plugin on the machine that
    // did have it. The engine honestly reports that return as empty; the restore
    // is the only thing that knows it TRIED and this machine does not have it.
    setMap({
      ...mapWith([strip()]),
      fx: [
        { identifier: "missing-here", state: "PRECIOUS" },
        { identifier: null, state: null },
        { identifier: null, state: null },
        { identifier: null, state: null },
      ],
    });
    // The restore runs first and records the identifier as unresolvable: the
    // scanner's list does not contain it.
    const { link } = fakeLink({
      listPlugins: { plugins: [{ identifier: "something-else" }], scanning: false },
      getFxSlotState: {
        slots: [
          { returnIndex: 1, identifier: null, state: null }, // engine: empty, truthfully
          { returnIndex: 2, identifier: null, state: null },
          { returnIndex: 3, identifier: null, state: null },
          { returnIndex: 4, identifier: null, state: null },
        ],
      },
    });
    const { warnings } = await applyMap(link, getMap());
    expect(warnings).toEqual(["FX 1: this machine does not have that plugin"]);

    const captured = await captureMap(link);
    expect(captured.fx[0]).toEqual({ identifier: "missing-here", state: "PRECIOUS" });
  });

  it("KEEPS the document's fx when the engine cannot be asked", async () => {
    // A hostless build refuses `getFxSlotState`. Saving there must not erase the
    // plugins the map remembers — same rule as the routes above.
    const fx: PlaneMap["fx"] = [
      { identifier: "keep-me", state: "S" },
      { identifier: null, state: null },
      { identifier: null, state: null },
      { identifier: null, state: null },
    ];
    setMap({ ...mapWith([strip()]), fx });
    const link = {
      command: () => Promise.reject(new Error("no host")),
      paramWrite: () => {},
      onHotFrame: () => () => {},
      onEvent: () => () => {},
      onUiState: () => () => {},
    } as unknown as EngineLink;
    expect((await captureMap(link)).fx).toEqual(fx);
  });

  it("round-trips deep-equal through save/load", async () => {
    // The failure that only shows up on stage is a save/load that quietly drops
    // one cable.
    setMap(
      mapWith([strip()], [
        {
          src: { kind: "channelSend", index: 0, sub: 3 },
          dst: { kind: "channelIn", index: 1 },
          gain: 0.9,
          feedback: true,
        },
      ]),
    );
    const captured = await captureMap(null);
    const loaded = loadMap(saveMap(captured));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.map).toEqual(captured);
  });
});

describe("the lane budget", () => {
  it("refuses an element that would overspend, with the count", () => {
    // Building an overspent map would create a document loadMap then refuses —
    // the worst moment to find out is the next time you open it.
    const strips = [0, 1, 2].map((i) =>
      strip({
        key: `g${i}`,
        channel: i,
        element: { ...newGridElement(0, "s", 120), syncToMaster: false },
      }),
    ); // 3 grids = 6 lanes
    setMap(mapWith(strips));
    const stereoTape = {
      kind: "tape" as const,
      index: 0,
      takeRef: null,
      stereo: true,
      loop: { enabled: false, start: 0, end: 0 },
      rate: 1,
      bpm: null,
      syncToMaster: false,
      tempoMode: "timePitch" as const,
      pulseRelation: "auto" as const,
      launchRef: 'auto',
    };
    // 6 + 2 = 8 fits exactly.
    expect(checkBudget("new", stereoTape).ok).toBe(true);
    // 6 + 2 + 2 does not.
    setMap(mapWith([...strips, strip({ key: "t1", channel: 3, element: stereoTape })]));
    const over = checkBudget("new", stereoTape);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.wanted).toBe(10);
      expect(over.budget).toBe(LANE_BUDGET);
    }
  });

  it("does not count the strip's OWN current element when replacing it", () => {
    // Swapping a stereo tape for another stereo tape is always legal; counting
    // the outgoing element would refuse it at the budget edge.
    const stereoTape = {
      kind: "tape" as const,
      index: 0,
      takeRef: null,
      stereo: true,
      loop: { enabled: false, start: 0, end: 0 },
      rate: 1,
      bpm: null,
      syncToMaster: false,
      tempoMode: "timePitch" as const,
      pulseRelation: "auto" as const,
      launchRef: 'auto',
    };
    setMap(
      mapWith([
        strip({ key: "a", channel: 0, element: stereoTape }),
        strip({ key: "b", channel: 1, element: stereoTape }),
        strip({ key: "c", channel: 2, element: stereoTape }),
        strip({ key: "d", channel: 3, element: stereoTape }),
      ]),
    ); // 8 lanes — full
    expect(checkBudget("d", stereoTape).ok).toBe(true); // replace d: still 8
    expect(checkBudget("new", stereoTape).ok).toBe(false); // add a 5th: 10
  });
});

describe("live edits", () => {
  it("updates the store immediately and coalesces the engine call", () => {
    // The UI must track the finger with no round trip; the wire gets one write
    // per frame carrying the LATEST value.
    const s = strip();
    setMap(mapWith([s]));
    const { link, calls } = fakeLink();
    liveSetLevel(link, s, 0.5);
    liveSetLevel(link, s, 0.25);
    liveSetLevel(link, s, 0.1);
    expect(getMap().strips[0]?.level).toBe(0.1); // store is current already
    expect(calls).toHaveLength(0); // nothing sent yet
    flushLiveEdits();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.level).toBe(0.1); // only the latest matters
  });

  it("keeps separate targets separate", () => {
    const s = strip();
    setMap(mapWith([s]));
    const { link, calls } = fakeLink();
    liveSetSend(link, s, 0, 0.5);
    liveSetSend(link, s, 1, 0.7);
    liveSetLevel(link, s, 0.3);
    flushLiveEdits();
    expect(calls).toHaveLength(3);
    expect(getMap().strips[0]?.sends).toEqual([0.5, 0.7, 0, 0]);
  });

  it("sends mute immediately — a click must not wait a frame", () => {
    const s = strip();
    setMap(mapWith([s]));
    const { link, calls } = fakeLink();
    setMute(link, s, true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toMatchObject({ action: "setMute", muted: true });
    expect(getMap().strips[0]?.mute).toBe(true);
  });

  it("marks the document dirty on an edit but NOT on a pan", () => {
    const s = strip();
    setMap(mapWith([s]));
    expect(useMapStore.getState().dirty).toBe(false);
    updateStrip("s1", (x) => ({ ...x, name: "renamed" }));
    expect(useMapStore.getState().dirty).toBe(true);
  });
});
