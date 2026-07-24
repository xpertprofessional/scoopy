#pragma once

#include <cmath>

// Per-track musical tuning / temperament remap.
//
// MIRROR of Swift `Tuning` / `MusicalTuning` in SequencerState.swift. The cent tables and
// the remap math MUST stay identical to the Swift side. tuningIndex matches
// MusicalTuning.rawValue (0 = 12-TET, 1 = Just Intonation).
namespace scoopy {

// Map a (possibly fractional) semitone value `s` into the given tuning.
// The nearest integer semitone is retuned by the table; the leftover fractional part
// (s - round(s), ±0.5 st) is preserved as an additive offset. 12-TET is an exact identity.
inline double tunedSemitones(double s, int tuningIndex) noexcept {
    if (tuningIndex == 0) return s; // 12-TET identity fast-path

    // Cents for each of the 12 scale degrees, relative to the root (degree 0 = 0 cents).
    // 5-limit Just Intonation: 1/1 16/15 9/8 6/5 5/4 4/3 45/32 3/2 8/5 5/3 9/5 15/8
    static const double kJustCents[12] = {
        0.0, 111.7313, 203.9100, 315.6413, 386.3137, 498.0450,
        590.2237, 701.9550, 813.6863, 884.3587, 1017.5963, 1088.2687
    };
    const double* table = kJustCents; // index 1 = Just (only non-identity for now)

    const double n = std::round(s);
    const double residue = s - n;
    const long ni = static_cast<long>(n);
    const int degree = static_cast<int>(((ni % 12) + 12) % 12);
    const long octave = (ni - degree) / 12;
    const double tunedCents = static_cast<double>(octave) * 1200.0 + table[degree] + residue * 100.0;
    return tunedCents / 100.0;
}

} // namespace scoopy
