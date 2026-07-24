# PD-SCRUB — the scrub gesture on a player Strip

*Interaction design for dragging the playhead on `DeckWaveform` inside a `Strip` on the
`Plane`. Written against the real code on 2026-07-24, cross-checked against Parlante V101
(Swift, read directly), the parlante-next liveness audit, and GRM Player's manual as cited
in our own design notes. **Standing constraint (pd-merge, user direction): "keep it simple
before we expand too much and clutter the code."** Everything below is sized to that.*

**Status:** proposal. §11 lists the two things that need a signature.

---

## 0. The whole design, in twelve lines

```
BACKGROUND drag ............ pan the plane          (Plane.tsx, exists)
STRIP CHROME drag .......... move the strip         (Strip.tsx, exists)
WAVEFORM drag .............. SCRUB                  (unmodified — it owns it)
WAVEFORM shift-drag ........ set the loop region    (one modifier, the only one)
WAVEFORM double-click ...... whole take as region   (exists)
WHEEL anywhere ............. zoom the plane         (exists, one geometric zoom)

Separation is by TARGET, not by modifier. No mode. No jog strip. No fine-scrub key.
Audio: scrubbing sounds if and only if the deck already sounds.
Head moves, wave never does. Absolute mapping. Whole take always visible.
Release: nothing happens. The head stays where you dropped it.
Precision: the drag is coarse ON PURPOSE. Exact numbers live in the Inspector.
```

---

## 1. What the reference actually does — Parlante V101, quoted

Read: `Views/WaveformView.swift` (4312 ln), `ViewModels/AudioPlayerViewModel.swift`
(11421 ln), `Services/AudioEngineScrubbing.swift` (1537 ln),
`Services/TrackpadGestureHandler.swift`, `Services/UserPreferences.swift`,
`Views/MenuCommands.swift`.

### 1.1 Scrub is a MODE, not a modifier, and it is OFF by default

There is no scrub modifier key in V101. There is a **latching mode** on ⌘J:

```swift
// MenuCommands.swift:705
Button(currentMenuState.isScrubbing ? "Disable Scrub Mode" : "Enable Scrub Mode") {
    viewModel.toggleScrubbing()
}
.keyboardShortcut("j", modifiers: .command)
```

Plain drag on the waveform is **selection**, always — scrubbing only pre-empts it when the
mode is armed *and* two preference gates are open:

```swift
// WaveformView.swift:1249
let trackpadDragEnabled = preferences.enableTrackpadDragScrubbing && preferences.enableScrubbingExperimental
...
// WaveformView.swift:1544
if scrubbingActuallyActive && trackpadDragEnabled {
    if preferences.enableTrackpadScrubbingTurntableMode {
        dragInteraction = .scrubbing          // continuous, velocity-based
    } else {
        dragInteraction = .seeking(startSample: calculatedStartSample)  // discrete
    }
}
```

Both gates default to **false**:

```swift
// UserPreferences.swift:200-201
static let enableTrackpadDragScrubbing = false          // Default to off
static let enableTrackpadScrubbingTurntableMode = false // Default to disabled
```

The only modifier on the unmodified drag path is Option, and it is **pan**, not scrub:

```swift
// WaveformView.swift:1564
let isOption = KeyMonitor.shared.isOptionPressed
if isOption {
    dragInteraction = .panning(startZoomRange: viewModel.zoomRange)
```

**Transfers:** the gesture is decided ONCE at drag start and owns the whole drag
(`if dragInteraction == nil { … }`, WaveformView.swift:1233). We should copy that lock
exactly. **Does not transfer:** a latching mode. Parlante needs one because plain drag is
already spoken for by selection — an editor's most frequent act. On a Wizard Strip nothing
else wants the waveform drag, so a mode would be pure ceremony.

### 1.2 Two scrub flavours, both real, both expensive

**Discrete** — on each drag update, play a fixed snippet at natural pitch:

```swift
// UserPreferences.swift:199
static let scrubbingPreviewDuration: Double = 0.1
// WaveformView.swift:1637
viewModel.audioEngineService.discreteScrub(to: targetTime, playDuration: UserPreferences.shared.scrubbingPreviewDuration)
```

`discreteScrub` stops the player node, resets it, and schedules a fresh 0.1 s buffer
(`AudioEngineScrubbing.swift:1460-1487`).

**Turntable** — a dedicated `AVAudioSourceNode` rendering a rate-driven cursor, tuned by:

```swift
// AudioEngineService.swift:84
static let hybrid = TapeScrubTuning(
    normalVelocity: 100.0,      // 100 px/s == rate 1.0
    maxRate: 3.0,
    deadZoneVelocity: 2.0,
    rateSmoothingTime: 0.006,
    cursorCorrectionTime: 0.035,
    gainRampTime: 0.012,
    inputHoldTime: 0.04
)
```

with the velocity curve

```swift
// AudioEngineScrubbing.swift:24-26
let normalized = magnitude / tuning.normalVelocity
let shaped = pow(normalized, 0.9)
return max(-tuning.maxRate, min(tuning.maxRate, shaped * sign))
```

