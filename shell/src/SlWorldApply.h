// The native half of the Option-B play path: a flat World -> v3 snapshot.
//
// ARCHITECTURE (docs/merge/P1-STATUS.md, Option B). Scoopy's document -> engine
// is a 505-line load-bearing translation (worldFromSession.ts: scene
// projection, kit join, ~90 fields, enum orderings). That stays in TS — its one
// tested home. The merged host's web layer runs it, then publishes the flat
// `World` to native ALREADY KEYED BY ENGINE NAME (SL_T_* / SL_TA_*), using the
// same field->name table its worklet already carries (scoopy-worklet.js).
//
// So this applier is deliberately GENERIC and TINY: it never knows what
// `SL_T_VOLUME` means or which fields exist. It resolves each name through the
// v3 ABI (which ignores unknowns, sl_engine.h) and sets it. There is NO
// field mapping in C++ to hand-mirror or let drift — the exact opposite of
// porting worldFromSession a third time. A new engine param becomes carryable
// the moment the web side sends its name; this file does not change.
//
// GUI-free (juce::var only), so the whole translation is headless-testable
// (sl_world_apply_test) with no WebView and no device.
#pragma once

#include <juce_core/juce_core.h>

struct sl_engine;

namespace wizard::sl {

/** Register one decoded sample under its id. Thin over sl_engine_register_sample
    — here so callers work in juce::var terms. `left` required; `right` optional
    (mono duplicates). Returns false on a bad payload or a rejected register. */
bool registerSample(sl_engine* engine, const juce::var& sample);

/** Apply a flat World to the engine as one published snapshot.

    Expected shape (engine-name-keyed — the web side renamed via its table):
      {
        deck?: 0,                       // only 0 today; >0 is refused by the ABI
        bpm: number, isPlaying: bool, startStep: int,
        tracks: [
          { sampleId: string, steps: [0/1,...],
            params?: { "SL_T_VOLUME": number, "SL_T_TONE_MODE": number, ... },
            arrays?: { "SL_TA_PITCH_OFFSETS": [number,...], ... } }
        ]
      }

    Returns { applied: bool, error: string|null } — the worldPublish result
    shape. A track naming a param the engine does not know is not an error: the
    ABI ignores it by design (forward compatibility), same as the worklet. A
    track with no sampleId or no steps IS refused — it would render silence that
    looks like a broken engine. */
juce::var applyWorld(sl_engine* engine, const juce::var& world);

} // namespace wizard::sl
