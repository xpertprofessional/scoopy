#!/usr/bin/env python3
"""
P8-3b — the NULL TEST. Subtract two renders of the SAME scene and report the residual.

The companion's promise is "the composition works identical". The DSP is literally the same C++ on
both platforms, so this is not a re-implementation being compared to an original — it is one
program compiled twice. But bit-identity will NOT hold (libm ULPs, float contraction, denormals),
so the honest question is not "are the bits equal" but "is the difference inaudible".

    python3 null_test.py native.f32 wasm.f32 [--threshold-db -80]

Both files are interleaved float32 stereo, written by `scoopy_render_null`.

The threshold is a peak-residual figure, not an RMS one: an RMS number can hide a single loud
click inside six seconds of quiet tail, and a click is exactly the artefact a denormal or an FMA
divergence would produce.
"""
import argparse
import math
import struct
import sys


def read_f32(path):
    with open(path, "rb") as f:
        raw = f.read()
    n = len(raw) // 4
    return struct.unpack(f"<{n}f", raw[: n * 4])


def db(x):
    return -math.inf if x <= 0 else 20.0 * math.log10(x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--threshold-db", type=float, default=-80.0)
    args = ap.parse_args()

    a, b = read_f32(args.a), read_f32(args.b)

    if len(a) != len(b):
        print(f"FAIL: length differs ({len(a)} vs {len(b)}) — not the same render")
        return 1

    # A render that is SILENT nulls perfectly against anything. That is the one way this test could
    # lie, so refuse it outright rather than report a triumphant -inf dB.
    peak_a = max(abs(x) for x in a)
    if peak_a < 1e-4:
        print(f"REFUSING: reference is silent (peak {peak_a:g}) — nulling against silence proves nothing")
        return 2

    peak_res = 0.0
    sum_sq = 0.0
    worst = 0
    for i, (x, y) in enumerate(zip(a, b)):
        d = abs(x - y)
        if d > peak_res:
            peak_res, worst = d, i
        sum_sq += d * d
    rms_res = math.sqrt(sum_sq / len(a)) if a else 0.0

    print(f"reference peak : {peak_a:.6f}  ({db(peak_a):+.1f} dBFS)")
    print(f"residual  peak : {peak_res:.9f}  ({db(peak_res):+.1f} dBFS)  at sample {worst // 2}")
    print(f"residual  rms  : {rms_res:.9f}  ({db(rms_res):+.1f} dBFS)")

    if peak_res == 0.0:
        print("\nBIT-IDENTICAL. The two platforms produced the same samples exactly.")
        return 0

    ok = db(peak_res) <= args.threshold_db
    print(f"\n{'PASS' if ok else 'FAIL'}: peak residual {db(peak_res):+.1f} dBFS "
          f"vs threshold {args.threshold_db:+.1f} dBFS")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
