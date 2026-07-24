# DSP baseline — captured at C0, before the filter/clipper work

Measured on Apple Silicon, `Release`, 48 kHz, by `scoopy_filter_test` and `scoopy_clipper_test`:

```
cmake -B engine/build -DCMAKE_BUILD_TYPE=Release && cmake --build engine/build
./engine/build/scoopy_filter_test
./engine/build/scoopy_clipper_test
```

Every later commit in this series is graded against these numbers, and the before/after pair goes in
the commit message. Absolute ns/sample figures are machine-specific; the **ratios** are the claim.

---

## Filter — `NativeToneFilter` (RBJ cookbook biquad, DF2T)

### Magnitude response (dB, input 0.05 so the Q>1.5 output `tanh` stays transparent)

|  mode / tone / Q       |    20 |    80 |   320 |    1k |    2k |    4k |    8k |   16k |
|------------------------|-------|-------|-------|-------|-------|-------|-------|-------|
| lowPass  60  Q=0.71    | -0.00 | -0.00 | -0.05 | -3.15 |-12.63 |-24.74 |-38.06 |-57.15 |
| lowPass  60  Q=4       | -0.00 |  0.05 |  0.92 | 11.76 |-10.11 |-24.23 |-37.96 |-57.14 |
| lowPass  60  Q=16      | -0.00 |  0.05 |  0.96 | **+22.03** |-10.00 |-24.21 |-37.95 |-57.14 |
| highPass 60  Q=4       |-54.88 |-30.56 | -1.77 |  2.07 |  0.47 |  0.11 |  0.02 | -0.00 |
| bandPass 50  Q=4       |-44.60 |-32.49 |-19.24 | -4.40 |-17.89 |-25.33 |-32.29 |-41.90 |

**+22 dB of uncompensated resonant gain at Q=16.** That is the peak the output `tanh` is there to
catch, which is why high Q currently squares off into a clipped tone rather than ringing.

An RBJ LPF and a TPT/ZDF SVF lowpass are the same bilinear transform of the same 2-pole prototype,
so **this table should NULL across the SVF swap** (to within ~0.05 dB, minus the deleted `tanh`).
A nulled table is the swap being *correct*, not the swap doing nothing — the wins are below.

### Modulation — and a metric that was measuring the wrong thing

The first version of this test reported **peak overshoot** after a cutoff change and showed +30.78 dB
on a Q=8 bandpass sweep. That number is real but it is **not an artifact**: sweeping a resonant filter
off the probe frequency makes the output swell and ring down, and that swell is correct, wanted,
physical behaviour that any filter — analog, biquad or TPT — must produce. The SVF reported +31.10 dB
on the same test, because both topologies were right. **A metric that cannot distinguish the two
topologies cannot grade a change between them.** It was replaced.

The artifact a direct form actually commits is a **discontinuity**, not an overshoot: its state is a
convolution of past samples weighted by the *current* coefficients, so changing them reinterprets the
stored energy and the output can STEP. The replacement metric measures that step against the signal's
own slew rate. **0 dB = the change was as smooth as the signal already was.**

The ruler took three attempts to get right, and the wrong versions were *confidently wrong*, so both
failures are recorded here:

- **v1 measured peak overshoot.** It scored the biquad at +30.78 dB and the SVF at +31.10 dB — because
  both were correct. A metric that cannot separate the two things it is comparing cannot grade a
  change between them.
- **v2 sampled one instant, at one phase.** Whether a hard switch shows a big step depends entirely
  on where in the probe's cycle it lands; a lucky phase scored an outright click at −36 dB, *better*
  than a proper crossfade. It also normalised by the "before" signal's slew, so fading from a quiet
  response into a loud one looked enormous no matter how gently it was done.
- **v3 (shipped)** sweeps 16 switch phases, takes the worst step over the whole transition window, and
  normalises by the louder of the two steady states. ~0 dB = the transition injected nothing beyond
  the signal's own motion.

| change (220 Hz sine @ 0.3)  | hard switch | with crossfade (C2) |
|-----------------------------|-------------|---------------------|
| tone: LP open→closed, Q=0.7  | −0.10 dB    | −0.10 dB |
| tone: LP open→closed, Q=16   | −3.97 dB    | −3.97 dB |
| MODE: LP → HP, Q=4           | **+31.18 dB** | **+1.10 dB** |
| MODE: LP → BP, Q=8           | +30.77 dB   | +1.13 dB |
| MODE: LP → notch, Q=16       | +5.95 dB    | −0.05 dB |
| MODE: BP → LP, Q=16          | +30.96 dB   | +0.03 dB |

