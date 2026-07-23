# Capture spec — macOS TCC empirical runbook (P0-R)

*Status: **awaiting-user**. This is the "cheapest useful next step" from
feasibility §8 — build and run [AudioCap](https://github.com/insidegui/AudioCap)
locally and record what the TCC system-audio-capture permission actually does.
The blanks below are the deliverable; fill them from what you observe. Nothing
in P0/P1 depends on this — the first code that does is **P2** (macOS process
taps). The loop keeps building unblocked items until then.*

## Why this exists (the one risk that can't be read off a doc)

System-audio capture is its own TCC permission category, and **there is no public
API to query or pre-request it** (feasibility §3.3). Everything else in the
capture design is well-documented; this one behavior — exact prompt text, when it
fires, how denial recovers — is only knowable empirically. Getting it wrong is
cheap to discover now and expensive to discover at P2.

Ground truth references (re-check each at build time — every macOS claim is one
OS release from moving, feasibility §"API churn"):
- feasibility §3.2 (process-tap call sequence) · §3.3 (the permission sharp edge)
- Apple: `AudioHardwareCreateProcessTap`, `CATapDescription`, Core Audio taps
- [AudioCap](https://github.com/insidegui/AudioCap) — the community reference

## The runbook

### 1. Build & run AudioCap

```sh
git clone https://github.com/insidegui/AudioCap.git
cd AudioCap
# Open in Xcode (needs macOS 14.4+ and a recent Xcode), set your signing team,
# build & run. The binary MUST be signed for TCC to work at all (feasibility §3.3).
```

- macOS version you tested on: `____________`
- Xcode version: `____________`
- Did it build & run without source changes? `____________`
- Signing: personal team / Developer ID / other: `____________`

### 2. First-run prompt — what it says and when it fires

Trigger a capture in AudioCap (start recording a process or the system mix).

- **Exact prompt title + body text** (copy verbatim, it's the string we must
  match the *spirit* of in our own `NSAudioCaptureUsageDescription`):
  > `____________________________________________________________`
- **When did it fire** — at app launch, at first "record", at first tap create?
  `____________`
- Buttons offered (Allow / Don't Allow / Open System Settings / …):
  `____________`
- Which **System Settings** pane does the grant live under (e.g. Privacy &
  Security → ?): `____________`
- Is it the same category as microphone, or distinct? `____________`

### 3. Denial + recovery

Deny the prompt, then try to capture again.

- What happens on a denied capture attempt — silent zeros, an error, a second
  prompt, nothing? `____________`
- After denial, does re-attempting re-prompt, or is it silently blocked until
  changed in System Settings? `____________`
- Steps that actually restore access: `____________`

### 4. `tccutil` reset behavior

```sh
# The service name for system-audio capture (confirm it — it is NOT "Microphone"):
tccutil reset  ____________   <your.bundle.id>
```

- Exact `tccutil reset` command that clears this permission: `____________`
- After a reset, does the next capture re-prompt cleanly? `____________`
- Does reset need the bundle id, or is a global reset required? `____________`

### 5. Info.plist reality check

- Confirm `NSAudioCaptureUsageDescription` is the correct key (feasibility §3.3
  says it is **not** in Xcode's Info.plist dropdown — must be hand-typed):
  `____________`
- Does an **empty or missing** usage string suppress the prompt / crash / get
  rejected? `____________`

### 6. Screenshot the prompt

Attach a screenshot of the actual prompt to this file's directory (or paste the
path): `docs/specs/____________.png`

## What we adopt from the result (fill after the run)

- **Prompt timing → UX rule.** The risk register commits to *arm-time prompting,
  surfaced inline in the source picker*. Confirm the OS lets us defer the prompt
  to first-tap (so the picker can host it) rather than forcing it at launch:
  `____________`
- **Private-TCC calls stay behind a build flag, default off** (signed risk
  decision). Did AudioCap need private calls for the basic (non-preflight) path,
  or only to *query* status? `____________`
- **`NSAudioCaptureUsageDescription` copy** we will ship (draft it from the
  observed system prompt's framing): `____________`

## Decisions this run should let us sign (parked until then)

- Whether P2's source picker can own the first-run prompt (arm-time) with no
  private API — or whether a preflight (private, flagged) is required for a decent
  UX. Record as a `D-WZ-TCC-*` decision in `docs/DECISIONS.md` once observed.
