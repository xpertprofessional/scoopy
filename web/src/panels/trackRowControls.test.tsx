import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GridTrackState } from "../../protocol/schema.ts";
import { TrackBand, TrackNameEditor, muteButtonIntent } from "./trackRowControls.tsx";
import { ContextMenu } from "../design/ContextMenu.tsx";
import { getCaps, useCapabilitiesStore } from "../state/capabilitiesStore.ts";

/**
 * Render smoke test: the fat band tree must mount without crashing and print
 * the sourced display formats (volume 103, pitch +14.5, pan R42, gain 1.27).
 * Guards against prop/format regressions since the band can't be clicked here.
 */
const track = (over: Partial<GridTrackState>): GridTrackState =>
  ({
    name: "FM BASS",
    colorHex: "#4488ff",
    trackType: "audio",
    playbackMode: "regular",
    stepCount: 16,
    muted: false,
    soloed: false,
    patternStartStep: null,
    locatorStart: null,
    locatorLength: null,
    steps: Array(16).fill(false),
    cellLengths: Array(16).fill(1),
    wrapSourceStep: null,
    pitchOffsets: [],
    accentLevels: [],
    flamCounts: [],
    glideSteps: [],
    reverseSteps: [],
    preSilenceMsOffsets: [],
    cellChopIndices: [],
    chordIndices: [],
    volumeOffsets: [],
    mixVolumeOffsets: [],
    panOffsets: [],
    toneOffsets: [],
    sampleStartMsOffsets: [],
    sampleEndMsOffsets: [],
    activeCellParameterName: "pitch",
    sampleKey: null,
    sampleDurationMs: 0,
    sampleStartMs: 0,
    sampleEndMs: 0,
    swing: 0,
    globalPitchOffset: 0,
    speedMultiplier: 1,
    rateLockRatio: 1,
    pitchSyncMode: false,
    timeStretchMode: false,
    stretchToCell: false,
    loopEnabled: false,
    loopStartMs: 0,
    loopEndMs: 0,
    chopPointsMs: [],
    defaultChopIndex: -1,
    melodicPitchMode: false,
    isReversed: false,
    preSilenceMs: 0,
    rhythmicOffsetRatios: [],
    renderGain: 1,
    samplePeakGain: 1,
    chopPoints: [],
    chopCount: 1,
    gain: 1,
    volume: 1,
    pan: 0,
    tone: 0,
    toneFilterMode: "tone",
    toneQ: 0.707,
    filterDrive: 0,
    globalFineTuneCents: 0,
    chokeGroup: 0,
    voiceMode: "mono",
    stereoMode: 0,
    send1Level: 0,
    send2Level: 0,
    send3Level: 0,
    send4Level: 0,
    glidePercent: 0,
    freeRate: 1,
    freeRateEnabled: false,
    stretchTimeOnly: false,
    launchScheduled: false,
    isStopped: false,
    playbackDirectionReversed: false,
    ownerAttack: 0,
    ownerGate: 0,
    loopCrossfadeMs: 10,
    locatorStartStep: 0,
    locatorEndStep: 15,
    locatorLengthSteps: 16,
    locatorRepeatActive: false,
    modSlots: [],
    outputAssign: 0,
    tuning: 0,
    muteGroupMember: false,
    instrumentOutEnabled: false,
    midiOutEnabled: false,
    midiRootNote: 60,
    midiGatePercent: 100,
    midiVelocities: [],
    hasInstrument: false,
    instrumentName: null,
    midiInputPinned: false,
    ...over,
  }) as GridTrackState;

const render = (t: GridTrackState) =>
  renderToStaticMarkup(
    <TrackBand t={t} i={0} send={() => {}} optimistic={() => {}} />,
  );

const renderDj = (t: GridTrackState) =>
  renderToStaticMarkup(
    <TrackBand t={t} i={0} send={() => {}} optimistic={() => {}} variant="dj" />,
  );

