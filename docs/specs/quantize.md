# Quantize — launch, scenes, and the looper's cycle

**Written 2026-07-30** for P11-3, from two measurements: the donor
(`ScoopyLoops/`, which is compiled directly into the merged app, so its
behaviour is still live) and the merged tree at HEAD.

The headline is not what the ledger assumed. **The quantized-launch engine
already exists, is sample-exact, and has zero callers.** P11-3 is a wiring row,
not an algorithm row. But it cannot be gated in the real host until a separate,
currently-broken callback is fixed — and that break is already costing a
shipped feature.

---

## 0. The three things to know before designing anything

1. **There is no bar, and there is no master clock.** The engine counts
   **steps** (1/16 notes) at each deck's *own* BPM, and the musically meaningful
   unit is the pattern **LCM cycle**, which is usually not 16 steps.
   `sl_engine.h:149-152` is explicit: master bpm "is the HOST's, carried to each
   deck as the ratio". Grepping the donor for `bar` / `timeSignature` returns
   prose comments only.
2. **The launch quantum takes a REFERENCE DECK as a required argument.**
   `requestQuantizedLaunch(deck, refDeck, quantizeSteps)` —
   `NativeAudioEngineCore.hpp:1547`. There is no global grid to fall back on, so
   the original made "aligned to *what*" a caller's decision. With one strip per
   deck and a BPM each, the merged UI cannot dodge this question.
3. **The looper is not the donor's.** ScoopyLoops has no looper, no recorder and
   no overdub — its "tape" is a DJ reverse-hold effect. So there is no proven
   implementation to copy for loop-cycle quantization. Everything below about
   loopers is a design proposal, not a port.

---

## 1. What the donor actually does (proven, and live in our binary)

```cpp
struct QuantizedLaunchCommand {
    std::uint16_t quantizeSteps = 1;  // boundary granularity in STEPS; "cycle" = pass the LCM
    std::uint8_t  refDeck = 0;        // whose grid the boundary is measured on
    std::uint8_t  armed = 0;
};                                    // NativeAudioEngineCore.hpp:1095-1101
```

**Boundary maths** (`.cpp:2498-2521`), and the conversion is the whole trick:

```
B          = next multiple of N at or ahead of masterStep   (cycle-relative, not clock-relative)
srcUntil   = (B - masterStep) * framesPerStep - stepFrame   (reference deck's SOURCE frames)
outUntil   = srcUntil * busRatio[refDeck]                   (shared OUTPUT frames)
leadIn     = outUntil / busRatio[armedDeck]                 (armed deck's SOURCE frames)
```

Three time domains. Decks run their patterns at their own tempo and are
stretched into agreement, so only the *output* frame is common currency — which
is exactly why a naive "next bar" computed in the UI would be wrong.

`launchLeadInFrames` then counts down **per output frame without advancing the
transport** (`.cpp:7649-7661`), so step 0 lands on the exact output sample, not
the next buffer boundary.

**Guarantees worth keeping:**

- Sample-exact alignment; a held deck is loaded, silent, and its **stretcher
  stays warm**, so release has no attack latency (`hpp:1018-1024`).
- Boundaries are **cycle-relative** — counted from `patternAnchorStep`, so a
  scene switch that moves the anchor re-bases the grid.
- It waits an **extra block** rather than aligning to a grid that is about to
  move (a scene switch in flight on the reference), `.cpp:2483-2491`.
- `launchFiredSequence(deck)` increments on fire, so a UI's pending indicator
  clears on **audio actually starting**, not on a timer.

**Sharp edges, all of which the UI must cover:**

- `armed == 0` holds the deck **silent indefinitely**. A real hang mode.
- Arming against a stopped deck, or against itself, **fires immediately** —
  it degrades to unquantized *silently*.
- Two decks quantized against *different* references will not agree with each
  other. There is no global downbeat to rescue them.

**The donor's UI scale was `off · 1 · 2 · 4 · 8 · 16 · cycle`** (steps, plus the
LCM), preserved verbatim in `TransportPanel.tsx:313`, default `cycle`.

> ⚠️ **P11-3 says "¼ · 1 · 2 · 4 bars". That scale does not exist in the proven
> implementation.** Adopting it means inventing a bar the engine has never had.
> Recommendation: keep the donor's scale and label it musically (1/16 · 1/8 ·
> beat · half · bar · cycle), so the numbers on screen are the numbers the ABI
> takes. A "bar" that is 16 steps by arithmetic only, sitting next to a `cycle`
> that is the real musical unit, is a lie waiting to be believed.