The mechanism worth understanding is the **dual loop**: velocity drives a smoothed *rate*
that advances the cursor, while the pointer's absolute position simultaneously *pulls* the
cursor toward it on a separate 35 ms constant, so the sound is velocity-driven but the
position never drifts away from the finger:

```swift
// AudioEngineScrubbing.swift:220-231
tapeScrubLiveState.smoothedRate  = smoothedScrubValue(current:…, target: targetRate,  timeConstant: tuning.rateSmoothingTime)
tapeScrubLiveState.cursorFrame   = smoothedScrubValue(current:…, target: targetFrame, timeConstant: tuning.cursorCorrectionTime)
tapeScrubLiveState.gain          = smoothedScrubValue(current:…, target: targetGain,  timeConstant: tuning.gainRampTime)
```

plus a render-thread/control-thread split with a try-lock that never blocks and never
falls to silence on contention (`AudioEngineScrubbing.swift:166-191`), a 40 ms input-hold
that fades to silence when the finger stops, and edge handling that zeroes gain at the
buffer bounds. **This is ~1500 lines to make a stopped file audible under a finger.**

### 1.3 What happens to playback when you scrub

Playback is **stopped**, and the pre-scrub state is remembered but (in the drag path) never
restored:

```swift
// AudioEngineScrubbing.swift:345-352
wasPlayingBeforeScrub = playerNode.isPlaying
if wasPlayingBeforeScrub {
    wasInterruptedBySeekOrStop = true
    playerNode.stop()
    ...
}
```

and the drag **end** does nothing at all:

```swift
// WaveformView.swift:1793-1796
case .scrubbing:
    // Scrubbing mode stays active after drag ends (controlled by user via toggle button)
    waveformViewLog("Waveform Interaction Ended: Scrubbing drag finished, scrubbing mode remains active.")
```

**Transfers:** release does nothing — no snap, no resume, no momentum. **Does not
transfer:** killing playback to scrub. Our engine doesn't have to.

### 1.4 Feedback in V101

- The **wave moves under the head**, not the reverse — but only as a *page*, not a
  recentre, and only when follow is on (default off). `handlePlayheadFollow` shifts
  `zoomRange` when the head crosses an adaptive threshold
  (`WaveformView.swift:2730-2740`); follow is suppressed while
  `isUserInteractingWithWaveform`.
- Discrete scrub paints the snippet it is about to play as a range, cleared on a timer:
  ```swift
  // AudioPlayerViewModel.swift:4660-4665
  scrubVisualizationRange = globalNormalizedPosition...endPosition
  DispatchQueue.main.asyncAfter(deadline: .now() + playDuration + 0.05) { [weak self] in
      self?.scrubVisualizationRange = nil
  }
  ```
- **No cursor change for scrub.** I searched `WaveformView.swift`,
  `WaveformDisplayArea.swift` and `HoverLocationModifiers.swift` for `NSCursor` /
  `pointerStyle`: there are none. The only hover machinery is `onContinuousHover`
  (`HoverLocationModifiers.swift:24`) and it feeds coordinates, not a cursor.
- Haptics fire on selection/move/resize end (`NSHapticFeedbackManager…perform(.generic…)`)
  but **not** on scrub end — the `case .scrubbing:` arm at `WaveformView.swift:1793` has no
  haptic call.
- **There is no fine/slow scrub modifier and no velocity-scaled *position* response.**
  Resolution comes from zoom alone: the drag is mapped viewport-relative, so zooming in
  makes scrubbing finer.
  ```swift
  // AudioPlayerViewModel.swift:4622-4633
  // ZOOM-AWARE SCRUBBING: Calculate position relative to visible viewport instead of entire file
  let normalizedX = max(0.0, min(1.0, currentLocation.x / viewSize.width))
  let targetSample = viewportStart + Int(normalizedX * Double(viewportWidth))
  ```
  There *is* a keyboard fine-step (`scrubWithMovementPrecision`, arrow keys, sample/second/
  percent units) but it is not a drag behaviour.

### 1.5 Trackpad handling in V101

`TrackpadGestureHandler` is scroll-wheel only (zoom/pan) and never touches scrub. Two ideas
in it are worth naming because they are **NSEvent workarounds we do not need**:

```swift
// TrackpadGestureHandler.swift:146-148 — per-gesture axis lock
currentState = abs(event.deltaX) > abs(event.deltaY) ? .panning : .zooming
axisLockedTo = currentState
// TrackpadGestureHandler.swift:109 — synthesised gesture end
private let gestureTimeout: TimeInterval = 0.03
```

NSEvent gives no reliable scroll-end, so V101 synthesises one with a timer and repeats the
same 40-line teardown in **four** places (`stopGestureImmediately`, `resetForNewGesture`,
`handleGestureEnd`, `handleGestureTimeout`). Pointer Events give us `pointerup` and
`pointercancel`. None of this ports.

