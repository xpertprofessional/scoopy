# P1 spike — does a JUCE WebView host scoopy's real UI?

*Answers `P1-KICKOFF.md` §3. Written 2026-07-24 from captured evidence, not
impressions: the spike app (`spike/`, temporary) hosts scoopy's **committed**
`webdist/` — the same bytes the shipping mac app runs — against a stub
dispatcher, and every finding below is a line in a probe log.*

**Headline: no disqualifier. JUCE WebView hosts scoopy's real UI, the whole
dormant JuceLink contract works, and multi-window works — so the decision gate
resolves to multi-window, not panel docking.** Two of the four questions
(keys, drag-in) are physically un-automatable in this environment and need a
human pass; the app is instrumented so that pass is one command.

## How to reproduce

```
cmake --build build --target ScoopySpike -j 8
./build/spike/ScoopySpike_artefacts/Release/ScoopySpike.app/Contents/MacOS/ScoopySpike --probe --probe-seconds=12
node spike/summarize-probe.mjs
```

The app opens two windows (`debug`, `grid`), boots the real bundle in each,
runs the probe, appends to `~/wizard-spike-probe.jsonl`, and quits.

## Verdicts

| Q | Question | Verdict | Evidence |
|---|---|---|---|
| Q0 | Real bundle mounts on a real backend | **PASS** | both windows: `hasJuceBackend=true`, React `#root` mounted, **0 page errors, 0 unhandled rejections** |
| Q1 | Key-event fidelity | **NEEDS HUMAN** | not automatable here — see below |
| Q2 | Multi-window | **PASS** | 2 `DocumentWindow`s, each an independent React root with its own live JuceLink |
| Q3 | File drag-in | **NEEDS HUMAN** | not automatable here — both sides instrumented |
| Q4 | OPFS | **PASS, with a shape constraint** | available; writes work **only off the main thread** |

### The JuceLink contract — all five lanes, machine-verified

Every message name in the P1-KICKOFF §3 contract was exercised end-to-end, in
**both** windows independently:

| Lane | Direction | Result |
|---|---|---|
| `slCommand` | web → native, reply | `getCapabilities` answered; reply survived `JuceLinkBase`'s **strict** result parse |
| `slHotFrame` | native → web | 83 frames in ~3 s (≈30 Hz), length **284** (matches `HOT_FRAME_LENGTH`), counter advancing |
| `slEvent` | native → web | received, `type: "settingChanged"` |
| `slUiState` | native → web | received, `topic: "background"` |
| `slParam` | web → native | coalesced write arrived intact: `{p:"deckVolume", deck:0, v:0.42}` |

This matters more than any single question below: the dormant `JuceLink` in
scoopy's `engineLink.ts` (merge P0-A) needed no modification. It bound to
`window.__JUCE__.backend` and worked. The committed `webdist/` already contains
that code path (`__JUCE__`, `slCommand`, `slHotFrame`, `__juce__invoke` are all
in the bundle), so **no scoopy rebuild is required to light the merged shell up.**

Command traffic observed from the real UI during boot: `getUiState`×38,
`getCapabilities`×3, `getSetting`×3, `publishMenuTree`×1 — the stub answers
only `getCapabilities` and fails the rest honestly, and scoopy's boot path
absorbs those failures exactly as designed (`try/catch` in `loadAndApplyTokens`,
`.catch(()=>{})` in `attachCapabilities`/`attachMidiLearn`/`attachScenePins`).
That is why the error count is zero.

### Q2 — multi-window: PASS, and it decides the gate

Two `juce::DocumentWindow`s, each owning its own `WebBrowserComponent`, each
loading the same bundle, both live simultaneously: independent React roots,
independent JuceLinks, both receiving all three push lanes and both issuing
commands. Panel identity is injected per-window with a user script setting
`window.__slPanel`, which is the **same hook the mac shell already uses**
(`App.tsx` reads `window.__slPanel ?? params.get("panel")`) — so scoopy's panel
routing needs no merge-specific change.

**Decision gate → multi-window.** The one-window panel-docking fallback is not
needed. F1–F4 / FX editors can each be a `DocumentWindow`, matching the mac
app's existing shape (one webview per panel).

