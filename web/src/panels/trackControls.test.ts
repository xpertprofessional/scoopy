import { describe, expect, it } from "vitest";
import {
  accentToolLabel,
  chopToolLabel,
  chordToolLabel,
  flamToolLabel,
  formatChoke,
  formatGain,
  formatGlidePercent,
  formatPan,
  formatPitch,
  formatSend,
  formatSwing,
  formatTone,
  formatVolume,
  freeRateFromPct,
  freeRateLabel,
  freeRatePct,
  glideToolLabel,
  nearestSpeedRatio,
  stepSpeedRatio,
  sliderFractionToVolume,
  SPEED_RATIOS,
  speedRatioName,
  stretchQualityLabel,
  unifiedRate,
  unifiedRateLabel,
  toneModeLabel,
  volumeToDisplay,
  volumeToSliderFraction,
} from "./trackControls.ts";

// Values cross-checked against the native DSP row + the reference screenshot.
describe("volume mapping (native volumeToDisplay / non-linear slider)", () => {
  it("default 1.0 → display 80", () => {
    expect(volumeToDisplay(1)).toBe(80);
    expect(formatVolume(1)).toBe("80");
  });
  it("screenshot 103 ↔ internal ≈1.575", () => {
    expect(formatVolume(1.575)).toBe("103");
  });
  it("slider fraction round-trips through the 2/3 breakpoint", () => {
    for (const v of [0, 0.5, 1, 1.575, 2]) {
      expect(sliderFractionToVolume(volumeToSliderFraction(v))).toBeCloseTo(v, 6);
    }
  });
  it("breakpoint: display 80 sits at 2/3 of the bar", () => {
    expect(volumeToSliderFraction(1)).toBeCloseTo(2 / 3, 6);
  });
});

describe("gain (%.2f multiplier)", () => {
  it("formats two decimals", () => {
    expect(formatGain(1.27)).toBe("1.27");
    expect(formatGain(1)).toBe("1.00");
  });
});

describe("pan (C / L## / R##)", () => {
  it("center within deadzone", () => {
    expect(formatPan(0)).toBe("C");
    expect(formatPan(0.005)).toBe("C");
  });
  it("right/left with percent", () => {
    expect(formatPan(0.42)).toBe("R42");
    expect(formatPan(-0.42)).toBe("L42");
  });
});

describe("pitch (quarter-tones + cents → semitones)", () => {
  it("29 quarter-tones = +14.5 semitones (odd → one decimal)", () => {
    expect(formatPitch(29, 0)).toBe("+14.5");
  });
  it("whole semitone prints no decimal", () => {
    expect(formatPitch(14, 0)).toBe("+7"); // 14 qt = 7 st
    expect(formatPitch(-8, 0)).toBe("-4");
  });
  it("cents force one decimal", () => {
    expect(formatPitch(14, 20)).toBe("+7.2"); // 7 + 0.2
  });
  it("zero prints +0", () => {
    expect(formatPitch(0, 0)).toBe("+0");
  });
});

describe("tone / filter", () => {
  it("tone mode is bipolar signed", () => {
    expect(formatTone(61, "tone")).toBe("61");
    expect(formatTone(-40, "tone")).toBe("-40");
  });
  it("filter modes show magnitude + short label", () => {
    expect(formatTone(-61, "lowPass")).toBe("61");
    expect(toneModeLabel("lowPass")).toBe("LP");
    expect(toneModeLabel("notch")).toBe("NO");
    expect(toneModeLabel("tone")).toBe("TONE");
  });
});

describe("sends + labels", () => {
  it("send 0…1 → 0…100", () => {
    expect(formatSend(0)).toBe("0");
    expect(formatSend(0.5)).toBe("50");
  });
  it("choke 0 = OFF", () => {
    expect(formatChoke(0)).toBe("OFF");
    expect(formatChoke(3)).toBe("3");
  });
});

describe("cell-tool selector labels (native counts)", () => {
  it("accent shows »N or Ac", () => {
    expect(accentToolLabel([0, 0, 0])).toBe("Ac");
    expect(accentToolLabel([1, 0, 2])).toBe("»2");
  });
  it("glide shows ↝N or Gl", () => {
    expect(glideToolLabel([false, false])).toBe("Gl");
    expect(glideToolLabel([true, false, true])).toBe("↝2");
  });
  it("flam counts cells with flam>1", () => {
    expect(flamToolLabel([1, 1, 1])).toBe("Fl");
    expect(flamToolLabel([1, 3, 2])).toBe("×2");
  });
  it("chop counts cells with an explicit slice (≥0)", () => {
    expect(chopToolLabel([-1, -1, -1])).toBe("Ch");
    expect(chopToolLabel([0, -1, 3])).toBe("#2");
  });
  it("chord counts cells carrying a voicing (index > 0; 0 = OFF)", () => {
    expect(chordToolLabel([0, 0, 0])).toBe("Chd");
    expect(chordToolLabel([1, 0, 5])).toBe("♪2");
  });
  it("glide percent / swing / stretch quality", () => {
    expect(formatGlidePercent(0)).toBe("%");
    expect(formatGlidePercent(50)).toBe("50%");
    expect(formatSwing(0.62)).toBe("62");
    expect(stretchQualityLabel(true)).toBe("T");
    expect(stretchQualityLabel(false)).toBe("T+P");
  });
});

