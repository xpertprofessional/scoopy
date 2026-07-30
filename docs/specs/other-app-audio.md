# Other-app audio — the interim path (P9-5, D-WZ-VDEV-02)

*Status: **interim and signed**. This is how another application's audio gets into
a Scoopy session **today**, with software that already exists: a third-party
virtual audio device (BlackHole, Loopback) selected as the input device, then an
ordinary `deviceInput` route. No engine code, no new source kind.*

*It is superseded by **P10** — the native **Wizard Out** device (D-WZ-VDEV-01: 16
channels / 8 stereo pairs, app-agnostic, no per-app configuration). §8 says
plainly where this path is worse, so nobody mistakes it for the destination.*

**Measured against HEAD `e3b2d48`, 2026-07-30.** Every claim below cites the file
it was read from, because these surfaces were built for hardware inputs and have
never been walked with a virtual one. What is **not** proven here is audio: no
part of this document has been heard. **P9-G1** is the gate that hears it.

Companion documents: `docs/merge/ROUTING-MATRIX.md` (the governing routing design
and the D-WZ-VDEV-02 amendment) · `docs/specs/capture.md` + ARCHITECTURE §capture
(the native path this replaces later) · `docs/DECISIONS.md` D-WZ-VDEV-01/02,
D-WZ-RATE-01, D-WZ-MON-01.

---

## 1. What the path actually is

A virtual audio device is a driver that presents itself to macOS as both an
output and an input: whatever an app plays into its output appears on its input.
So the whole trick is that Scoopy does not have to know anything. It opens the
virtual device as its **input device** and reads it exactly as it reads a
microphone.

Everything downstream already exists and is engine-proven:

- `slDevices` (`web/protocol/schema.ts:1958-1976`) has exactly two actions,
  `list` and `setInput`. `setInput` is answered by the merged shell at
  `shell/src/SlDispatch.cpp:1009-1023`.
- **Only one host answers it.** The handler refuses unless `services->audio` is
  present (`SlDispatch.cpp:992`), and the single assignment in the tree is
  `services.audio = &audioIO` in `shell/src/MergedApp.cpp:93` — the merged app
  (WizardMerged). The headless dispatch harness deliberately gets a refusal
  (`shell/tools/sl_dispatch_test.cpp:363-364`), and the browser dev host has no
  device layer at all, so the picker there is empty by design.
- The route kind is `deviceInput` = **2** (`web/src/persist/mapApply.ts:71-77`),
  a first-class source in the engine
  (`slengine/src/sl_channel.cpp:539-543`), and it is **authorable by a user
  today** — not fixture-only. Picking an input from the strip's ⋯ menu runs
  `repointInput` (`web/src/plane/Plane.tsx:150-165`) → `repatch`
  (`Plane.tsx:327-345`), which issues a real `slRoute add srcKind 2 → dstKind 0`.

Nothing on that chain knows or cares that the device is virtual. That is why
this costs documentation instead of code.

---

## 2. Three constraints to settle before you install anything

These are properties of the app as built. Ignoring them is how this path fails
silently.

### a. 48 000 Hz, exactly

`sl_engine_create(48000.0, 512, …)` (`shell/src/MergedApp.cpp:295`) and the
device is then opened at the engine's rate (`MergedApp.cpp:76`). `AudioIO::open`
**refuses** rather than let the driver coerce the rate, because coercion would
repitch the monitor path (`host/src/AudioIO.cpp:37-40`). A device switch carries
the same demand: `setInput` calls `io.setDevices(name, {}, sl_engine_sample_rate(engine))`
(`SlDispatch.cpp:1014`).

D-WZ-RATE-01 says the graph runs at the **output** device's rate. In the merged
app that rate is pinned to 48 kHz at engine creation, and the input device is
then required to match it. **So: set the virtual device to 48 kHz, and make sure
your output interface can do 48 kHz too.** If they disagree, `setDevices` returns
`"device does not support 48000 Hz"` — and see the box in §7, because what
happens next is worse than a failed switch.

### b. One stereo pair