### 1.6 Independent audit — parlante-next already threw most of this away

`~/xpert/apps/parlante-next/docs/specs/interaction.md` is a liveness audit of the very code
above. It classifies as **DEAD**:

> **Scrub dead paths** — `mapVelocityToPlaybackRate`, `updateVelocityWithInertia` and their
> inertia constants are **not in effect**; the 60 s "continuous mode" buffer and the
> extended-sample/crossfade "physical media" experiments are unreachable. Live tuning is
> `TapeScrubTuning.hybrid` only.

and lists as still-open:

> whether turntable/drag-scrub ship at all in P2.

That is the second-strongest argument in this document for §9: the team that owns that
engine has not decided the turntable is worth shipping, in an app whose *entire subject* is
one waveform.

### 1.7 GRM Player — what our own verified notes actually say

`pd-canvas.md` §2 and `design-notes-grm-player.md` §4.2 cite the manual directly. The
player's parameters are **direction and speed**; the *multi* player groups sub-players
inside a reading span, *"un empan, une fenêtre, une boucle"*, whose size is dragged and
which *"can itself move"*. `pd-canvas.md` §4.1 adds:

> **Selection is tap-and-drag on the object; a marquee is additive later.** GRM's
> double-click / shift-click modifiers are for *temporal* selection inside a track — an
> editor gesture Wizard does not want.

**No jog or scrub gesture is cited anywhere in either document.** GRM's transferable idea
is *dragging a span*, which is already our shift-drag loop brace. GRM contributes **nothing**
to scrub, and pretending otherwise would be inventing a reference.

### 1.8 Tools I could NOT verify

I have no Serato, Traktor, Ableton or Koala source or documentation on this machine. I am
not going to quote them as evidence. For the record, the two things I would *want* to check
in them are (a) whether a stopped deck sounds under the finger and (b) what happens on
release — and both are answered for our purposes by the engine facts in §2, which I *can*
verify. Treat any DJ-software claim in this document's absence as unmade.

---

## 2. Ground truth in OUR code (all verified, all quoted)

### 2.1 The three-way drag conflict is already solved — by target, not by modifier

`Strip.tsx:128-133` refuses to start a strip move when the pointer lands on a control, and
**`canvas` is in that list**:

```tsx
const onPointerDown = (e: React.PointerEvent) => {
  if ((e.target as HTMLElement).closest('button, input, select, textarea, canvas, label')) return
  e.stopPropagation()
  dragRef.current = { px: e.clientX, py: e.clientY, x: cell.x, y: cell.y }
```

`Plane.tsx:74-78` refuses to pan when the pointer lands inside a Strip:

```tsx
const onPointerDown = (e: React.PointerEvent) => {
  if ((e.target as HTMLElement).closest('.plane-strip')) return // a control, not the canvas
```

and the canvas takes the pointer for itself (`DeckWaveform.tsx:209`):

```tsx
ev.currentTarget.setPointerCapture(ev.pointerId)
```

**Finding: there is no conflict to design around.** Pointer-down on the wave cannot pan the
plane and cannot move the strip, today, already. The gesture map in §3 is therefore not a
compromise — it is what the code is already shaped for.

### 2.2 A scrub on a PLAYING deck keeps playing. On a stopped deck it is silent *and invisible*.

`wz_deck_seek` posts to a mailbox (`wz_engine.cpp:468-473`). The render pre-pass drains it
at the top of a block — but look at the order:

```cpp
// wz_engine.cpp:799-804  — idle/recording/empty deck: silence, and CONTINUE
if (st == static_cast<uint32_t>(wz::DeckState::idle) ||
    st == static_cast<uint32_t>(wz::DeckState::recording) || dFrames == 0) {
    for (uint32_t i = 0; i < frames; ++i) { dl[i] = 0.0f; dr[i] = 0.0f; }
    d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
    continue;
}
...
// wz_engine.cpp:820-825 — the seek is drained only AFTER that early-out
const int64_t seek = d.pendingSeek.exchange(-1, std::memory_order_acq_rel);
if (seek >= 0) { … d.playhead = target … }
```

An **idle** deck `continue`s before reaching the seek drain. Consequences, all verified:

1. Scrubbing a stopped deck produces **no sound** — expected.
2. It also **does not move the drawn playhead**, because `pubPlayhead` publishes the stale
   `d.playhead` and `DeckWaveform` draws from that HotFrame field
   (`DeckWaveform.tsx:185-190`). *The gesture currently has no visible effect at all.*
3. The mailbox is never cleared while idle, so the stale target survives — and it wins over
   the trigger's reset, since `pendingReset` is consumed *before* the seek
   (`wz_engine.cpp:815` then `:820`). **Scrub a stopped deck, then press ⟳, and it starts
   at the scrubbed frame instead of the region entry.** That is accidental behaviour, not a
   designed cue point.

Point 2 is a bug and §10 fixes it. Point 3 is a decision and §11 asks for a signature.