Two honest findings, both of which cut against the original story:

1. **The DF2T objection was already mitigated — by the chase.** `setParameters` only snaps on *first*
   activation; an ordinary tone change ramps the coefficients over the 64-tap chase (~1.35 ms), so
   neither topology ever sees a one-sample coefficient jump. The tone rows are identical with and
   without the crossfade, and both sit at or below the signal's own slew. The theoretical direct-form
   artifact is **not** what was wrong with this filter in practice — the CPU was.

2. **A MODE change steps hard — in BOTH topologies — and that is inherent, not a topology defect.**
   Switching mode changes which node you tap (`m0,m1,m2`), so the output value changes
   discontinuously even though the SVF's state is perfectly physical. "Click-free by construction"
   is **false** and should not be repeated.

   What IS true: because every response comes off the *same* two state variables, an SVF can
   **crossfade** between modes by lerping three scalars over ~1.35 ms — which is what C2 does, and
   what takes those +31 dB steps down to +1 dB. A biquad cannot do this at all without running two
   filter instances in parallel. The SVF makes a click-free live mode change *possible*; it does not
   make it free, and it costs ~0.8 ns/sample.

### Cost (ns/sample, stereo, one voice) — measured back-to-back on the same machine

| config                       | biquad (C0) | SVF (C1)  | change |
|------------------------------|-------------|-----------|--------|
| lowPass Q=0.707              | 59.4        | **11.6**  | **−5.2×** |
| lowPass Q=16                 | 88.9        | **11.7**  | **−7.6×** |
| bandPass Q=4                 | 53.1        | **11.5**  | **−4.6×** |
| bypassed (\|tone\| ≤ 0.5)    | 4.8         | 4.6       | —      |

0.29 % of a core per voice → **0.056 %**. 128 ringing filtered voices: ~37 % of a core → **~7 %**.

⚠️ **Post-review correction (Fable pass): that headline is the cost of a filter SITTING STILL.**
Under a full-depth filter LFO, `setParameters` receives a new tone every sample, which re-runs the
tone→Hz mapping (`exp` + `pow`) and keeps the chase + `tan()` alive — measured:

| config | ns/sample |
|---|---|
| static, engaged | 11.2 |
| **LP Q=4, full-depth LFO** | **67.2** |
| **BP Q=8, full-depth LFO** | **49.3** |

So the honest claim is: **5–7× cheaper at rest, ~parity with the old biquad under heavy modulation.**
Not a regression (the biquad paid its transcendentals unconditionally), but the original benchmark
suite had no modulated row, so it proved the common case and silently implied the worst one. The
cheap follow-up if modulated voices ever matter: decimate the mapping refresh (recompute Hz every
16–32 samples and let the existing chase interpolate — it already smooths far more than that), or a
polynomial `tan`.

The cost at rest is flat across mode and Q, because it is just the SVF kernel. Two things got it
there, and the second was worth more than the first:

- The trapezoidal kernel is cheaper than the RBJ biquad (no `sin`/`cos`, no per-sample normalising
  divide) and needs no `tanh`.
- **The transcendentals were not in the filter — they were in the tone→Hz mapping**, and that mapping
  is a pure function of `(tone, mode, sampleRate)`. It was being recomputed (`exp` + `pow` + 2 `log`)
  every sample even when nothing moved. Caching it, and skipping the chase entirely once it has
  settled onto its target, took the SVF from 38.9 ns to 11.6 ns. A naive port that kept the old
  structure would have captured only a third of the available win.

---

## Clipper — `NativeMasterDrive`

Full-scale sine, **not** bin-aligned (see the header of `clipper_test.cpp`: a bin-aligned sine makes
aliases land on the same bins as true harmonics, so they cannot be separated even in principle —
that construction reports a fictitious −170 dBc). Kaiser β=20 window.

`sub-fund` = loudest alias bin **below the fundamental** — the inharmonic "digital fizz" you actually
hear. It is the column that matters; SNR is dominated by near-Nyquist energy that is nearly inaudible.