describe("TrackBand render smoke", () => {
  it("mounts and shows the DSP display formats from the screenshot", () => {
    const html = render(
      track({ gain: 1.27, globalPitchOffset: 29, volume: 1.575, pan: 0.42, chokeGroup: 0 }),
    );
    expect(html).toContain("1.27"); // gain
    expect(html).toContain("+14.5"); // pitch (29 quarter-tones)
    expect(html).toContain("103"); // volume
    expect(html).toContain("R42"); // pan
    expect(html).toContain("OFF"); // choke 0
    expect(html).toContain("GAIN");
    expect(html).toContain("VOLUME");
  });

  it("renders REG/OWN + M/S transport toggles; reversed reads on the rate label", () => {
    const own = render(track({ playbackMode: "owner", playbackDirectionReversed: true, muted: true }));
    expect(own).toContain("OWN");
    // TR-FT-9: the →/← toggle is gone — direction lives on the rate slider's
    // left-side detents; a reversed track shows the ◀-prefixed ratio label.
    expect(own).toContain("◀1:1");
    expect(own).not.toContain("Playback direction");
    // launch shows ▶ when stopped, ■ when playing
    expect(render(track({ isStopped: true }))).toContain("▶");
  });

  // THE THREE OUTPUTS. A track is one pattern driving SMP / INST / MIDI, in any
  // combination — so these tests are about OUTPUTS, not about track "types".
  it("a notes-only track (SMP off, MIDI on) drops the sample controls, keeps its own language", () => {
    const midi = render(track({ trackType: "midi", midiOutEnabled: true }));
    expect(midi).not.toContain("GAIN"); // no audio path to drive
    expect(midi).not.toContain("S4"); // nothing to send
    expect(midi).not.toContain("CHOKE"); // sample-voice architecture
    expect(midi).not.toContain("LOAD"); // no sample lane to load into
    // …but its own language IS there:
    expect(midi).toContain("ROOT"); // the pitch dial, speaking MIDI
    expect(midi).toContain("C3"); // root note 60, as a note name
    expect(midi).toContain("GATE"); // how much of a cell the note sustains
  });

  it("every track shows all three output toggles — they are never exclusive", () => {
    const html = render(track({}));
    expect(html).toContain("SMP");
    expect(html).toContain("INST");
    expect(html).toContain("MIDI");
  });

  it("hard output routing is a one-click toggle in the voice cluster, labelled by state", () => {
    // Was buried in the pan box's right-click menu; now a visible compose-only
    // toggle sitting next to Stereo mode (which it overrides). Label reads the state.
    expect(render(track({ outputAssign: 0 }))).toContain("OUT");
    expect(render(track({ outputAssign: 1 }))).toContain("OUT 1");
    expect(render(track({ outputAssign: 2 }))).toContain("OUT 2");
    // Engaged → latched fill; off → not.
    expect(render(track({ outputAssign: 1 }))).toContain(
      'class="trk-tog on" title="Direct output routing (ignores pan) — click to cycle, right-click to pick" data-focus-id="track/0/outputAssign"',
    );
    expect(render(track({ outputAssign: 0 }))).toContain(
      'class="trk-tog" title="Direct output routing (ignores pan) — click to cycle, right-click to pick" data-focus-id="track/0/outputAssign"',
    );
    // Physical-output routing is a studio decision — compose only, absent in DJ.
    expect(renderDj(track({ outputAssign: 1 }))).not.toContain("track/0/outputAssign");
  });

  it("a track with no instrument still offers the picker (the toggle is not a dead end)", () => {
    const html = render(track({ hasInstrument: false }));
    expect(html).toContain("PLUGIN…"); // the button that opens the instrument window
    // and INST is not "on" — there is nothing to sound yet
    expect(html).not.toContain('data-focus-id="track/0/instout" class="trk-tog on"');
  });

  it("the INSTRUMENT output puts real audio in the mix, so it sends like any track", () => {
    const inst = render(
      track({ trackType: "midi", hasInstrument: true, instrumentOutEnabled: true, instrumentName: "Diva" }),
    );
    expect(inst).toContain("S4"); // the plugin's output runs the same DSP chain
    expect(inst).toContain("Diva"); // the bound plugin names itself
    expect(inst).toContain("ROOT"); // it is fed by notes
    // EDIT lives in the instrument WINDOW, not the row — a plugin picker cannot be an
    // in-page popover (MIX-R8), so the row hands off to the same window shell the FX
    // slots use. The row keeps only what belongs in a row: the three output switches.
  });

  it("a LAYERED track (sample + instrument + MIDI) is a full audio track that also plays notes", () => {
    const both = render(
      track({
        trackType: "audio", // SMP on
        hasInstrument: true,
        instrumentOutEnabled: true, // INST on
        midiOutEnabled: true, // MIDI on
      }),
    );
    expect(both).toContain("PITCH"); // pitches its sample
    expect(both).toContain("ROOT"); // …and names the note it sends
    expect(both).toContain("GAIN"); // still a full audio track
    expect(both).toContain("S4");
  });

  it("switching an output OFF never removes the content behind it", () => {
    // The instrument stays NAMED and pickable with its output off — the binding
    // (and its state) survives; only the sound stops.
    const off = render(
      track({ trackType: "audio", hasInstrument: true, instrumentOutEnabled: false, instrumentName: "Diva" }),
    );
    expect(off).toContain("Diva"); // still bound, still named
    expect(off).toContain("PITCH"); // and the sample side is untouched
  });

  it("filter mode shows the mode short label instead of TONE", () => {
    expect(render(track({ toneFilterMode: "lowPass", tone: -61 }))).toContain("LP");
  });

  // The engine keeps the dedicated filter modes unipolar (clampedToneValue folds
  // the sign away), so a rail reaching below 0 sends values that come back
  // mirrored — the handle snapped to the mirror position on every left-half click.
  const railBefore = (html: string, label: string) =>
    html.match(new RegExp(`<input[^>]*>(?=<span class="ds-geo-label">${label}</span>)`))?.[0] ?? "";

  it("gives the tone rail the engine's range per mode: 0…100 filter, ±100 tone", () => {
    const lp = railBefore(render(track({ toneFilterMode: "lowPass", tone: 61 })), "LP");
    expect(lp).toContain('min="0"');
    expect(lp).toContain('max="100"');

    const tone = railBefore(render(track({ toneFilterMode: "tone", tone: -61 })), "TONE");
    expect(tone).toContain('min="-100"');
  });

  it("shows a filter-mode rail at the value the engine actually holds", () => {
    // A negative tone carried in from a legacy session reads as its magnitude,
    // matching the box (formatTone) and the native slider (abs(track.tone)).
    expect(railBefore(render(track({ toneFilterMode: "lowPass", tone: -61 })), "LP")).toContain(
      'value="61"',
    );
    // …and 0 parks the handle at the rail's floor, not halfway along it.
    expect(railBefore(render(track({ toneFilterMode: "lowPass", tone: 0 })), "LP")).toContain(
      'value="0"',
    );
  });

  it("renders the P5-PCE dial chips leading the cell-tools row", () => {
    const html = render(
      track({
        activeCellParameterName: "tone",
        panOffsets: Object.assign(Array(16).fill(0), { 7: -0.3 }),
      }),
    );
    for (const chip of ["PIT", "TON", "PAN", "VOL", "STA", "END"]) {
      expect(html).toContain(chip);
    }
    expect(html).toContain('trk-chip on"'); // armed param = accent chip (tone)
    expect(html).toContain("trk-chip-dot"); // pan carries per-cell data → dot
  });

  it("renders the cell-tools row with live counts + speed/locator", () => {
    const html = render(
      track({
        accentLevels: [1, 0, 2],
        glideSteps: [true, true, false],
        flamCounts: [1, 3, 1],
        glidePercent: 40,
        speedMultiplier: 2 / 3,
        locatorStartStep: 4,
        locatorEndStep: 15,
        locatorLengthSteps: 8,
      }),
    );
    expect(html).toContain("»2"); // 2 accented cells
    expect(html).toContain("↝2"); // 2 glide cells
    expect(html).toContain("×1"); // 1 flam>1 cell
    expect(html).toContain("40%"); // glide length
    expect(html).toContain("2:3"); // speed ratio
    expect(html).toContain("⌊"); // locator bracket
    expect(html).toContain("5"); // locator start (0-based 4 → display 5)
  });

  it("the locator loop toggle and the rate reset are visually distinct (user: too alike)", () => {
    const html = render(track({ rateLockRatio: 1, speedMultiplier: 2 }));
    // Locator repeat carries the `locator` tone (--warn, its bracket colour) and
    // the ↻ loop; the rate reset stays neutral with a mirrored ⟲ — different on
    // BOTH colour and arrow direction, so they never read as the same button.
    expect(html).toMatch(/class="trk-tog[^"]*\blocator\b[^"]*"[^>]*>↻</);
    expect(html).toMatch(/class="trk-tog(?![^"]*\blocator\b)[^"]*"[^>]*>⟲</);
  });

  it("renders the trim bar (S/E boxes + waveform) only with a sample", () => {
    expect(render(track({ sampleKey: null }))).not.toContain("trk-trim-wave");
    const withSample = render(
      track({ sampleKey: "abc", sampleDurationMs: 1000, sampleStartMs: 0, sampleEndMs: 745 }),
    );
    expect(withSample).toContain("trk-trim-wave");
    expect(withSample).toContain("745"); // E box (matches the reference screenshot)
  });

  it("unified rate control: detent label, free tape label, present in every mode", () => {
    // Detent domain (freeRate disengaged) → ratio label + detent ticks.
    const detent = render(track({ speedMultiplier: 2, freeRate: 1 }));
    expect(detent).toContain("trk-rate");
    expect(detent).toContain("2:1");
    expect(detent).toContain("trk-ratetick unity");
    // Free domain → tape label of the effective (product) rate.
    const free = render(track({ speedMultiplier: 1, freeRate: 2.5, freeRateEnabled: true }));
    expect(free).toContain("▶×2.50");
    // TR-FT-9: the merged control stays rendered (detent-only) in TS and OWN,
    // where the old free-rate cluster was hidden entirely.
    expect(render(track({ timeStretchMode: true }))).toContain("trk-rate");
    expect(render(track({ playbackMode: "owner" }))).toContain("trk-rate");
    // TR-FT-14: anchor numerals (×1/2/4/8/16 both sides) map the log scale,
    // and the extended table renders detent labels above 4:1.
    expect(detent).toContain("trk-ratenum");
    expect(detent).toContain(">16<");
    expect(render(track({ speedMultiplier: 12 }))).toContain("12:1");
    expect(render(track({ speedMultiplier: 1.25 }))).toContain("5:4");
  });

  it("mod slots render only for mapped routings (data-driven)", () => {
    expect(render(track({ modSlots: [] }))).not.toContain("M1·");
    const mapped = render(
      track({
        modSlots: [
          { channelIndex: 0, target: "pitch", targetShort: "P", depth: 0.5 },
          { channelIndex: 2, target: "filter", targetShort: "F", depth: -0.25 },
        ],
      }),
    );
    expect(mapped).toContain("M1·P"); // channel 0 → M1
    expect(mapped).toContain("M3·F"); // channel 2 → M3
    expect(mapped).toContain("50"); // depth 0.5 → 50
    expect(mapped).toContain("-25"); // bipolar negative depth
  });

  it("LOAD button renders in the browse group; name editor shows the name", () => {
    expect(render(track({}))).toContain("LOAD");
    const name = renderToStaticMarkup(
      <TrackNameEditor name="FM BASS 1" trackIndex={0} colorHex="#7ec8ff" send={() => {}} />,
    );
    expect(name).toContain("FM BASS 1");
    expect(name).toContain("trk-name"); // display state (input only after dbl-click)
  });

  it("context menu renders items, separators and check marks", () => {
    const html = renderToStaticMarkup(
      <ContextMenu
        x={10}
        y={20}
        onClose={() => {}}
        items={[
          { kind: "item", label: "Clear per-cell pan", onSelect: () => {} },
          { kind: "sep" },
          { kind: "item", label: "Output 1", checked: true, onSelect: () => {} },
        ]}
      />,
    );
    expect(html).toContain("Clear per-cell pan");
    expect(html).toContain("Output 1");
    expect(html).toContain("✓"); // checked item
    expect(html).toContain("ds-menu-sep");
  });

  it("OWN attack/gate + loop boxes ride the sample-window (trim) row (TR-FT-4)", () => {
    // Mode boxes moved into the trim row → only render with a sample.
    const own = render(
      track({ playbackMode: "owner", ownerAttack: 25, ownerGate: 0, sampleKey: "abc", sampleDurationMs: 1000 }),
    );
    expect(own).toContain("Atk");
    expect(own).toContain("Rel");
    expect(own).toContain("100%"); // gate 0 → displays 100%
    const loop = render(
      track({
        playbackMode: "regular",
        loopEnabled: true,
        loopCrossfadeMs: 12,
        sampleKey: "abc",
        sampleDurationMs: 1000,
      }),
    );
    expect(loop).toContain("Ls");
    expect(loop).toContain("Lx");
    // No sample → no window boxes (trim row hidden).
    expect(render(track({ playbackMode: "owner", ownerAttack: 25 }))).not.toContain("Atk");
  });

  it("header row is signal-flow order: name · browse · LOAD · M · S · mode", () => {
    const html = render(track({ name: "KICK", sampleKey: "abc", sampleDurationMs: 500 }));
    // name precedes LOAD precedes M/S precedes the REG/OWN mode toggle
    const iName = html.indexOf("KICK");
    const iLoad = html.indexOf(">LOAD<");
    const iMute = html.indexOf('title="Mute'); // CM-5 appended "(right-click: mute group)"
    const iMode = html.indexOf('title="Playback mode');
    expect(iName).toBeGreaterThanOrEqual(0);
    expect(iName).toBeLessThan(iLoad);
    expect(iLoad).toBeLessThan(iMute);
    expect(iMute).toBeLessThan(iMode);
  });

  it("TR-FT-6 row order: PATTERN row comes first, then identity, then sample", () => {
    const html = render(track({ name: "KICK", sampleKey: "abc", sampleDurationMs: 500 }));
    const iPattern = html.indexOf('data-focus-id="track/0/launch"'); // pattern row
    const iName = html.indexOf("KICK"); // identity row
    const iTrim = html.indexOf("trk-trim-wave"); // sample-window controls
    expect(iPattern).toBeGreaterThanOrEqual(0);
    expect(iPattern).toBeLessThan(iName); // pattern sits directly below the grid
    expect(iName).toBeLessThan(iTrim); // sample/audio follows
  });

  it("TR-FT-7: the trim bar rides the IDENTITY row (no row of its own)", () => {
    const html = render(track({ name: "KICK", sampleKey: "abc", sampleDurationMs: 500 }));
    // The waveform must sit inside the same .trk-ctrl-row as the name — i.e.
    // no row-closing </div> between the name and the waveform.
    const iName = html.indexOf("KICK");
    const iTrim = html.indexOf("trk-trim-wave");
    const between = html.slice(iName, iTrim);
    expect(between).not.toContain('<div class="trk-ctrl-row'); // no new row opened
    expect(html).not.toContain('class="trk-trim"'); // the old wrapper row is gone
  });

  it("chop chrome renders ONLY while the chopper is toggled on (TR-FT-10)", () => {
    const on = render(
      track({
        playbackMode: "owner",
        sampleKey: "abc",
        sampleDurationMs: 1000,
        chopPointsMs: [250, 500, 750],
        defaultChopIndex: 1,
      }),
    );
    expect(on).toContain("CH"); // segment-select box
    expect(on).toContain("÷"); // slice-count box (setChopCount)
    expect(on).toContain("Chop — select"); // per-cell chop tool in the pattern row
    expect(on).toContain("trk-trim-wave"); // waveform present for segment clicks

    // Chopper OFF (defaultChopIndex −1): same resolved points in the payload,
    // but the row shows no chop chrome — engine parity (cellChopIndices and
    // segments are inert while the chopper is off).
    const off = render(
      track({
        playbackMode: "owner",
        sampleKey: "abc",
        sampleDurationMs: 1000,
        chopPointsMs: [250, 500, 750],
        defaultChopIndex: -1,
      }),
    );
    expect(off).not.toContain("÷");
    expect(off).not.toContain("Chop — select");
  });

  it("chord tool renders beside the other cell tools and counts voiced cells (TR-4f)", () => {
    // Unlike chop, chord is not gated on a mode — any audio track can voice a cell.
    const none = render(track({ chordIndices: Array(16).fill(0) }));
    expect(none).toContain("Chord — select");
    expect(none).toContain("Chd"); // no chords yet

    const some = render(
      track({ chordIndices: Object.assign(Array(16).fill(0), { 0: 4, 7: 1 }) }),
    );
    expect(some).toContain("♪2");

    // Armed → the chip carries the active accent state (same idiom as Acc/Gld/Fl).
    const armed = render(
      track({ activeCellParameterName: "chord", chordIndices: Array(16).fill(0) }),
    );
    expect(armed).toMatch(/trk-celltool on accent[^>]*>\s*Chd/);
  });
});