describe("free-rate tape (native log mapping)", () => {
  it("centre = tape stop; 1× is forward of centre", () => {
    expect(freeRatePct(0)).toBeCloseTo(0.5, 6);
    expect(freeRatePct(1)).toBeGreaterThan(0.5);
    expect(freeRatePct(-1)).toBeLessThan(0.5);
  });
  it("pct ↔ rate round-trips within the ±16 slider domain", () => {
    // (minMag 0.05 sits exactly at centre = stop by design, so it's excluded.)
    for (const r of [0.5, 1, 4, 16, -0.5, -4, -16]) {
      expect(freeRateFromPct(freeRatePct(r))).toBeCloseTo(r, 4);
    }
  });
  it("dead centre snaps to 0", () => {
    expect(freeRateFromPct(0.5)).toBe(0);
  });
  it("label: arrow + magnitude, 2dp under 9.95 else 0dp", () => {
    expect(freeRateLabel(1)).toBe("▶×1.00");
    expect(freeRateLabel(-1.5)).toBe("◀×1.50");
    expect(freeRateLabel(12)).toBe("▶×12");
  });
});

describe("unified rate (TR-FT-9: multiply detents ⊕ free rate)", () => {
  it("ratio names mirror SpeedRatioTiming.ratioLabel (0.05 tolerance)", () => {
    expect(speedRatioName(0.25)).toBe("1:4");
    expect(speedRatioName(1 / 3)).toBe("1:3");
    expect(speedRatioName(2 / 3)).toBe("2:3");
    expect(speedRatioName(1)).toBe("1:1");
    expect(speedRatioName(1.5)).toBe("3:2");
    expect(speedRatioName(4)).toBe("4:1");
    // TR-FT-10 additions: polyrhythmic + high multiples.
    expect(speedRatioName(0.75)).toBe("3:4");
    expect(speedRatioName(1.25)).toBe("5:4");
    expect(speedRatioName(1.75)).toBe("7:4");
    expect(speedRatioName(2.5)).toBe("5:2");
    expect(speedRatioName(6)).toBe("6:1");
    expect(speedRatioName(16)).toBe("16:1");
    expect(speedRatioName(7)).toBe("6:1"); // off-table → nearest detent's name
  });
  it("every signed detent snaps to itself; midpoints resolve by log distance", () => {
    for (const r of SPEED_RATIOS) {
      expect(nearestSpeedRatio(r)).toBe(r);
      expect(nearestSpeedRatio(-r)).toBe(-r); // mirrored = pattern backwards
    }
    expect(nearestSpeedRatio(1.9)).toBe(2);
    expect(nearestSpeedRatio(0.3)).toBeCloseTo(1 / 3, 9);
    expect(nearestSpeedRatio(-1.9)).toBe(-2);
  });
  it("unified value = signed engine product; label follows the domain", () => {
    expect(unifiedRate(2, 1)).toBe(2);
    expect(unifiedRate(1, 2.5)).toBe(2.5);
    expect(unifiedRate(2, 1, true)).toBe(-2); // backward detent → negative
    expect(unifiedRateLabel(2, 1)).toBe("2:1"); // detent domain → ratio
    expect(unifiedRateLabel(2, 1, true)).toBe("◀2:1"); // reversed detent
    expect(unifiedRateLabel(1, 2.5)).toBe("▶×2.50"); // free domain → tape
    expect(unifiedRateLabel(1, -1)).toBe("◀×1.00"); // free reverse
  });
  // ö/ä on the rate box (native control 37 = stepSpeedMultiplier, an INDEX
  // step). The bug this pins: a ±0.05 VALUE step lands inside the current
  // detent's snap zone from 2× up, so every keypress round-tripped to the
  // ratio it started on and the write early-outed — the control was dead.
  it("ö/ä walks the detent table by index, never by value", () => {
    expect(stepSpeedRatio(2, 1)).toBe(2.5); // 2:1 → 5:2, NOT 2.05 → back to 2
    expect(stepSpeedRatio(2, -1)).toBe(1.75);
    expect(stepSpeedRatio(16, 1)).toBe(16); // top pins, no wrap
    expect(stepSpeedRatio(-16, -1)).toBe(-16); // reverse end pins too
    expect(stepSpeedRatio(8, 1)).toBe(12);
    // A rate BETWEEN detents steps off its nearest one (free → detent re-entry).
    expect(stepSpeedRatio(1.9, 1)).toBe(2.5);
    // Crossing the tape centre flips to the mirrored (backwards) side.
    expect(stepSpeedRatio(0.25, -1)).toBe(-0.25);
    expect(stepSpeedRatio(-0.25, 1)).toBe(0.25);
    // Reverse side is ordered by the TAPE, so "+" always moves right on screen.
    expect(stepSpeedRatio(-2, 1)).toBe(-1.75);
  });
});
