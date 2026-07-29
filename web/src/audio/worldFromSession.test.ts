/**
 * The session → engine converter, tested against the REAL Swift-written fixture.
 *
 * A hand-built pattern object would prove only that the converter agrees with my idea of the
 * document. The whole risk here is that my idea is wrong — and it was: the document has no `tracks`
 * field at all, it has `sectionA` … `sectionH`, and reading `pattern.tracks` yields `undefined` and
 * an empty world. That is a bug that produces SILENCE, which is exactly what a broken engine
 * produces, and it would have been debugged in the wrong place for a long time. So the fixture is
 * the one Swift actually wrote.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { decodeKit, kitSamples, type KitJson } from "../persist/kit.ts";
import { decodePatternFileAnyVersion } from "../persist/migrations.ts";
import type { PatternFileJson } from "../persist/patternFile.ts";
import { worldFromSession } from "./worldFromSession.ts";

const dir = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/session/${name}`, import.meta.url));

let pattern: PatternFileJson;
let kit: KitJson;

beforeAll(async () => {
  pattern = decodePatternFileAnyVersion(await readFile(dir("session-pattern.json"), "utf8"));
  kit = decodeKit(await readFile(dir("session-kit.json"), "utf8"));
});

/**
 * ⚠️ THE FIXTURE SESSION IS NOT PLAYABLE, and that is worth knowing about rather than working
 * around blindly: its 8 `sectionA` tracks carry **no `sampleId` at all**, and its kit's two samples
 * are referenced by nothing. It was built for P8-0's byte-identity proof, where the track↔sample
 * BINDING never mattered — so it has none.
 *
 * So the fixture is used for what it can honestly attest (the document's real shape, the real field
 * names, the real bpm) and the binding is added here, explicitly, for the tests that need one.
 */
function bindFirstTrack(): PatternFileJson {
  const sampleId = kitSamples(kit)[0]!.id;
  const [first, ...rest] = pattern.sectionA as Record<string, unknown>[];
  return { ...pattern, sectionA: [{ ...first, sampleId }, ...rest] } as PatternFileJson;
}