### 2.3 Scrub is clamped to the buffer, not the region — deliberately

```c
/* wz_engine.h:142-146
 * SCRUB: … Clamped to the buffer, NOT to the loop region —
 * scrubbing outside the region is how you find the part you want to loop. */
```

with the wrap still applying afterwards, so on a looping deck a scrub outside the region
plays from where you dropped it until the region edge, then folds back in
(`wz_engine.cpp:816-819`). This is right, and §6 makes it explicit rather than leaving it
to be discovered as a bug.

### 2.4 The pixel budget

`DEFAULT_CELL = { w: 340, h: 220 }` (`schema.ts:194`); `waveWidth = max(80, cell.w - 16)`
= **324 px**; height 44. A 3-minute take is **0.556 s/px**. `MIN_SCALE = 0.2`,
`MAX_SCALE = 2.5` (`Plane.tsx:22-23`), so at 0.4× the wave is 130 screen px and
**1.39 s/screen-px**.

### 2.5 The cursor on the wave is currently wrong

```css
/* console.css:249  */ .deck-waveform { cursor: crosshair; touch-action: none; }
/* console.css:579  */ .plane-strip button, .plane-strip input, .plane-strip canvas, … { cursor: default; }
```

`.plane-strip canvas` (0,1,1) beats `.deck-waveform` (0,1,0) and comes later. **On the
plane the waveform shows a plain arrow** — it announces nothing.

### 2.6 Two latent smells in `DeckWaveform` that the design must not build on

- `drag` is in the hot-drawer effect's dependency array (`DeckWaveform.tsx:193`), so every
  pointermove of a shift-drag tears down and rebuilds the drawer, re-runs
  `getComputedStyle(document.documentElement)`, and re-assigns `canvas.width` (which resets
  the whole 2D context). **Any per-move scrub state must therefore live in a ref**, exactly
  as `liveFramesRef` already does — the file's own stated law: *"harvested from the
  HotFrame by the drawer below — never through React state (it changes every frame)."*
- `posToSample` maps against the committed `frames` prop while the drawer maps against
  `span` (the live length) when recording — so pointer-to-sample is wrong mid-take. Moot
  once scrub is disabled while recording (§3.4), which it should be anyway.

---

## 3. Gesture map

### 3.1 Who owns the unmodified drag on the waveform, and why

**Scrub owns it.** Three reasons, in order of weight:

1. **Nothing else wants it.** §2.1: pan and strip-move both structurally decline the
   canvas. An unmodified gesture that is contested by nothing should not be behind a
   modifier — that is the definition of gymnastics.
2. **A Strip is a player, and on a player the wave *is* the transport.** pd-canvas §3.0
   puts "waveform + loop brace" and "transport" in the *on-Cell, direct-manipulation*
   column and "exact loop in/out samples" in the Inspector. Position is a live gesture;
   region boundaries are a setting you get right once.
3. **Frequency.** You ask "where am I / go there" many times per loop you set. The existing
   code comment already made this call and it was correct:
   ```tsx
   // DeckWaveform.tsx:211-214
   // PLAIN DRAG = SCRUB (the player gesture — you grab the record and move
   // it). SHIFT-drag sets the loop region, which used to be the plain drag;
   // scrubbing is the far more frequent act on a player, so it gets the
   // unmodified gesture.
   ```

### 3.2 Is a dedicated scrub STRIP/zone better? No.

```
   ┌ Take 3 ─────────────────── ✗ REJECTED ────┐   ┌ Take 3 ────── ✓ SHIPPED ───┐
   │ ▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂  wave (40 px)   │   │ ▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂ │  44 px   │
   │ ══════════◆══════════════  jog (16 px)   │   │ ⟳ ▸ ⟲ ◼  M S C           │
   │ ⟳ ▸ ⟲ ◼                                  │   └──────────────────────────────┘
   └──────────────────────────────────────────┘     the wave IS the scrub zone
```

Against a jog strip:

- **It costs the one thing we don't have.** 220 px already holds header + wave 44 + file
  line + transport + three ParamRows. `.plane-strip` CSS says the height is deliberately
  fixed: *"a Strip NEVER resizes on a state change … fitToContent frames against the
  persisted cell.h, so a box that grows silently corrupts the fit."* A jog strip means
  bumping `DEFAULT_CELL.h` for every strip, including the input strips that have no deck.
- **It needs a second mental model.** A jog is *relative* (spring-back, velocity), the wave
  is *absolute* (this x is that sample). Two position models on one object, 16 px apart, is
  worse than one modifier.
- **It duplicates a surface we already have.** The wave is 324×44 — the largest, most
  obvious target on the Strip. Adding a smaller, less obvious target for the same job is
  strictly a loss.
- pd-merge §2's rule: *"no new surface … unless one of the four surfaces cannot work
  without it."* The Strip works without it.

### 3.3 The complete pointer contract

Decided **once** at pointer-down and locked for the whole drag (Parlante's
`if dragInteraction == nil` rule, §1.1). Never re-evaluate `shiftKey` on move.