The device is opened with `initialiseWithDefaultDevices(2, 2)`
(`AudioIO.cpp:22`), and every switch re-asserts `useDefaultInputChannels = true`
(`AudioIO.cpp:107`). Nothing in the tree ever asks for more than two input
channels. **Use BlackHole 2ch, not 16ch.** On a wider device, plan on its first
pair only.

The authority at runtime is what the picker lists: `activeInputChannelNames()`
compacts to the channels actually open (`AudioIO.cpp:140-152`), and index *i* in
that list **is** `srcIndex` *i* in a route — one list, no second mapping
(`web/src/plane/devices.ts:1-12`). If you open the ⋯ menu and see only two
BlackHole channels, that is this constraint, not a bug in the device.

### c. Install before you launch

`refreshDevices` is called **once**, from the plane's boot effect
(`web/src/plane/PlanePanel.tsx:378`), and no other surface re-reads the list.
`slDevices` has no rescan action, and the scoopy-era `enumerateAudioDevices` /
`device-list-changed` path the old Audio panel polls
(`web/src/panels/AudioPanel.tsx:34-52`) is **not answered by the merged host** —
it is in the honest-refusal list at `shell/tools/sl_dispatch_test.cpp:151-158`.

**A device that appears after launch is invisible until you restart the app.**
Install the driver, reboot or log out if its installer asks, set its rate, *then*
open Scoopy.

---

## 3. Install the virtual device

**BlackHole 2ch** (free):

```sh
brew install --cask blackhole-2ch
```

or the installer from <https://existential.audio/blackhole/>. It is a CoreAudio
HAL plug-in, so `coreaudiod` has to pick it up — log out and back in if it does
not appear.

**Loopback** (Rogue Amoeba, paid) does the same job and adds the thing BlackHole
cannot do: it lets you choose **which application** feeds the device, and it
monitors through your normal output at the same time. If you are capturing one
app out of several, or you want to keep hearing that app directly, Loopback is
worth the money for this path. Everything below is written for BlackHole; with
Loopback, substitute your virtual device's name and skip §4's Multi-Output step.

Then, in **Audio MIDI Setup**: select BlackHole 2ch → **Format: 48 000 Hz, 2 ch**
(§2a).

---

## 4. Point the other app at it

- **Simple case.** In the other app's own audio-output setting, choose
  **BlackHole 2ch**. You will stop hearing that app directly — expected. From §6
  on, you hear it through Scoopy.
- **If you want to keep hearing it directly too.** In Audio MIDI Setup, create a
  **Multi-Output Device** containing your normal interface *and* BlackHole 2ch,
  tick **Drift Correction** on BlackHole (it has no clock of its own worth
  following), and point the app at that. Be aware you now hear the app twice —
  once directly, once through Scoopy's monitor a device buffer later. Mute one of
  them before you judge anything by ear.
- **System audio (everything).** Set the Multi-Output device as the macOS output
  in System Settings → Sound. Then Scoopy receives the whole system mix, browser
  notifications included. That is the bluntness §8 is about.

---

## 5. Select it in Scoopy

Launch **WizardMerged**. On the plane, on the strip that should carry the audio
(a plain strip is fine; a tape strip if you intend to record it):

1. **Click `⋯`** on the strip header (`web/src/plane/Strip.tsx:715-726`). This is
   the visible door and it exists precisely because right-click alone was found
   not to reach the page in the WKWebView host. Right-click on the header still
   works (`Strip.tsx:702`).
2. Scroll to the bottom section, **`input device`**. Pick **BlackHole 2ch**.

   ⚠️ **That section is only rendered when the host reports more than one input
   device** (`Strip.tsx:624`). If you have not installed anything yet, or the app
   started before the driver existed (§2c), there is no device section at all and
   the menu looks like it never had one. That is the gap row **P9-5a** closes.
3. The menu closes on selection. **Open it again.** The top section, `record
   from`, now lists BlackHole's channels (`Strip.tsx:520-533`). If it instead
   says *"no inputs on this device"*, go to §7.
4. Pick **`…lackHole 1 + …lackHole 2`**. (Names are truncated to their last 13
   characters — the strip has 34 px of label; `devices.ts:115-119`.)

