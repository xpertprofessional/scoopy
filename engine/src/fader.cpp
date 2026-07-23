#include "fader.h"

#include <cmath>

namespace wz {

namespace {

// D-WZ-FADER-01 reference knots (position → dB). Below kPos[0] the curve is
// linear in dB down to −120 at position 0+ (inaudible), and exactly −∞ (gain 0)
// at position 0. Keep these EXACTLY in sync with web/src/engine/faderCurve.ts.
constexpr int kN = 5;
constexpr double kPos[kN] = {0.05, 0.25, 0.50, 0.75, 1.00};
constexpr double kDb[kN] = {-60.0, -24.0, -8.0, 0.0, 6.0};
constexpr double kFloorDb = -120.0; // dB approached as position → 0+

struct Tangents {
    double m[kN];
};

// Fritsch–Carlson monotone tangents — guarantees the interpolant never
// overshoots between knots, so the fader can never be non-monotone.
Tangents computeTangents() {
    Tangents t{};
    double d[kN - 1];
    for (int i = 0; i < kN - 1; ++i) d[i] = (kDb[i + 1] - kDb[i]) / (kPos[i + 1] - kPos[i]);
    t.m[0] = d[0];
    t.m[kN - 1] = d[kN - 2];
    for (int i = 1; i < kN - 1; ++i) {
        if (d[i - 1] * d[i] <= 0.0) {
            t.m[i] = 0.0;
        } else {
            // Weighted harmonic mean (Fritsch–Butland form) — monotone-safe.
            const double w1 = 2.0 * (kPos[i + 1] - kPos[i]) + (kPos[i] - kPos[i - 1]);
            const double w2 = (kPos[i + 1] - kPos[i]) + 2.0 * (kPos[i] - kPos[i - 1]);
            t.m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
        }
    }
    return t;
}

const Tangents kT = computeTangents();

} // namespace

double faderPositionToDb(double position) {
    if (position >= 1.0) return kDb[kN - 1];
    if (position <= kPos[0]) {
        // Linear in dB from kFloorDb (at 0) up to kDb[0] (at kPos[0]).
        const double f = position / kPos[0];
        return kFloorDb + f * (kDb[0] - kFloorDb);
    }
    int i = 0;
    while (i < kN - 2 && position >= kPos[i + 1]) ++i;
    const double h = kPos[i + 1] - kPos[i];
    const double s = (position - kPos[i]) / h;
    const double s2 = s * s;
    const double s3 = s2 * s;
    // Cubic Hermite basis.
    const double h00 = 2.0 * s3 - 3.0 * s2 + 1.0;
    const double h10 = s3 - 2.0 * s2 + s;
    const double h01 = -2.0 * s3 + 3.0 * s2;
    const double h11 = s3 - s2;
    return h00 * kDb[i] + h10 * h * kT.m[i] + h01 * kDb[i + 1] + h11 * h * kT.m[i + 1];
}

double faderPositionToLinear(double position) {
    if (position <= 0.0) return 0.0; // true mute — no denormal tail
    return std::pow(10.0, faderPositionToDb(position) / 20.0);
}

} // namespace wz