```
POINTER-DOWN on the waveform canvas
  ├─ frames === 0 or recording → ignore entirely (no capture, no seek)
  ├─ setPointerCapture(pointerId)
  ├─ shiftKey ─┬─ YES → mode = REGION.  anchor = x→sample. Draw the live brace.
  │            │        No audio command is sent, ever, during a region drag.
  │            └─ NO  → mode = SCRUB.   Post deckSeek(frame) NOW (a click IS a scrub of
  │                     zero length — the "needle drop"). Set scrubHeadRef = frame.
  └─ Both modes: preventDefault is unnecessary (touch-action: none already set).

POINTER-MOVE  (only while this canvas holds capture; `ev.buttons === 1` is not the test —
               capture is, because it survives a button-state hiccup)
  ├─ mode === REGION → update the live brace only. No seek.
  └─ mode === SCRUB  → scrubHeadRef = x→sample  (drawn immediately, this frame)
                       throttle deckSeek to one post per animation frame, coalesced to the
                       LATEST position. Intermediate positions are worthless: the mapping
                       is absolute, so only where the finger IS matters — never where it
                       has been. (This is exactly why we do not need
                       getCoalescedEvents(), and why Parlante's velocity history —
                       `velocityHistory` capped at 4, AudioEngineScrubbing.swift:670-673 —
                       has no analogue here.)

POINTER-UP / POINTER-CANCEL
  ├─ releasePointerCapture(pointerId)          ← currently missing; see §10
  ├─ mode === REGION → if (b - a > 1) onSetLoop(a, b). A zero-span drag is a click and
  │                    must not silently zero the region (already correct at :227-228).
  └─ mode === SCRUB  → post one final deckSeek at the release position, then clear
                       scrubHeadRef so the head hands back to the HotFrame. Nothing else.
                       No snap, no trigger, no stop. See §6.

DOUBLE-CLICK → onSetLoop(0, frames). Unchanged.
```

### 3.4 Scrub is disabled while recording

The record head is the right edge of a growing buffer; there is nothing to scrub to, the
engine's record branch is silent by construction (`wz_engine.cpp:800`), and `posToSample`
is mis-mapped mid-take anyway (§2.6). The cursor and the title must say so.

---

## 4. Does audio keep playing while scrubbing?

**Yes on a playing deck; no on a stopped one. One rule: scrubbing sounds if and only if
the deck already sounds.**

On a playing deck this is already true and costs nothing — `deckSeek` posts to a mailbox,
the reader picks it up at the top of the next block and carries on reading forward at the
deck's rate from the new position. Drag fast and you hear a chain of ~11.6 ms fragments
(512 frames at 44.1 kHz) — a real, useful, needle-dropping scrub sound that we get for
free from work already done.

**Should a stopped deck sound, the way a turntable does?** Not now, and the refusal is
load-bearing:

- The honest price is §1.2: a second render node, a rate/cursor/gain triple smoother, a
  render-owned vs control-owned state split with a non-blocking try-lock, an input-hold
  timeout, edge gain-zeroing — ~1500 lines in Parlante, and it would be *new DSP in
  `wz_engine.cpp`*, the one file where new code is most expensive.
- The team that owns that code hasn't decided it ships (§1.6).
- Every existing shortcut is closed. I checked: **there is no cheap version.**
  - *Drive `wz_deck_set_rate` from pointer velocity?* `|rate|` is clamped to `[1/16, 16]`
    (`wz_engine.h:164`, `wz_engine.cpp:837-840`), so the deck can never actually stop under
    a still finger; and rate is smoothed on the 10 ms D-WZ-RAMP-01 constant while position
    is not, so the head drifts away from the finger. Parlante needs its *second* smoother
    (`cursorCorrectionTime: 0.035`) precisely to cancel that drift, and we cannot add one
    from TypeScript.
  - *A 0.1 s "discrete scrub" preview, Parlante-style?* `oneShot` plays the loop **region**,
    not an arbitrary 100 ms. Faking it means writing the region on every pointermove —
    mutating persisted document state at 60 Hz to make a sound. No.
- And the fallback is already good: **if you want to hear it, press ⟳ and scrub.** The deck
  then plays, and scrubbing sounds. That is one sentence of documentation and zero lines of
  DSP.

What must change is the *asymmetry*, not the silence: a stopped deck being silent is a
design choice, a stopped deck being **invisible** (§2.2) is a bug. §10 fixes it in three
lines with no DSP.

---

## 5. Feedback

### 5.1 The head moves; the wave never does

```
        SHIPPED — absolute, whole take always visible
  0                              ▌                            frames
  ├──────────────────────────────┼─────────────────────────────┤
  ▁▂▃▅▇▅▃▂▁▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁
              └────── loop brace ──────┘

        REJECTED — fixed head, wave scrolling under it
  needs a per-Strip viewport (start,end) + a per-viewport envelope re-fetch
  + a second zoom gesture inside a plane that already owns zoom.
```

Reasons the wave stays put:

- **The envelope is fetched once per buffer change**, by design and with a comment saying
  so (`DeckWaveform.tsx:61-62`: *"a view-change cost, not a per-frame one"*). A scrolling
  wave makes every scrub frame a view change, i.e. a `deckWaveform` command round-trip.
- It would be a **second zoom system inside the first**. pd-merge §2 already refused
  "three zoom density tiers"; a per-Strip time zoom is the same refusal wearing a hat.
- **A dozen strips must be scannable at a glance.** A whole-take-always-visible wave is a
  thumbnail of the material; a scrolling window is a keyhole. On a plane, the thumbnail
  wins outright.
- Parlante moves its viewport, but Parlante is one document in a ~1400 px lane with
  follow **off by default** (§1.4). At 324 px there is nothing to page.

### 5.2 What the head does during a drag

Three changes, all inside the existing drawer:

1. **The head is optimistic while the pointer is down.** Draw from `scrubHeadRef.current`,
   not the HotFrame, for the duration of the drag; hand back on release. This removes the
   command → mailbox → next-block → HotFrame → rAF latency from the *visual*, so the head
   is glued to the finger even though the audio is up to a block behind. It is the same
   idiom the loop brace already uses, quoted from the file itself:
   > *"the live drag wins over the committed region so the gesture is visible before it is
   > applied"* (`DeckWaveform.tsx:168-170`)
   A ref, not state — see §2.6.
2. **The head is hotter and wider while scrubbing.** `--accent` at `2 × dpr` instead of
   `1 × dpr`, so "I am holding this" is unmistakable at a glance across a plane.
3. **A time readout beside the head, only while dragging.** `m:ss.d`, drawn on the canvas,
   right of the head (flipped left within 40 px of the edge). This is the one addition I am
   arguing *for* rather than against, because it is what actually answers §7: it converts
   "0.556 s/px is coarse" into "I can see I am at 1:23.4". No new DOM, no new state, ~6
   lines in a drawer that already runs.

Nothing else. No ghost range (Parlante's `scrubVisualizationRange` exists to preview a
snippet it is about to play — we play nothing, so there is nothing to preview). No haptics
(Parlante has none on scrub either, §1.4).

### 5.3 Cursor

```
.plane .deck-waveform            { cursor: ew-resize; }   /* horizontal, and NOT "grab" */
.plane .deck-waveform:active     { cursor: grabbing;  }
.plane .deck-waveform[data-recording] { cursor: not-allowed; }
```

`ew-resize` rather than `grab` on purpose: `.plane-strip` already uses `grab`/`grabbing` to
mean **move the strip** (`console.css:573-578`). Two surfaces, two meanings, two cursors —
so the strip announces "the wave is the horizontal one, the rest of me is the draggable
one" without a single pixel of new UI. This also fixes the specificity bug in §2.5. That
cursor pair *is* the mitigation for the "user grabs the wave to move the strip" misfire
(§8).

### 5.4 At 0.4× plane zoom, where the strip is small

The plane transform is `scale(s) translate(…)` on `.plane-layer`, so the canvas — CSS
pixels and all — is scaled down bodily. A `1 × dpr` playhead becomes `0.4` screen px:
sub-pixel, shimmering, sometimes gone. **The strip already receives `scale` as a prop**
(`Strip.tsx:91-92`, used for the move gesture). Pass it through and draw the head at
`Math.max(1, dpr / scale)` device px so it stays ≈1 screen px at every zoom. One line,
using a value already in hand.

Scrub *precision* at 0.4× is 2.5× worse (1.39 s/screen-px). The correct response is
**nothing**: the plane already has a zoom gesture, and "zoom in to be precise" is a
sentence, not a feature. Adding a density tier here is exactly what pd-merge §2 refused.

---

## 6. Release

**Nothing happens. The playhead stays exactly where you dropped it and the deck keeps doing
whatever it was doing.** No snap, no re-trigger, no stop, no momentum.

For a looper this is the least surprising rule available:

- **Snapping** (to zero-crossing, to region edge, to a grid) would silently move you off
  the point you just spent a gesture finding. The loop region is the musical object; the
  playhead is *where you are*, and moving it behind the user's back is the "no silent
  silence" law in a different costume. Parlante ships zero-crossing snap and it is **off by
  default** (parlante-next audit).
- **Snapping to the region start** would directly contradict the engine's stated purpose
  for scrub: *"scrubbing outside the region is how you find the part you want to loop"*
  (`wz_engine.h:145`).
- **Momentum / continue-spinning** requires the rate renderer refused in §4.
- **Stopping the deck** would make scrub a destructive act on a live performance surface.
- Parlante's drag-end does nothing either (§1.3), and that is the one part of its scrub
  design I would copy verbatim.

Two consequences to state out loud so they are not later filed as bugs:

- On a **looping** deck, scrubbing outside the region plays from the drop point until the
  region edge, then folds back into the region (`wz_engine.cpp:816-819`). A loop is a loop.