**What you just authored.** `repointInput` (`Plane.tsx:150-165`) removed any
previous `deviceInput → channelIn` route for this channel and added
`{src: deviceInput(1, 2), dst: channelIn(<this channel>)}` to the map, marked it
dirty, and `repatch` (`Plane.tsx:327-345`) removed the engine's old cable and
sent the new one. An ordinary route, of a kind that shipped in P1.

---

## 6. Hear it — the step that is missed

**A strip does not monitor its input until you tell it to.** A fresh strip is
created with `monitor: false` (`web/src/plane/stripOps.ts:123-133`), and the
comment there says why: a strip that arrives listening is a strip that arrives
feeding back next to a live mic (D-WZ-MON-01). The engine enforces it — a
`deviceInput → channelIn` cable is multiplied by that strip's monitor curve
(`slengine/src/sl_channel.cpp:584`, curve materialised at `:492-503`).

So, one of:

- **Press `MON`** on the strip (`Strip.tsx:1048-1060`). You should now hear the
  other app.
- **Press `REC`.** For a device-input source the engine opens the monitor by
  itself (`slengine/src/sl_engine.cpp:640-653`) — the gesture that starts the
  capture is also the one that lets you hear it.

⚠️ **The strip meter will not help you before you do this.** The meter is taken
off the same post-gate, post-level samples as the record tap
(`sl_channel.cpp:728-737`) — it is a *contribution* meter, not an input meter. A
strip receiving a loud signal with `MON` dark reads exactly zero. There is no
surface anywhere that shows an input arriving while you are not monitoring it
(row **P9-5f**).

**The check that confirms it worked:** the strip's status line reads
`records: …lackHole 1 + …lackHole 2` (`stripOps.ts:421`, name from
`channelLabel`, `devices.ts:101-113`).

---

## 7. Record it

Press **REC** on a tape strip. With an input patched, the default tap is the
input itself — `RECORD_SOURCE.deviceInput = 0` (`stripOps.ts:142`), captured
*before anything renders*, so the take is that block's input
(`slengine/include/sl_engine.h:292-294`). What lands on the tape is the other
app's audio clean, not your monitor mix, and not the app's audio summed with
whatever else the strip is doing.

⚠️ **Do not change `REC captures` to `this strip's bus` for this path unless you
mean it.** The bus is downstream of the monitor gate, and record-start only opens
the monitor for a *deviceInput* source, deliberately (`sl_engine.cpp:645-648`).
So bus-tap + `MON` dark = a take of perfect silence. Read from the two files
cited; **not proven with audio** — P9-G1.

---

## 8. When it does not work

A silent routing chain is the hardest thing in this app to debug, so read the two
surfaces that exist before guessing:

- **The plane's note line** — the plane's one error surface (P3-U6, P3.5-E9a).
  After loading a session it says why a deck is quiet; dispatcher refusals land
  there as `<method> refused — <msg>`.
- **`DSP` on the master bar** (P11-5, `web/src/plane/Master.tsx`, right of the
  LIM lamp). `—` means no HotFrame has arrived at all, i.e. **no engine** — the
  problem is upstream of everything in this document. A percentage means the
  audio thread is running.

| What you see | What it means | What to do |
|---|---|---|
| ⋯ menu has no `input device` section | fewer than two input devices are known (`Strip.tsx:624`) | driver not installed, or installed after launch (§2c) — restart the app |
| the device is listed, you pick it, and **everything goes silent with no message** | the switch failed and the render callback is detached — see the box below | restart the app; fix the rate (§2a) first |
| `record from` says *"no inputs on this device"* | the open device reports zero active input channels | the switch did not take, or the device presents no inputs; check Audio MIDI Setup |
| status line reads `input N — not on this device` | a route left over from a device with more channels (`devices.ts:101-113`) | re-pick the input from ⋯ |
| strip silent, `MON` dark, meter at zero | the monitor gate — this is the normal state, not a fault (§6) | press `MON` |
| strip silent, `MON` lit, `DSP` reads `—` | no engine / no HotFrame | not this path: the sink never started (P3-U1 territory) |
| strip silent, `MON` lit, `DSP` reads a percentage | audio is not arriving at the virtual device | the other app is not actually outputting to it — check its output setting, and that macOS did not move it |
| you hear it twice, hollow or flanged | Multi-Output plus Scoopy's monitor (§4) | mute one of the two |
| clicks, dropouts, slow pitch drift | the two devices are on different clocks | put BlackHole in a Multi-Output/Aggregate with drift correction, or accept it; nothing in the app resamples an input (D-WZ-RATE-01) |