| config                              | probe  | SNR dB | sub-fund dBc |
|-------------------------------------|--------|--------|--------------|
| DEFAULT: hard, OS 2×, drive 1.0     | 1660Hz | 139.2  | -159.7       |
| DEFAULT: hard, OS 2×, drive 1.0     | 4186Hz | 139.5  | -168.1       |
| hard, OS 2×, drive 2.0              | 1660Hz |  46.5  | -66.6        |
| hard, OS 2×, drive 2.0              | 4186Hz |  42.2  | -53.8        |
| hard, OS 2×, drive 4.0              | 1660Hz |  44.0  | -59.2        |
| hard, OS 2×, drive 4.0              | 4186Hz |  29.1  | -44.9        |
| **hard, OS off (ADAA LIVE), 4.0**   | 1660Hz |  40.0  | **-96.4**    |
| **hard, OS off (ADAA LIVE), 4.0**   | 4186Hz |  28.7  | **-66.1**    |
| hard, OS 4×, drive 4.0              | 1660Hz |  45.1  | -57.0        |
| hard, OS 4×, drive 4.0              | 4186Hz |  29.4  | -48.0        |
| soft, OS 2×, drive 4.0              | 4186Hz |  28.1  | -40.5        |

### Cost

| config                | ns/sample | % of one core |
|-----------------------|-----------|---------------|
| hard, OS off (ADAA)   | **10.31** | 0.05 %        |
| hard, OS 2× (naive)   | 92.37     | 0.44 %        |
| hard, OS 4× (naive)   | 197.04    | 0.95 %        |
| soft, OS off          | 13.92     | 0.07 %        |

### What this proves

1. **The shipping default is strictly worse AND 9× more expensive than turning oversampling off.**
   `OS off` is the only config in which `processADAA` actually runs — with `oversample >= 2` the
   oversampler is handed the *naive* `shapeCurveDecoupled` lambda (`NativeMasterDrive.cpp:149-151`),
   so the ADAA in that file is dead code in the product. At 1660 Hz / drive 4: **−96.4 dBc (ADAA, 10 ns)
   vs −66.6 dBc (naive 2× OS, 92 ns).** 30 dB better, 9× cheaper. ADAA and oversampling are currently
   mutually exclusive, and we shipped the wrong one.

2. **4× oversampling buys almost nothing over 2×** (−48.0 vs −44.9 dBc at 4186 Hz) — the signature of
   a decimation filter whose transition band is far too wide. `kSubTaps = 16` spans only 16 input
   samples, giving ~−12 dB rejection just above Nyquist, exactly where a clipper's harmonics are
   densest. Paying 2× the MACs to move the shaper's own aliasing further out cannot help when the
   filter can't reject it either way.

3. **At the default drive of 1.0 the master clipper is nearly inert** — a full-scale sine only grazes
   `ceiling = 1.0`. The clipping users actually hear today is therefore NOT this stage: it is the
   deck-sum `std::clamp(±1.0)` at `NativeAudioEngineCore.cpp:6646` (before the crossfader) and the
   raw `±1.0` clamp at `NativeMasterDrive.cpp:169-170` (last thing before the DAC). Neither is
   anti-aliased at all.

### PASSBAND — the column that reframes all of the above

Alias figures alone are **actively misleading**, and this table is why. ADAA does not just suppress
aliasing, it **low-passes the signal**. For a hard clip below the clip point (`|u| < 1` — which is
most of the music, most of the time) the 1st-order ADAA formula collapses algebraically:

> `F(u) = u²/2`  ⇒  `(F(u) − F(u₋₁)) / (u − u₋₁) = (u + u₋₁) / 2`

A two-tap moving average. Measured at drive 1.0 / ceiling 1.0, where the shaper is doing *nothing*,
so every dB below is damage to the dry signal:

| config | 1k | 5k | 10k | 15k | 18k | 20k |
|---|---|---|---|---|---|---|
| **hard, OS off (ADAA runs)** | −0.02 | −0.47 | **−2.01** | **−5.11** | **−8.34** | **−11.74** |
| hard, OS 2× (naive) | −0.00 | −0.00 | −0.00 | −0.00 | −0.28 | −1.48 |
| hard, OS 4× (naive) | −0.00 | −0.00 | −0.00 | 0.00 | −0.25 | −1.41 |
| soft, OS off (no ADAA) | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | −0.00 |

