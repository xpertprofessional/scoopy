# P1 spike — does a JUCE WebView host scoopy's real UI?

*Answers `P1-KICKOFF.md` §3. Written 2026-07-24 from captured evidence, not
impressions: the spike app (`spike/`, temporary) hosts scoopy's **committed**
`webdist/` — the same bytes the shipping mac app runs — against a stub
dispatcher, and every finding below is a line in a probe log.*

**Headline: no disqualifier. JUCE WebView hosts scoopy's real UI, the whole
dormant JuceLink contract works, and multi-window works — so the decision gate
resolves to multi-window, not panel docking.**

**All four questions are now answered.** Q2 and Q4 were machine-captured; Q1
(keys) and Q3 (drag-in) were confirmed by the user's human pass on 2026-07-24,
§Q3 also carries a **retraction**: a "drop reloads the webview" defect I
reported was a false correlation, disproved by a clean drop-only run.

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
| Q1 | Key-event fidelity | **PASS** | 187 keydown (150 auto-repeat) / 28 keyup; physical `code`, correct `repeat`, matched hold |
| Q2 | Multi-window | **PASS** | 2 `DocumentWindow`s, each an independent React root with its own live JuceLink |
| Q3 | File drag-in | **PASS** | the **page** receives the drop (filename + MIME), not JUCE. No reload, no navigation — an earlier "reload" claim is retracted below |
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

## Q1 — keys: PASS

Confirmed by human pass (the agent cannot drive OS-level keys — `osascript`/
System Events is refused with `-1743`, and synthetic DOM events would not
exercise the native→web path that is actually in question).

Captured: **187 keydown (150 of them auto-repeat) and 28 keyup**, codes
`KeyA · KeyS · KeyD · KeyQ · MetaLeft · ShiftLeft`. All three properties the
Serato layout depends on hold:

- **`event.code` is the physical key** — `KeyA` while `event.key` is `"a"`, so a
  binding survives a non-US layout.
- **`event.repeat` is correct** — `false` on the first press, `true` on every
  auto-repeat, so a cue can be suppressed on repeats rather than retriggered.
- **A held key is a state, not an edge** — the held `q` produced 66 keydown
  (64 repeats) and exactly one keyup, with the `held` set draining correctly.
- `defaultPrevented` was `false` throughout: the webview is not swallowing keys.

Bonus signal: `forwardKey` was called 4 times, so scoopy's own native
key-forwarding relay (`useNativeKeyForwarding`) engaged against this backend
unmodified.

## Q3 — drag-in: PASS

Dragging an audio file (`HERMAN.wav`) onto the grid window produced
**`web-drop` × 2 and `native-filesDropped` × 0**, with the payload intact:
`files: ["HERMAN.wav"]`, `items: ["file:audio/x-wav"]`.

**Verdict: the PAGE owns file drop.** In P1 it must be handled in JS via
`dataTransfer` — a JUCE `FileDragAndDropTarget` on the window never sees it,
because the WebView consumes the drag first. Filename and MIME type are both
available page-side, so a drop-to-load feature has what it needs.

Nothing visible happens on drop in the spike, and that is correct: the stub has
no engine, so there is no code to load a file into. The drop is captured, not
acted on.

### ⚠️ CORRECTION — the "drop reloads the webview" claim was wrong

An earlier revision of this document recorded a **defect: file drop reloads the
webview**, based on the grid page booting a third time 7 records after a drop.
**That was a false correlation and is retracted.**

A clean drop-only run (2 drops, **0 keystrokes**) produced **0 reloads and no
navigation attempt at all** — no `file://` ever reached `pageAboutToLoad`. The
run that showed the reload also contained **187 keystrokes including Meta**, so
the overwhelmingly likely cause was a stray **⌘R**, not the drop. The reload was
attributed to the nearest preceding drop purely on proximity, which is not
evidence of causation.

Two things follow, and the second matters:

- **A drop does not navigate the WebView.** Drop-to-load is unblocked; there is
  no drop defect to design around.
- **The navigation guard would not have prevented that reload anyway.** ⌘R
  reloads the *same* root URL, which the allowlist permits. A guard that was
  justified by a defect it could not have stopped was justified badly.

The guard is nonetheless **kept**, on its own merits rather than that one: the
shipping shell had *no* navigation policy whatsoever, so a link, a redirect, or
a `javascript:` URL could take the running app away and lose its state. That is
a real hole, cheap to close, and now unit-tested. It is defence in depth — not
a fix for an observed drop failure.

## Consequences for P1 plumbing

0. **The navigation guard is already in the shell** (`c1176db`) — kept as
   defence in depth, NOT as a drop fix (see the §Q3 retraction). Drop-to-load is
   unblocked: handle it page-side via `dataTransfer`, which carries filename and
   MIME.
1. Host scoopy's UI in `DocumentWindow` × `WebBrowserComponent`, one per panel,
   `window.__slPanel` per window. No docking layer. File drop is handled in the
   PAGE via `dataTransfer` (Q3) — not with a native `FileDragAndDropTarget`.
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
