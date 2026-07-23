// Fader position → gain (D-WZ-FADER-01): −∞..+6 dB audio taper, unity at 0.75.
//
// The curve is a Fritsch–Carlson monotone cubic through the signed reference
// points in dB-space, with a linear-in-dB tail below the first knot and a true
// zero at position 0. The web twin (web/src/engine/faderCurve.ts) implements
// the IDENTICAL algorithm in double precision; the P1-05 golden-table fixture
// pins both sides to the same 21 values at 1e-9, so the fader you see is the
// gain you get.
#pragma once

namespace wz {

// dB at `position` ∈ (0, 1]. position <= 0 is the caller's -inf case.
double faderPositionToDb(double position);

// Linear gain at `position` ∈ [0, 1]; exactly 0.0 at position <= 0.
double faderPositionToLinear(double position);

} // namespace wz