**The first row is a shipping defect.** `OS off` is the only configuration in which our ADAA actually
runs, and selecting it in the UI does not merely trade aliasing for CPU — it drops 15 kHz by 5 dB
and 20 kHz by nearly 12 dB, on the master bus, permanently, whether or not a single sample is being
clipped. Its beautiful −96.4 dBc alias figure was bought with tone.

This also kills the obvious conclusion ("just default to OS off — it's 30 dB cleaner and 9× cheaper").
It is cleaner *and* duller, and the dullness is unconditional. The literature's insistence that ADAA
be run at **2× minimum** is not a refinement; the oversampling is what pushes this droop out of the
audible band.

### Why C4 was not shipped as planned

The plan said: put ADAA inside the oversampler. Built and measured, it is a **bad trade on this
oversampler**:

| at 2× | alias @1660 | alias @4186 | 15 kHz droop | cost |
|---|---|---|---|---|
| naive-in-OS (ships today) | −59.2 | −44.9 | ~0 dB | 84 ns |
| ADAA-in-OS (built, reverted) | −61.8 | −57.9 | **−1.09 dB** | **204 ns** |

1 dB of real treble and 2.4× the CPU, for 2.5 dB of alias at 1660 Hz. And the root cause is not the
shaper — **it is the oversampler, and more taps do not fix it.** Sweeping the filter length with
everything else held:

| kSubTaps | 16 | 32 | 64 |
|---|---|---|---|
| alias floor @1660, 2× | −60.3 | −61.8 | −68.6 |

Even 64 input taps (128 at 2×) cannot approach the ~−103 dBc the literature reports for ADAA+2×. The
limit is the *design*: a linear-phase windowed-sinc whose cutoff sits exactly at Nyquist spends its
entire transition band straddling the region a clipper's harmonics are densest in, and no tap count
moves the cutoff.

**So the order changed.** The oversampler gets replaced with a 2-path polyphase IIR halfband (hiir,
Laurent de Soras, WTFPL — steeper, near-zero latency, cheaper than this FIR, ARM NEON path), and ADAA
moves inside the loop **in that same commit**. They only pay off together. The ADAA-in-OS machinery
(`adaaShape`, the `osX1`/`osF1` history at the oversampled rate) is already in place and unused,
waiting for it.

### The halfband landed — and the plan's "they only pay off together" was WRONG

`NativeOversampler` is now a 2-path polyphase IIR halfband (hiir elliptic coefficients, computed at
init from the transition bandwidth). Measured, isolating the filter from ADAA (hard/tanh @ drive 4,
1660 Hz):

| at 2× | hard | tanh | 15 kHz passband |
|---|---|---|---|
| old windowed-sinc + naive | −59.2 | −45.7 | ~0 dB |
| **new halfband + naive** | −58.6 | **−75.5** | **~0 dB** |
| new halfband + ADAA-in-loop | −58.4 | −65.1 | −1.09 dB |

Two findings, both against the plan:

1. **The halfband alone is the win — +30 dB on tanh** (and on any real program material, whose
   harmonics fall off far faster than a pure hard-clipped sine's). Flat passband, near-zero latency
   (vs the FIR's ~8-sample group delay), ~98 ns/sample at 2× (vs ~84 for the old FIR — a small price).
   At drive 1.0 the whole chain is transparent to −172 dBc, proving the halfband injects nothing.

2. **ADAA-in-loop is NOT worth it, and does not "pay off with" the halfband.** Over the good filter it
   adds at most +1.6 dB of alias while permanently dulling 15 kHz by 1.09 dB (ADAA low-passes the dry
   signal). So the OS loop stays **naive**; ADAA still runs at the base rate (`oversample == 0`), where
   its droop is the mode's whole character, not a cost.

3. **The hard clipper is oversampling-resistant, and that is physics, not a filter defect.** Its
   harmonics fall at 1/f, so they extend far past Nyquist at any OS factor and fold densely — no filter
   catches them (DAFx-16 / Vicanek: "2× oversampling only reduces aliasing by 6 dB" for a 1/f spectrum).
   The +30 dB on tanh is exactly the case where harmonics fall fast enough that the filter's sharpness
   matters. For the hard default, the real remaining lever is a smoother corner (BLAMP / softer curve),
   not more oversampling.
