#pragma once

// ============================================================================
//  VARISPEED (TP) RESAMPLER TOGGLE  —  edit the single line below.
//
//      1 = Anti-aliased 16-tap windowed-sinc  (NativeSincResampler)
//      0 = 4-point cubic Hermite              ← default (current behavior)
//
//  Scope: this ONLY affects the per-voice varispeed / TP read path (the
//  non-stretched voices in NativeAudioEngineCore::renderSequencerFrames that
//  call interpolate()). It has NOTHING to do with the time-stretch backend
//  (RubberBand / Signalsmith) — TP is pure resampling and never touches a
//  stretcher. See SCOOPY_STRETCH_BACKEND_SIGNALSMITH in NativeStretchBackend.hpp
//  for the unrelated TS path.
//
//  Just change the value and rebuild. Nothing else to touch. Flag OFF is
//  byte-for-byte identical to the previous cubic behavior; flag ON swaps in the
//  band-limited sinc read so pitch-up no longer aliases and pitch-down keeps HF.
// ============================================================================
#ifndef SCOOPY_SINC_RESAMPLER
#define SCOOPY_SINC_RESAMPLER 0   // 0 = cubic Hermite (default), 1 = windowed-sinc
#endif

// (The #ifndef guard means a build-setting / -D override still wins if present,
// but you don't need one — editing the line above is enough.)