### ⚠️ The silent switch — the one failure with no door

`AudioIO::setDevices` detaches the render callback at `host/src/AudioIO.cpp:102`
and **every** error return between `:110` and `:116` returns *without*
re-attaching it. A `setInput` that fails therefore leaves the app with **no audio
at all** — not the previous device, nothing — and there is no other trigger that
re-attaches. The reason is produced correctly: `SlDispatch.cpp:1016-1019` returns
it, and `setInputDevice` stores it in `useDeviceStore.error`
(`web/src/plane/devices.ts:71-80`).

**No component in the tree reads that field.** `error` is written and never
rendered — the only consumers of the device store take `channels`, `devices` and
`current` (`Strip.tsx:230-232`, `Inspector.tsx:102`). The schema comment on that
very field says what it is for: *"a picker that silently fails leaves the user
staring at a device that did not change"* (`web/protocol/schema.ts:1972-1973`).
Today it is worse than that: the user stares at a device that did not change,
with the audio off, and nothing on screen. Recovery is to pick a device that
works, or quit and relaunch. Rows **P9-5b** (re-attach) and **P9-5c** (surface
the error).

The same shape exists one level up: `Backend::Backend` stores the open failure in
`deviceError` (`shell/src/MergedApp.cpp:76`, declared `MergedApp.h:68`) and
**nothing ever reads it**, so an interface that cannot run at 48 kHz gives you an
app that launches, looks completely normal and is silent, with the reason in a
string no one prints. Row **P9-5d**.

---

## 9. Where this is worse than the native path (P10)

Stated so the interim is not mistaken for the destination:

1. **One stereo pair.** §2b. The native device is 16 channels / 8 stereo pairs
   (D-WZ-VDEV-01), so a set can keep several apps apart.
2. **Not per-app.** BlackHole is a bus: everything pointed at it sums, and you
   cannot separate them afterwards. Loopback buys per-app selection for money;
   the native path selects a *process* (`WZ_SRC_PROCESS` in
   `host/include/wz_capture.h`) with nothing to configure in the other app.
3. **You must configure the other app**, and undo it afterwards. A process tap
   does not touch it.
4. **The device slot is spent.** Scoopy opens ONE duplex device
   (`AudioIO.cpp:20-22`). While BlackHole is the input, your interface's
   microphone inputs are gone. You cannot have another app's audio *and* a live
   mic on this path.
5. **Rate coupling.** Everything must live at 48 kHz (§2a). The native virtual
   input is an asynchronous source and is ASRC'd into the graph by design
   (D-WZ-RATE-01), so it never has to agree with anybody.
6. **Latency nobody shows you.** The virtual device adds a buffer on top of the
   other app's own output latency, and no surface in Scoopy measures or displays
   it. Per-path latency is P9-4; today the cables show a per-cable figure only,
   and `feedbackMs()` still hardcodes 512/48000 (P9-3).
7. **The session does not remember what the device was.** A route stores
   `deviceInput` + a channel *index*, never a device name
   (`mapApply.ts:71-77`). Reopen the map on another machine and the strip points
   at whatever input 0/1 is there — usually a microphone — and says so with a
   perfectly ordinary channel name. `channelLabel` can only warn when the index
   is out of range. Row **P9-5g**.

---

## 10. What P10 changes

When the native path lands, §§3–5 collapse to: choose **Wizard Out** pair *n* in
the same picker. §§2a/2b/9-1..9-6 stop applying. This document is then a
historical note, and the row that retires it belongs to P10.

Until then this is the supported answer, and D-WZ-VDEV-02's own words are the
reason it is written down rather than left to be discovered: *"naming the interim
path costs a paragraph and unblocks users now."*