// TR-FT-12: every cursor-world control renders data-focus-id; DOCUMENT order
// == visual order is the band's traversal contract (bandNav queries the DOM,
// never the registry's mount order), so this sequence is pinned here.
describe("TR-FT-12 cursor-world focus ids", () => {
  const extractIds = (html: string) =>
    [...html.matchAll(/data-focus-id="([^"]+)"/g)].map((m) => m[1]!);

  it("band controls expose data-focus-id in visual order", () => {
    const ids = extractIds(render(track({ sampleKey: "abc", sampleDurationMs: 500 })));
    // Pattern row leads (launch → STEP → locator → rate → chips/tools),
    // identity row follows (M/S/mode), then DSP, then sends.
    expect(ids[0]).toBe("track/0/launch");
    const order = [
      "track/0/launch",
      "track/0/steps",
      "track/0/locrepeat",
      "track/0/rate",
      "track/0/chip/pitch",
      "track/0/tool/accent",
      "track/0/mute",
      "track/0/solo",
      "track/0/mode",
      "track/0/gain",
      "track/0/volume",
      "track/0/send1",
      "track/0/send4",
    ];
    for (const id of order) expect(ids).toContain(id);
    for (let k = 1; k < order.length; k++) {
      expect(ids.indexOf(order[k - 1]!)).toBeLessThan(ids.indexOf(order[k]!));
    }
  });

  it("toggles carry the focused ring class only when armed (none in SSR)", () => {
    const html = render(track({}));
    expect(html).not.toContain("trk-tog focused");
  });

  it("conditional controls join and leave the id space with their mount", () => {
    const chopTrack = (defaultChopIndex: number) =>
      track({
        playbackMode: "owner",
        sampleKey: "abc",
        sampleDurationMs: 1000,
        chopPointsMs: [250, 500],
        defaultChopIndex,
      });
    expect(extractIds(render(chopTrack(-1)))).not.toContain("track/0/tool/chop");
    expect(extractIds(render(chopTrack(1)))).toContain("track/0/tool/chop");
  });
});