---

## 2. What the merged tree has (measured at HEAD)

**Live:**

- `scheduledScene` + `switchBoundaryStep` (`companionEngine.ts:809-849`), armed
  on `lcm(activeLCM, targetLCM)` steps. Reachable from the plane's grid-strip pads.
- Immediate scene switch (⌘/⌥-click) → `publish()` → `slWorld`.
- `playheadStepDeck0/1/2` in the HotFrame (`sl_engine.cpp:1417-1419`).
- The whole tape loop-region chain, in **frames**.
- Tape tempo *inference*: `bpmAtStart` stamp → sidecar → `inferTapeBpm` →
  `element.bpm` → `djSyncLaw` → `sl_tape_set_rate`.

**Declared and answered by nobody** — add these to the tree's growing list:

| surface | why it is dead |
|---|---|
| `deckQuantizePending` | writer is a hardcoded `boolArray(3, false)` (`SlDispatch.cpp:1139`); sole reader sits behind a door `panelMenu.test.ts:19` asserts is absent |
| `launchQuantize` + the whole `dj` topic | `djSetting` has zero handlers; nothing publishes `dj`. Already named "the inert launchQuantize picker" in-tree |
| `patternScene` (every op), `scenes/<d>` topic | no handler, no publisher — so `ScenePads`, the SCN latch, and `SceneUiState.queued/loopEnabled/latched` render nothing |
| `lcmPosDeck*` / `lcmLenDeck*` HotFrame slots | no writer; `deckTile.tsx:190-196` says so and recomputes web-side |

> ⚠️ **P11-3's stated premise is falsified.** It cites `deckQuantizePending` as
> evidence "the concept is the engine's". It is a zod-satisfying constant in the
> merged shell. The engine concept exists — but in `ScoopyLoops/`, unreachable,
> because `slengine`'s C ABI never exposed it and `sl_engine.cpp:1234` hardcodes
> `d.launchArmed = false` on every publish.