describe("worldFromSession", () => {
  it("reads sectionA — the LIVE track set — not a `tracks` field that does not exist", () => {
    // The trap, pinned: `pattern.tracks` is undefined, and reading it would yield an EMPTY world —
    // i.e. silence, which is exactly what a broken engine produces. Wrong place to debug.
    expect((pattern as { tracks?: unknown }).tracks).toBeUndefined();
    expect(Array.isArray(pattern.sectionA)).toBe(true);
    expect((pattern.sectionA as unknown[]).length).toBe(8);

    const { world } = worldFromSession(bindFirstTrack(), kit);
    expect(world.tracks.length).toBe(1);
  });

  it("emits the transport verbs ONLY when set — absent means the engine's defaults (P3-M-1b)", () => {
    const clean = worldFromSession(pattern, kit).world;
    expect("beatRepeatActive" in clean).toBe(false);
    expect("reverseTransport" in clean).toBe(false);
    const br = worldFromSession(pattern, kit, {
      beatRepeat: { startStep: 0, length: 2 },
      reverseTransport: true,
    }).world;
    expect(br.beatRepeatActive).toBe(true);
    expect(br.beatRepeatStartStep).toBe(0);
    expect(br.beatRepeatLength).toBe(2);
    // Whole-step windows carry NO subdivision field — 1 is the engine default
    // and writing it would claim a roll that is not happening.
    expect("beatRepeatSubdivision" in br).toBe(false);
    const roll = worldFromSession(pattern, kit, {
      beatRepeat: { startStep: 0, length: 1, subdivision: 8 },
    }).world;
    expect(roll.beatRepeatSubdivision).toBe(8);
  });

  it("carries bpm off the document root", () => {
    const { world } = worldFromSession(pattern, kit);
    expect(world.bpm).toBe(pattern.bpm);
    expect(world.bpm).toBe(120);
  });

  it("emits the document's master stage — and omits fields a pattern does not carry (P3-D4-1a)", () => {
    // The REAL fixture document carries the full block (patternFile requires
    // it), so the world must too — these are the fields the engine's per-deck
    // master render plays, and dropping one silently is the pre-D4-1a bug
    // (a MasterRow the engine never heard).
    const { world } = worldFromSession(pattern, kit);
    const doc = pattern as Record<string, unknown>;
    expect(world.masterVolume).toBe(doc.masterVolume);
    expect(world.masterClipperDrive).toBe(doc.masterClipperDrive);
    expect(world.masterClipperThreshold).toBe(doc.masterClipperThreshold);
    expect(world.masterClipperSoftness).toBe(doc.masterClipperSoftness);
    // A hand-built pattern without the block publishes the engine's DEFAULTS —
    // absent fields, never NaN or an invented number.
    const bare = worldFromSession(
      { ...pattern, masterVolume: undefined, masterClipperDrive: undefined } as unknown as PatternFileJson,
      kit,
    ).world;
    expect("masterVolume" in bare).toBe(false);
    expect("masterClipperDrive" in bare).toBe(false);
  });

  it("only emits tracks whose sample the KIT actually carries", () => {
    const known = new Set(kitSamples(kit).map((s) => s.id));
    const { world } = worldFromSession(bindFirstTrack(), kit);
    expect(world.tracks.length).toBeGreaterThan(0);
    for (const track of world.tracks) {
      expect(known.has(track.sampleId)).toBe(true);
    }
  });

  it("the UNBOUND fixture yields no tracks and no complaints — 8 empty rows", () => {
    const { world, missingSamples, emptyTracks } = worldFromSession(pattern, kit);
    expect(world.tracks).toHaveLength(0);
    expect(missingSamples).toEqual([]);
    expect(emptyTracks).toBe(8);
  });

  it("converts steps to the Uint8Array the worklet copies into the WASM heap", () => {
    const bound = bindFirstTrack();
    const { world } = worldFromSession(bound, kit);
    const track = world.tracks[0]!;
    expect(track.steps).toBeInstanceOf(Uint8Array);

    // Same length, same on/off — the source of truth is the document's own boolean[].
    const doc = (bound.sectionA as { sampleId?: string; steps: boolean[] }[])[0]!;
    expect(track.steps.length).toBe(doc.steps.length);
    expect([...track.steps]).toEqual(doc.steps.map((on) => (on ? 1 : 0)));
  });

  it("REPORTS a track whose sample the kit is missing, instead of dropping it silently", () => {
    const orphaned = {
      ...pattern,
      sectionA: [
        {
          ...(pattern.sectionA as Record<string, unknown>[])[0],
          sampleId: "00000000-0000-0000-0000-000000000000",
        },
      ],
    } as PatternFileJson;

    const { world, missingSamples } = worldFromSession(orphaned, kit);
    // It must not play (there are no bytes for it) AND it must not vanish without a word — a silent
    // track is indistinguishable from a track that was meant to be silent.
    expect(world.tracks).toHaveLength(0);
    expect(missingSamples).toEqual(["00000000-0000-0000-0000-000000000000"]);
  });

  it("folds isStopped into muted — a stopped track must not sound", () => {
    const bound = bindFirstTrack();
    const first = (bound.sectionA as Record<string, unknown>[])[0]!;
    const stopped = {
      ...bound,
      sectionA: [{ ...first, isStopped: true, isMuted: false }],
    } as PatternFileJson;

    const { world } = worldFromSession(stopped, kit);
    // The engine's flat world has no launch gate; ignoring isStopped would make a stopped track
    // audible the moment the session opened in a browser.
    expect(world.tracks[0]!.muted).toBe(true);
  });

  it("a caller-supplied stoppedTracks set OVERRIDES the document's isStopped", () => {
    const bound = bindFirstTrack();
    const first = (bound.sectionA as Record<string, unknown>[])[0]!;
    const stoppedInDoc = {
      ...bound,
      sectionA: [{ ...first, isStopped: true, isMuted: false }],
    } as PatternFileJson;

    // The runtime set says "running" — the user clicked ▶ after opening: the document's flag yields.
    const resumed = worldFromSession(stoppedInDoc, kit, { stoppedTracks: new Set<number>() });
    expect(resumed.world.tracks[0]!.muted).toBe(false);

    // …and the inverse: doc says running, the runtime set stops it (index is the SECTION index).
    const stoppedLive = worldFromSession(bound, kit, { stoppedTracks: new Set([0]) });
    expect(stoppedLive.world.tracks[0]!.muted).toBe(true);

    // Absent option → document behavior, unchanged (every existing caller keeps its semantics).
    const asBefore = worldFromSession(stoppedInDoc, kit);
    expect(asBefore.world.tracks[0]!.muted).toBe(true);
  });
});