describe("TrackBand — DJ variant (performance row)", () => {
  const t = () =>
    track({
      name: "FM BASS",
      sampleKey: "s1",
      modSlots: [{ channelIndex: 0, target: "pitch", targetShort: "P", depth: 0.5 }],
    });

  it("keeps the four performance rows: play/steps/rate/locator, DSP, mods, sends", () => {
    const html = renderDj(t());
    // Row 1 — launch, step count, locator, unified rate (multiply ⊕ free tape rate)
    expect(html).toContain('data-focus-id="track/0/launch"');
    expect(html).toContain("STEP");
    expect(html).toContain("Locator repeat");
    // Row 2 — gain · pitch · filter · pan · volume
    expect(html).toContain("GAIN");
    expect(html).toContain("PITCH");
    expect(html).toContain("TONE");
    expect(html).toContain("PAN");
    expect(html).toContain("VOLUME");
    // Rows 3/4 — modifier sliders, send sliders
    expect(html).toContain("M1·P"); // mapped mod slot (channel 0 → M1, pitch)
    expect(html).toContain("S1");
    expect(html).toContain("S4");
  });

  it("keeps name + mute/solo on the name line", () => {
    const html = renderDj(t());
    expect(html).toContain("trk-dj-name");
    expect(html).toContain("FM BASS");
    expect(html).toContain('title="Mute');
    expect(html).toContain('title="Solo"');
  });

  it("orders rows like compose: pattern row FIRST, name line second", () => {
    const html = renderDj(t());
    expect(html.indexOf('data-focus-id="track/0/launch"')).toBeLessThan(
      html.indexOf("trk-dj-name"),
    );
  });

  it("puts the trim bar on the name line — S/E as a live performance surface", () => {
    const html = renderDj(t());
    expect(html).toContain("trk-trim-wave");
    expect(html).toContain('id="track/0/sstart"');
    expect(html).toContain('id="track/0/send"');
    // …but COMPACT: the mode-dependent window boxes stay sound design.
    // OWN track → compose shows Atk/Rel on the trim row, DJ must not.
    const own = renderDj(track({ sampleKey: "s1", playbackMode: "owner" }));
    expect(own).toContain("trk-trim-wave");
    expect(own).not.toContain('id="track/0/ownatk"');
    const loop = renderDj(track({ sampleKey: "s1", loopEnabled: true }));
    expect(loop).not.toContain('id="track/0/loopstart"');
    // No sample loaded → no bar (same gate as compose).
    expect(renderDj(track({ sampleKey: null }))).not.toContain("trk-trim-wave");
  });

  it("drops the sound-design controls the DJ row has no room for", () => {
    const html = renderDj(t());
    // sample browse / LOAD, sub-mode toggles
    expect(html).not.toContain("Load sample");
    expect(html).not.toContain("Next sample");
    // per-cell chips + mark tools (accent/glide/flam/chord), swing/pre-silence
    expect(html).not.toContain("trk-celltool");
    expect(html).not.toContain("Accent — select");
    // voice architecture: choke group / mono-poly / stereo mode
    expect(html).not.toContain("CHOKE");
    expect(html).not.toContain("Voice mode");
    expect(html).not.toContain("Stereo mode");
  });

  it("leaves the COMPOSE row untouched — the drops are DJ-only", () => {
    const html = render(t());
    expect(html).toContain("Load sample");
    expect(html).toContain("CHOKE");
    expect(html).toContain("trk-celltool");
    expect(html).toContain('title="Mute'); // still there, on the identity row
    expect(html).not.toContain("trk-dj-name");
  });
});