### Q4 — OPFS: available, but writes are worker-only

- `navigator.storage.getDirectory()` — **works**, returns a usable handle.
- `FileSystemFileHandle.createWritable()` — **absent** (`is not a function`).
- `createSyncAccessHandle()` inside a `Worker` — **works**; the probe wrote and
  read back its bytes in both windows.

This is WebKit's documented OPFS shape (same as Safari), not a JUCE defect.
Consequence for the merge: scoopy's browser-companion OPFS library code cannot
be reused as-is on the main thread — it needs a worker, **or** (the better
answer for the merged desktop shell) it is replaced by native file access,
which is what `capabilities.fileSystem = true` on this host would mean anyway.
Not a disqualifier, but it is a real constraint on which code path survives.

One finding worth recording because it looks like a bug and is not: **all
webviews in the app share one origin, hence one OPFS store.** Two windows
opening a sync access handle on the *same* filename fails with "The object is
in an invalid state" — that is OPFS working as specified, not contention
damage. The first probe run hit exactly this and reported a false OPFS failure;
per-window filenames cleared it. Any real library code must namespace per panel
or coordinate, and this is equally true of the shipping mac app.

Also captured: `crossOriginIsolated=false` (so no `SharedArrayBuffer`) and
`AudioWorklet` present. Neither blocks the merged shell, whose engine is native
rather than WASM — but the WASM companion path would care about the first.

## What still needs a human pass (P1-KICKOFF law 5)

I could not drive OS-level key or drag events: `osascript`/System Events is
refused in this environment (`-1743 Not authorised to send Apple events`), and
synthetic DOM events would prove nothing about the native→web path, which is
the thing actually in question. Both were attempted; neither is a code defect.

**Run this, then do the two actions below while the windows are up:**

```
./build/spike/ScoopySpike_artefacts/Release/ScoopySpike.app/Contents/MacOS/ScoopySpike --probe --probe-seconds=90
```

**Q1 — keys.** Click the `debug` window, then:
1. Press `a`, `s`, `d` once each.
2. **Hold `q` for ~2 seconds**, then release.
3. Press `⌘S`.
4. If you have a non-US layout available, switch to it and press the same
   physical keys again.

What the log must show for a PASS: `code` is the **physical** key
(`KeyA`/`KeyS`/`KeyD`/`KeyQ`) and is layout-independent in step 4; the held `q`
produces `repeat:true` on the auto-repeats (so a cue is not retriggered); and
every `keydown` has a matching `keyup` with `held` draining back to empty.

**Q3 — drag-in.** Drag an audio file from Finder onto the `grid` window.
The log tells you which side received it: `web-drop` (the page owns file drop —
handle it in JS via `dataTransfer`) or `native-filesDropped` (JUCE sees it —
handle it in the shell). If **neither** appears, the webview swallowed the drag
and file-drop needs a different mechanism — that is the only outcome here that
would change P1's plumbing, so it is worth the 30 seconds.

Then `node spike/summarize-probe.mjs` prints the filled-in table.

Everything in this document that concerns what is *on screen* is unverified
visually — I cannot see the UI. What is verified is that the bundle mounted,
every transport lane carried real payloads, and nothing threw.

## Consequences for P1 plumbing

1. Host scoopy's UI in `DocumentWindow` × `WebBrowserComponent`, one per panel,
   `window.__slPanel` per window. No docking layer.
2. `CommandDispatch` grows an `sl`-named surface; the reply envelope is already
   right (`{ok, result?, error?}` — the shared envelope, P0-A).
3. The HotFrame emitter must produce **284** slots at 30 Hz for schema v86, and
   every index must come from codegen (SL-ABI-V3 §8), never hand-computed.
4. `getCapabilities` must answer honestly per host — the UI renders native-only
   surfaces inert from it, which is the mechanism that lets the merged shell
   light up before every command exists.
5. The spike's stub proves the *shape*; it has no engine. P1 plumbing replaces
   it with the vendored core behind SL ABI v3.

## Disposal

`spike/` and this app are temporary and deleted once P1 plumbing lands
(`WIZARD_BUILD_SPIKE=OFF` disables the target meanwhile). The probe log path is
`~/wizard-spike-probe.jsonl`.