- On a **stopped** deck, the head parks at the drop point and stays there (once §10 lands).
  Pressing ⟳ afterwards starts at the **region entry**, not the parked head — see §11 for
  the signature this needs.

---

## 7. Precision

324 px, 3-minute take, **0.556 s/px**. So: how does fine scrubbing work at all?

**It doesn't, and that is the design.** The drag is coarse on purpose, because
`pd-canvas.md` §3.0 already assigned this job elsewhere:

> | On the Cell (always visible, direct-manipulation) | In the Inspector (selected Cell only) |
> | waveform + loop brace (drag to set region) | **exact loop in/out samples (drag is coarse; type here)** |

Coarse-on-the-object, exact-in-the-Inspector is the split the whole plane design rests on.
Adding a vernier to the drag would duplicate the Inspector on the object — clutter of
exactly the kind pd-merge exists to prevent.

The three candidate mechanisms, and why each is refused *now*:

| Mechanism | Verdict |
|---|---|
| **Zoom the wave** (per-strip time viewport, Parlante's answer — §1.4) | **No.** A second zoom system inside the plane's zoom; per-Strip persisted viewport; envelope re-fetch per view change. §5.1. |
| **Fine/slow modifier** (alt-drag → 0.1× delta from an anchor) | **Not now.** ~8 lines and genuinely useful, but it breaks the absolute mapping — the head stops being under your finger, which is the property that makes the coarse drag legible in the first place. Deferred, with a trigger: build it *only* if the Inspector ships and users still reach for the wave to place exact points. |
| **Velocity-scaled response** | **No.** Same absolute→relative break, plus it is the front half of the turntable machinery we refused in §4. Note Parlante does not do this either: its velocity drives *audio rate*, never *position* (§1.4). |

What the coarse drag gets instead is the **time readout** (§5.2.3). At 0.556 s/px you
cannot place a sample, but you can absolutely see that you are at 1:23.4 and nudge — and if
you need 1:23.417, that is a number, and numbers go in the Inspector.

---

## 8. Trackpad / touch reality on macOS

Verified, not assumed:

- **Browser scroll/pan cannot steal the gesture.** `touch-action: none` is set on both
  `.plane` (`console.css:322`) and `.deck-waveform` (`console.css:253`).
- **Accidental scrub while panning the plane: impossible.** Pan requires pointer-down on
  the background (`Plane.tsx:75`); the wave captures its own pointer.
- **Accidental scrub while moving a strip: impossible.** `Strip.tsx:129` excludes `canvas`.
- **The real misfire is the inverse:** the waveform is the biggest, most grabbable surface
  on the Strip, and a user who wants to *move the strip* will grab it and scrub instead.
  Mitigation is the cursor pair in §5.3 — `ew-resize` on the wave against `grab` on the
  chrome — and nothing else. Do not add a drag handle; the header, the file line, the state
  chip and all the padding are already move surfaces.
- **Momentum is a wheel problem, not a pointer problem.** `Plane.onWheel` zooms on every
  wheel event (`Plane.tsx:97-102`), and macOS keeps delivering momentum wheel events for
  ~1 s after the fingers lift — so a flick over a strip keeps zooming the plane briefly.
  This is pre-existing, it is not scrub's problem, and it needs **no** fix: zoom is
  idempotent per event, so unlike Parlante we need no synthesised gesture-end
  (`gestureTimeout: 0.03` and its four teardown paths, §1.5). Pointer drags have no
  momentum at all — `pointerup` is exact.
- **Coalesced pointer events are unnecessary.** Absolute mapping means only the newest
  position matters. Throttle to one `deckSeek` per rAF, coalesced to the latest (§3.3).
- **`pointercancel` must be handled.** A three-finger swipe or a system gesture can cancel
  a capture mid-drag; the current `onPointerUp` handler has no `onPointerCancel` sibling,
  so a cancelled shift-drag would leave `drag` state stuck and the brace frozen.
- **Touch:** `touch-action: none` + pointer capture makes one-finger drag work as-is.
  Two-finger pinch on the plane is not implemented and is out of scope.

---

## 9. What we are deliberately NOT building

In the shape of pd-merge §2, so the refusals stay recorded.

| Proposed | Verdict |
|---|---|
| **Audible tape/turntable scrub on a stopped deck** | **No.** New DSP in `wz_engine.cpp`: a second render source, rate + cursor-correction + gain smoothers, render/control state split, input-hold. ~1500 lines in Parlante, and parlante-next has not decided it ships. §4. |
| **Velocity-driven playback rate from the drag** | **No.** `|rate|` clamps at 1/16 so it never stops; rate is smoothed and position is not, so the head drifts off the finger. §4. |
| **0.1 s "discrete scrub" snippet preview** | **No.** `oneShot` plays the region; faking a 100 ms window means writing the loop region at 60 Hz — mutating persisted state to make a sound. §4. |
| **A dedicated jog strip / scrub zone on the Strip** | **No.** Costs `DEFAULT_CELL.h` for every strip incl. deckless ones, adds a second position model 16 px from the first, duplicates the largest target on the object. §3.2. |
| **Per-Strip waveform zoom / scrolling wave under a fixed head** | **No.** A second zoom system inside the plane's; envelope re-fetch per view change; a keyhole where a thumbnail belongs. §5.1. |
| **Fine/slow scrub modifier, velocity-scaled position** | **Not now.** Precision is the Inspector's job by §3.0 of pd-canvas. Deferred with a named trigger. §7. |
| **Snap on release** (zero-crossing / grid / region edge) | **No.** Silently moves you off the point you found, and contradicts `wz_engine.h:145`. §6. |
| **A scrub MODE or toggle (Parlante's ⌘J)** | **No.** Parlante needs one because plain drag is spoken for by selection. Nothing contests our waveform drag. §3.1. |
| **Momentum / flywheel on release** | **No.** Requires the rate renderer above. §6. |
| **Haptics, ghost snippet range, scrub sound-on-hover** | **No.** Parlante ships none of these on scrub either. §5.2. |
| **A second zoom density tier so small strips scrub finely** | **No** — already refused by pd-merge §2. Zoom the plane in. §5.4. |
| **New persisted fields** | **None.** Scrub is a command (`deckSeek`), exactly as session.ts v21→v22 recorded: *"a COMMAND, not a document"*. |

**Net new persisted state: zero. Net new surfaces: zero. Net new engine DSP: zero.**

---

## 10. The diff this spec asks for

Nine changes. Every one is small, and four of them are bug fixes to things already shipped.

**`engine/src/wz_engine.cpp`** — *the only engine change, and it is not DSP*

1. Drain `pendingSeek` for an **idle** deck too, before the silence early-out, and set
   `d.playhead` from it, so a scrub on a stopped deck moves the drawn head. Three lines.
   (Recording decks keep ignoring it.) Fixes §2.2 point 2, and by clearing the mailbox also
   removes the accidental behaviour in §2.2 point 3 — see §11.

**`web/src/panels/DeckWaveform.tsx`**

2. Lock the gesture at pointer-down into an explicit `'scrub' | 'region'` held in a **ref**,
   and drive pointer-move from *capture*, not `ev.buttons === 1`.
3. `scrubHeadRef` — optimistic head position, a ref, drawn by the existing drawer while the
   pointer is down; cleared on up/cancel so the head hands back to the HotFrame (§5.2.1).
4. Throttle `onScrub` to one call per animation frame, coalesced to the latest position
   (§3.3).
5. Add `onPointerCancel` (mirror of `onPointerUp`) and actually
   `releasePointerCapture(ev.pointerId)` in both — currently neither happens (§8).
6. Ignore pointer-down entirely while `recording`, and while `frames === 0` (§3.4).
7. Take `scale` as a prop and draw the head at `Math.max(1, dpr / scale)` device px (§5.4);
   draw it at `2×` in `--accent` while a scrub drag is live, plus the `m:ss.d` readout
   (§5.2.2, §5.2.3). `Strip.tsx` already has `scale` in hand and passes it nowhere yet.
8. Move `drag` out of the drawer effect's dependency array into a ref, so a drag stops
   rebuilding the canvas context 60×/s (§2.6).

**`web/src/design/console.css`**

9. `.plane .deck-waveform { cursor: ew-resize }` / `:active { grabbing }` /
   recording `not-allowed`, beating `.plane-strip canvas { cursor: default }` (§2.5, §5.3).

Also update the canvas `title`, which currently promises the old behaviour ordering:
`"drag to scrub · shift-drag to set the loop region · double-click for the whole take —
scrubbing sounds while the deck is playing"`.

---

## 11. Two things that need a signature

1. **Scrub-then-play on a stopped deck.** Today, scrubbing a stopped deck leaves a stale
   seek in the mailbox that overrides the next trigger's reset, so ⟳ starts at the scrubbed
   frame (§2.2 point 3). It is accidental — it depends on an early-`continue` — but it is
   arguably *nice*: scrub sets a cue point. The §10 fix removes it, making ⟳ always start
   at the region entry, which is what the ⟳ button's own tooltip already promises
   (*"retrigger — seek to the region start"*). **My recommendation: remove it.** A cue point
   that exists only as an undrained mailbox is a hidden state, and if the user wants to play
   from a found point, the answer is to set the region there — which is the shift-drag,
   right under the same finger. But it is a behaviour change to something that ships, so it
   should be signed rather than assumed.

2. **Whether an audible stopped-deck scrub is ever wanted.** §4 refuses it *now* on cost,
   not on principle. If the answer is "eventually yes", the right shape is a `wz_deck_scrub`
   entry point in the engine with its own cursor+rate+gain smoothing (Parlante's `hybrid`
   tuning is a good starting constant set and is quoted in §1.2 for that reason) — **not**
   an accumulation of TypeScript workarounds around `wz_deck_set_rate`. Recording that here
   so that if it is ever built, it is built once and in the right place.