/**
 * PARITY — each mapping below mirrors the desktop's engine push (AudioEngineFacade.swift:2107-2268
 * + BeatSequencer.swift:6626-6643) field for field. These were the "sessions sound slightly
 * different in the browser" bugs: wrong stretch gates, unpremultiplied volume, mute on the wrong
 * lane (which silently disabled choke from muted tracks), legacy tune field, unscaled LFO depths.
 */
describe("worldFromSession — desktop parity", () => {
  const first = () => {
    const bound = bindFirstTrack();
    return {
      bound,
      withTrack: (over: Record<string, unknown>) =>
        ({
          ...bound,
          sectionA: [{ ...(bound.sectionA as Record<string, unknown>[])[0], ...over }],
        }) as PatternFileJson,
    };
  };
  const track = (p: PatternFileJson, opts?: Parameters<typeof worldFromSession>[2]) =>
    worldFromSession(p, kit, opts).world.tracks[0]!;

  it("THE MUTE SPLIT: user mute rides mixMuted (gain ramp), never the trigger gate", () => {
    const t = track(first().withTrack({ isMuted: true, isStopped: false }));
    // Desktop: a muted track keeps FIRING at zero gain — that is what keeps it choking its
    // choke-group peers. Folding user mute into `muted` killed the triggers, and ring-outs
    // appeared in the browser that the desktop cuts.
    expect(t.muted).toBe(false);
    expect(t.mixMuted).toBe(true);
  });

  it("solo: peers get mixMuted, the soloed track does not, triggers untouched", () => {
    const { bound } = first();
    const twoTracks = {
      ...bound,
      sectionA: [
        (bound.sectionA as Record<string, unknown>[])[0],
        { ...(bound.sectionA as Record<string, unknown>[])[0], isMuted: false },
      ],
    } as PatternFileJson;
    const { world } = worldFromSession(twoTracks, kit, { soloedTracks: new Set([0]) });
    expect(world.tracks[0]!.mixMuted).toBe(false); // the soloist
    expect(world.tracks[1]!.mixMuted).toBe(true); // the peer, receded
    expect(world.tracks[1]!.muted).toBe(false); // …but still triggering (choke stays alive)
    // No solo active → nothing masked.
    const none = worldFromSession(twoTracks, kit, { soloedTracks: new Set<number>() });
    expect(none.world.tracks[1]!.mixMuted).toBe(false);
  });

  it("isPaused and a non-audio trackType land on the trigger gate", () => {
    expect(track(first().withTrack({ isPaused: true })).muted).toBe(true);
    // SMP off (trackType midiOut): the desktop mutes the sample lane; the world has no trackType
    // key, so without this term the browser played samples the desktop silences.
    expect(track(first().withTrack({ trackType: 1 })).muted).toBe(true);
  });

  it("volume is premultiplied: volume × trackGain × samplePeakGain (Facade:2111)", () => {
    const t = track(first().withTrack({ volume: 0.5, trackGain: 2.0, samplePeakGain: 1.25 }));
    expect(t.volume).toBeCloseTo(0.5 * 2.0 * 1.25);
    expect(t.trackGain).toBe(2.0); // still carried separately — the clipper reads it
  });

  it("useTimeStretch = speedMode==timeStretch, NOT the legacy pitchSyncMode", () => {
    // speedMode 2 (TS) stretches; speedMode 1 (T+P) repitches. pitchSyncMode is the legacy
    // computed "== timeAndPitch" — reading it inverted both modes.
    expect(track(first().withTrack({ speedMode: 2, pitchSyncMode: false })).useTimeStretch).toBe(true);
    expect(track(first().withTrack({ speedMode: 1, pitchSyncMode: true })).useTimeStretch).toBe(false);
  });

  it("stretchEnabled = the REG stretch toggle, NOT isStretchByLength", () => {
    expect(
      track(first().withTrack({ stretchEnabled: true, isStretchByLength: false })).stretchEnabled,
    ).toBe(true);
    expect(
      track(first().withTrack({ stretchEnabled: false, isStretchByLength: true })).stretchEnabled,
    ).toBe(false);
  });

  it("speedMultiplier is gated by mode: timeOnly ×N must NOT repitch", () => {
    expect(track(first().withTrack({ speedMode: 0, speedMultiplier: 2 })).speedMultiplier).toBe(1);
    expect(track(first().withTrack({ speedMode: 1, speedMultiplier: 2 })).speedMultiplier).toBe(2);
    expect(track(first().withTrack({ speedMode: 2, speedMultiplier: 2 })).speedMultiplier).toBe(2);
  });

  it("T+P with the free rate engaged multiplies in |freeRate| (tape pitch)", () => {
    const t = track(
      first().withTrack({
        speedMode: 1,
        speedMultiplier: 2,
        playbackMode: 0,
        freeRateEnabled: true,
        freeRate: -1.5,
      }),
    );
    expect(t.speedMultiplier).toBeCloseTo(2 * 1.5); // magnitude only
    // TS excludes the free rate entirely.
    const ts = track(
      first().withTrack({ speedMode: 2, speedMultiplier: 2, freeRateEnabled: true, freeRate: 1.5 }),
    );
    expect(ts.speedMultiplier).toBe(2);
  });

  it("fineTuneCents comes from globalFineTuneCents, not the legacy field", () => {
    const t = track(first().withTrack({ globalFineTuneCents: 33, fineTuneCents: -99 }));
    expect(t.fineTuneCents).toBe(33);
  });

  it("disableReturnFx renders DRY: send levels zeroed, per-step offsets dropped", () => {
    const p = first().withTrack({
      send1Level: 0.6,
      send3Level: 0.2,
      send2Offsets: [0.5, 0, 0, 0],
    });
    const dry = track(p, { disableReturnFx: true });
    expect(dry.send1Level).toBe(0);
    expect(dry.send3Level).toBe(0);
    expect(dry.send2Offsets).toEqual([]); // an offset on a zeroed base would still send
    // Default (desktop/tests): untouched.
    const wet = track(p);
    expect(wet.send1Level).toBeCloseTo(0.6);
    expect(wet.send2Offsets).toEqual([0.5, 0, 0, 0]);
  });

  it("patternSpeedMultiplier carries the RAW multiplier in every mode (the ratchet)", () => {
    expect(track(first().withTrack({ speedMode: 0, speedMultiplier: 2 })).patternSpeedMultiplier).toBe(2);
    expect(track(first().withTrack({ speedMode: 1, speedMultiplier: 0.5 })).patternSpeedMultiplier).toBe(0.5);
  });

  it("LFO pitch/filter depths are scaled to engine units (×24/×25 defaults)", () => {
    const t = track(
      first().withTrack({
        lfoPitchDepth: 0.5,
        lfoFilterDepth: 0.5,
        lfo3PitchDepth: 1,
        lfo4FilterDepth: 1,
        lfo1ModifierTargets: [],
        lfo1ModifierAmounts: [],
      }),
    );
    expect(t.lfo1PitchDepth).toBeCloseTo(0.5 * 24);
    expect(t.lfo1FilterDepth).toBeCloseTo(0.5 * 25);
    expect(t.lfo3PitchDepth).toBeCloseTo(24);
    expect(t.lfo4FilterDepth).toBeCloseTo(25);
    // An assigned modifier amount replaces the default scale (Facade:2094-2105).
    const custom = track(
      first().withTrack({
        lfoPitchDepth: 0.5,
        lfo1ModifierTargets: [0], // .pitch
        lfo1ModifierAmounts: [12],
      }),
    );
    expect(custom.lfo1PitchDepth).toBeCloseTo(0.5 * 12);
  });
});