/**
 * P8-9 — capability gating. Under narrowed caps (the browser companion's
 * answer) the native-only controls disappear from an UNBOUND track and turn
 * into inert "desktop" badges on a BOUND one — a silent track must explain
 * itself. Under default (full) caps, nothing changes: that is the desktop
 * path, pinned by every other test in this file.
 */
describe("capability gating (P8-9)", () => {
  const narrow = () =>
    useCapabilitiesStore.setState({
      caps: {
        ...getCaps(),
        pluginHosting: false,
        midiHardware: false,
        audioDeviceSelection: false,
        returnFx: false,
      },
    });
  afterEach(() =>
    useCapabilitiesStore.setState({
      caps: {
        ...getCaps(),
        pluginHosting: true,
        midiHardware: true,
        audioDeviceSelection: true,
        returnFx: true,
      },
    }),
  );

  it("unbound track: INST/PLUGIN/MIDI vanish entirely (no dead buttons)", () => {
    narrow();
    const html = render(track({}));
    expect(html).not.toContain("INST");
    expect(html).not.toContain("PLUGIN…");
    expect(html).not.toContain(">MIDI");
    expect(html).not.toContain("trk-desktop-badge");
    expect(html).toContain("SMP"); // the sample output still works here
  });

  it("bound instrument: an inert desktop badge, never a clickable toggle", () => {
    narrow();
    const html = render(
      track({ hasInstrument: true, instrumentOutEnabled: true, instrumentName: "Diva" }),
    );
    expect(html).toContain("trk-desktop-badge");
    expect(html).toContain("INST");
    expect(html).not.toContain("PLUGIN…"); // no picker on a host that can't host
    expect(html).not.toContain('data-focus-id="track/0/instout"'); // out of the cursor world
    expect(html).toContain("preserved in the file"); // the badge explains the silence
  });

  it("bound MIDI out: badge instead of toggle", () => {
    narrow();
    const html = render(track({ midiOutEnabled: true }));
    expect(html).toContain("trk-desktop-badge");
    expect(html).toContain("MIDI");
    expect(html).not.toContain('data-focus-id="track/0/midiout"');
  });

  it("output assign: hidden at 0, badged when routed", () => {
    narrow();
    expect(render(track({ outputAssign: 0 }))).not.toContain("track/0/outputAssign");
    const routed = render(track({ outputAssign: 1 }));
    expect(routed).not.toContain("track/0/outputAssign");
    expect(routed).toContain("trk-desktop-badge");
    expect(routed).toContain("OUT 1");
  });

  it("no return FX: the sends row is gone entirely (no dead sends into default returns)", () => {
    narrow();
    const html = render(track({}));
    expect(html).not.toContain("track/0/send1");
    expect(html).not.toContain(">S4<");
    expect(html).toContain("GAIN"); // the DSP row above it is untouched
  });

  it("full caps (the default): the row renders every control, no badges", () => {
    const html = render(
      track({ hasInstrument: true, instrumentOutEnabled: true, instrumentName: "Diva", outputAssign: 1 }),
    );
    expect(html).toContain('data-focus-id="track/0/instout"');
    expect(html).toContain('data-focus-id="track/0/midiout"');
    expect(html).toContain('data-focus-id="track/0/outputAssign"');
    expect(html).not.toContain("trk-desktop-badge");
  });
});