**Entirely missing:** any quantum value in the merged ABI; any master musical
transport (SL-ABI-V3 §7, deferred); any bar or beat phase on the wire; any
quantized capture (`sl_tape_record_start_quantized`, spec'd and "NOT BUILT");
any cycle concept in the tape layer; any loop-length snapping.

---

## 3. The blocker under all of it

**`NativeWorldSink.positionCbs` is written to and never invoked.**
`nativeAudio.ts:61` declares it, `:190` adds, `:191` deletes — and nothing
iterates. `ScoopyAudio` fans out at `scoopyAudio.ts:274`; the native sink does not.

So in **WizardMerged**: press a scene pad on a playing grid strip → the pad
lights `queued` → **and stays queued forever.** The scene never switches. Escapes
are ⌘-click, clicking the active pad, or stop/play.

This is a defect against **shipped P3-U8**, in the same class as P11-0, and it is
green in Chromium and in every vitest — the four rules exactly.

**It must land before P11-3.** A launch quantum layered on a scheduler that never
runs would make the app worse while its fixture went green. Row: **P11-3a**.

(Second defect in the same file: `nativeAudio.ts:186` returns
`playing: this.step >= 0`, which is always true since `step` initialises to 0 —
so the native host reports a stopped engine as playing.)

---

## 4. The design

### 4.1 Launch quantum — wire the donor, do not reinvent it

Three pieces, in order:

1. **P11-3a — the position fan-out.** Make `NativeWorldSink` invoke
   `positionCbs` from its existing HotFrame subscription (`nativeAudio.ts:96-98`),
   and fix `playing`. This alone makes shipped scene queuing work in the real host.
2. **P11-3b — the ABI.** `slengine` needs
   `sl_deck_request_quantized_launch(e, deck, ref_deck, quantize_steps)` and
   `sl_deck_cancel_quantized_launch(e, deck)`, forwarding to the core's existing
   `requestQuantizedLaunch` / cancel, plus `launchArmed` surviving
   `sl_snapshot_begin` instead of being hardcoded false. Publish a **real**
   `deckQuantizePending` from `launchFiredSequence`.
3. **P11-3c — the control.** The scale, and the reference-strip answer below.

### 4.2 Whose grid? — the question the merge creates

The donor required `refDeck`. Three options for the merged plane:

| option | behaviour | cost |
|---|---|---|
| **A. The focused strip is the reference** | quantize against whichever strip has the ring (`mapStore.selectedKey`) | reuses a selection that already exists and is already drawn; but the boundary silently changes when focus moves |
| **B. An explicit "sync master" strip** | one strip wears a master badge; everything aligns to it | matches DJ mental models, survives focus changes, and makes "two decks that don't agree" impossible by construction |
| **C. Per-launch reference** | the deck you launch *from* names its own target | most expressive, most UI |

**Recommendation: B.** It is the only one where the guarantee is stateable in one
sentence — *everything launches on the master strip's grid* — and the donor's
failure mode (arming against a stopped deck fires immediately) becomes a visible
condition rather than a silent surprise: if the master is stopped, the QUANTUM
control says so. A is cheapest and can ship first if B is too much for one row;
C should be deferred until someone asks for it.

The badge belongs on the strip, and the **QUANTUM value** belongs on the master
bar (P11-3's instinct is right about the value, wrong about the reference).

### 4.3 The pads / SCN collision

P11-3's ⚠️ is correct that pads, SCN and QUANTUM describe one behaviour. The
measurement resolves it cleanly:

- `GridScenes` pads (P3-U8) are **live** and already queue on the LCM.
- `ScenePads` + the SCN latch are **dead at every layer**. P7-T3 plans to mirror
  a surface that renders nothing — so "parity" there means building the ops from
  scratch, not rehoming a component. That is a much bigger row than T3 reads.

**One meaning, one home:** the pads own *which* scene; QUANTUM owns *when*. SCN
should not return as a third spelling of the same thing until something answers
`patternScene` — and per P7-K7 the right move is to retire that module, not feed it.

### 4.4 The looper's cycle

There is no donor answer, so this is a decision. What is true today: a loop is a
buffer with in/out **frames**; record-stop makes the loop exactly the captured
frame count (`sl_tape.cpp:453-480`); and sync changes the *rate* of a fixed
region — **it never re-cuts the loop**.

The honest consequence: **a loop whose length is not a whole number of cycles at
the current tempo will not stay aligned, and no amount of launch quantization
fixes that.** Launching on a boundary only moves where the drift starts.

Three ways out, and they are not equivalent:

1. **Quantize the capture** — `sl_tape_record_start_quantized` is already spec'd
   (`SL-ABI-V3.md:168-174`) and deferred. Start *and stop* on a boundary and the
   length is musical by construction. Best result, most engine work, and it is
   the one that makes loopers behave like every other looper a musician has used.
2. **Snap the length at record-stop** — round the captured frame count to the
   nearest whole cycle at `bpmAtStart` and trim/pad. Cheap, but it edits audio
   the user played, and the ±20% honesty guard in `inferTapeBpm` exists precisely
   because that inference is not always safe.
3. **Infer and report, never alter** — today's behaviour plus a readout: show the
   inferred bar count and mark the loop as *not* cycle-aligned. Cheapest, honest,
   and leaves the musician to fix it.

**Recommendation: 3 now, 1 later.** 3 costs a readout and makes the existing
`inferTapeBpm` visible instead of silent — and P7-P1 (looper transport parity) is
user-deferred, so there is no rush to 1. Explicitly **not 2**: silently trimming
a take is the kind of thing that is discovered months later, and this project has
just spent a day on two defects that were invisible by construction.

> ⚠️ **Unit clash to resolve before any of this is built.** The deferred tape API
> takes `division` as a **denominator** (1 = bar, 4 = beat); the launch engine
> takes `quantizeSteps` as a **step count** (16 = bar, 4 = beat). The same
> numeral means opposite things. Pick one spelling for the whole app before two
> controls ship disagreeing.

---

## 5. What this costs

| row | what | size |
|---|---|---|
| **P11-3a** | position fan-out + `playing` fix — *repairs shipped P3-U8* | small, and it is a defect fix |
| **P11-3b** | the launch ABI through `slengine`, real `deckQuantizePending` | medium, C++ |
| **P11-3c** | QUANTUM control + reference-strip model | medium, web |
| **P11-3d** | loop cycle readout (option 3) | small, web |

P11-3 as written is all four. It should split — one row cannot be a defect fix,
an ABI, a control and a readout, and §11 caps an increment at ~500 LOC.