/**
 * CM-5: the M button's mute-GROUP menu. The label is the INVERSE of current
 * membership — native's single toggle item (ContentView:3761/:4038), not two.
 */
describe("mute group (CM-5)", () => {
  it("offers Add when the track is not a member", () => {
    const html = render(track({ muteGroupMember: false }));
    expect(html).toContain('title="Mute (right-click: mute group)"');
  });

  it("names the mute-group state on the M button in both variants", () => {
    // The menu itself only exists on right-click (no DOM here), but the button
    // must advertise it — a hidden menu nobody can find is the bug we fixed.
    expect(renderDj(track({}))).toContain("right-click: mute group");
  });
});

/**
 * CM-5b: the two halves of "applying a track to a mute group" that were missing.
 *
 * The group was unbuildable from the web: M always sent `toggleMute` (so the LATCHED
 * gesture — the one that actually adds tracks — did nothing), and membership was
 * invisible (the row drew no mark, and Swift never even re-pushed the flag).
 */
describe("mute group latch + membership (CM-5b)", () => {
  it("unlatched: M mutes the track, exactly as before", () => {
    expect(muteButtonIntent({ muted: false, muteGroupMember: false }, 3, false)).toEqual({
      op: "toggleMute",
      trackIndex: 3,
      muted: true,
    });
  });

  it("LATCHED: M edits membership instead of muting (native ContentView:3349)", () => {
    expect(muteButtonIntent({ muted: false, muteGroupMember: false }, 3, true)).toEqual({
      op: "toggleMuteGroup",
      trackIndex: 3,
      muted: true, // joining a live group silences the track on the spot
    });
  });

  it("LATCHED: M on a member REMOVES it, and that unmutes it", () => {
    expect(muteButtonIntent({ muted: true, muteGroupMember: true }, 0, true)).toEqual({
      op: "toggleMuteGroup",
      trackIndex: 0,
      muted: false,
    });
  });

  it("latched echo follows MEMBERSHIP, not the stale mute flag", () => {
    // A member reading `muted: false` still leaves the group silent-side: the echo
    // must come off membership or the strip would flash the wrong way.
    expect(muteButtonIntent({ muted: false, muteGroupMember: true }, 1, true).muted).toBe(false);
  });

  it("marks members with a ring, and does NOT light the button (member ≠ muted)", () => {
    const html = render(track({ muteGroupMember: true, muted: false }));
    expect(html).toContain("member");
    expect(html).not.toContain("trk-tog on mute"); // the fill still means muted
  });

  it("brightens the ring while the group is latched", () => {
    const latched = renderToStaticMarkup(
      <TrackBand
        t={track({ muteGroupMember: true })}
        i={0}
        send={() => {}}
        optimistic={() => {}}
        muteGroupActive
      />,
    );
    expect(latched).toContain("member-armed");
    expect(latched).toContain("Mute group ACTIVE");
    // Unlatched members are marked but not armed.
    expect(render(track({ muteGroupMember: true }))).not.toContain("member-armed");
  });

  it("non-members carry no ring", () => {
    expect(render(track({ muteGroupMember: false }))).not.toContain("member");
  });
});

/** CM-5: the track name's reset menu (native EditableTrackNameLabel:1033). */
describe("track name menu (CM-5)", () => {
  it("advertises the right-click reset on the name", () => {
    const html = renderToStaticMarkup(
      <TrackNameEditor name="FM BASS 1" trackIndex={0} colorHex="#7ec8ff" send={() => {}} />,
    );
    expect(html).toContain("right-click: reset to the derived name");
  });
});

// NK-3: the note-input LOCK (label `IN`). It lives beside mute/solo because it is
// the same kind of control — one you hit mid-set without looking — and it is the
// answer to "why is my MIDI keyboard playing the wrong track?".
describe("note-input lock (IN)", () => {
  it("renders on the row, unlit by default", () => {
    const html = render(track({}));
    expect(html).toContain(">IN<");
    expect(html).toContain("Lock note input to this track");
  });

  // No pictographs on the row: `IN` is mono caps beside M and S, and it is the
  // name SwiftUI's own per-track menu already uses for the same field.
  it("uses a text label, never an icon", () => {
    expect(render(track({ midiInputPinned: true }))).not.toContain("📌");
  });

  it("lights with the `pin` tone when the track is locked", () => {
    const html = render(track({ midiInputPinned: true }));
    // `on pin` is what paints it --signal — deliberately NOT the mute (--warn) or
    // solo (--accent) tone: this routes INPUT, it does not change what you hear.
    expect(html).toContain("trk-tog on pin");
    expect(html).toContain("Note input LOCKED to this track");
  });

  it("offers the lock on the DJ row too — it exists FOR the DJ case", () => {
    // Playing deck A's track while your hands are on deck B is the whole feature,
    // so the control has to be reachable from the deck strip, not just compose.
    expect(renderDj(track({ midiInputPinned: true }))).toContain("trk-tog on pin");
  });
});

describe("C3 — the ⌘-click multi-track selection must be VISIBLE", () => {
  // Six ops fan out across this selection in the engine (setStepCount, cyclePlaybackMode,
  // toggleDirection, toggleLocatorRepeat, setOutputAssign, setTuning). Before C3 the web could
  // neither set it NOR see it — so a selection left over from the native rows or a DJ deck was
  // invisible here, and changing STEP would silently rewrite tracks the user never touched.
  // The ring is not decoration; it is the only thing standing between the user and that.
  it("marks a selected track's name, and leaves an unselected one unmarked", () => {
    const on = renderToStaticMarkup(
      <TrackNameEditor name="KICK" trackIndex={0} colorHex="#4488ff" send={() => {}} selected />,
    );
    const off = renderToStaticMarkup(
      <TrackNameEditor name="KICK" trackIndex={0} colorHex="#4488ff" send={() => {}} />,
    );
    expect(on).toContain('class="trk-name sel"');
    expect(off).toContain('class="trk-name"'); // the CLASS, not the word — the tooltip says "selected"
    expect(off).not.toContain('class="trk-name sel"');
  });

  it("says in the tooltip what the selection DOES (it is not a highlight)", () => {
    const html = renderToStaticMarkup(
      <TrackNameEditor name="KICK" trackIndex={0} colorHex="#4488ff" send={() => {}} />,
    );
    expect(html).toContain("⌘-click");
    expect(html).toContain("every selected track");
  });
});
