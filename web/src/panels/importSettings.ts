/**
 * Audio import settings data, ported 1:1 from AudioImportSettings.swift
 * (enums + applyPreset fan-out). Raw values ARE the UserDefaults strings.
 *
 * Vintage bake v2: full hardware-sampler signal chain — real biquad AA
 * filters, S/H decimation with a controllable aliasing Character, linear or
 * µ-law quantizer, ZOH imaging + modeled analog output filter (SSM2044 etc.).
 */

export const SAMPLE_RATES = [
  { id: "project", name: "Project Rate (Best Quality)" },
  { id: "48000", name: "48.0 kHz" },
  { id: "44100", name: "44.1 kHz" },
  { id: "40000", name: "40.0 kHz (MPC60)" },
  { id: "33075", name: "33.075 kHz (Fairlight CMI)" },
  { id: "31250", name: "31.25 kHz" },
  { id: "30200", name: "30.2 kHz (Fairlight IIx)" },
  { id: "29400", name: "29.4 kHz (Mirage)" },
  { id: "26040", name: "26.04 kHz (SP-1200)" },
  { id: "22050", name: "22.05 kHz (S950)" },
  { id: "16000", name: "16.0 kHz" },
  { id: "12000", name: "12.0 kHz" },
] as const;

export const BIT_DEPTHS = [
  { id: "original", name: "Original (32-bit float)" },
  { id: "16", name: "16-bit" },
  { id: "12", name: "12-bit (SP-1200)" },
  { id: "8", name: "8-bit" },
] as const;

export const QUANT_MODES = [
  { id: "linear", name: "Linear (SP-1200)" },
  { id: "mulaw", name: "µ-law (MPC60)" },
] as const;

export const DITHER_TYPES = [
  { id: "off", name: "Off (Harsh)" },
  { id: "flat", name: "Flat (Simple)" },
  { id: "shaped", name: "Shaped (Smooth)" },
] as const;

// Legacy raw values "gentle"/"steep" kept for UserDefaults compatibility;
// they now mean Butterworth-4 and Chebyshev-I-8 (ImportFilterType in Swift).
export const FILTER_TYPES = [
  { id: "off", name: "Off (Full Aliasing)" },
  { id: "butter2", name: "Soft (12 dB/oct)" },
  { id: "gentle", name: "Gentle (24 dB/oct)" },
  { id: "butter6", name: "Firm (36 dB/oct)" },
  { id: "steep", name: "Steep (S950 Tracking)" },
] as const;

export const OUTPUT_FILTER_TYPES = [
  { id: "off", name: "Off (Images Pass)" },
  { id: "gentle", name: "Gentle (12 dB/oct)" },
  { id: "ssm2044", name: "SSM2044 (SP-1200)" },
  { id: "steep", name: "Steep (S950)" },
] as const;

export const NORMALIZATION_MODES = [
  { id: "peak", name: "Peak Normalize" },
  { id: "off", name: "Off" },
] as const;

export interface ImportFields {
  sampleRate: string;
  bitDepth: string;
  quantMode: string;
  ditherType: string;
  filterType: string;
  filterCutoffRatio: number;
  aliasCharacter: number;
  driveDb: number;
  outputFilterType: string;
  outputCutoffRatio: number;
  outputResonance: number;
  outputTrimDb: number;
  normalizationMode: string;
  preGain: number;
}

/** Preset fan-out, mirrors AudioImportSettings.applyPreset. */
export const PRESETS: Record<string, { name: string; fields: ImportFields | null }> = {
  high_quality: {
    name: "High Quality",
    fields: {
      sampleRate: "project", bitDepth: "original", quantMode: "linear",
      ditherType: "off", filterType: "steep", filterCutoffRatio: 0.95,
      aliasCharacter: 0, driveDb: 0,
      outputFilterType: "off", outputCutoffRatio: 0.9, outputResonance: 0,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  sp1200: {
    name: "SP-1200",
    fields: {
      sampleRate: "26040", bitDepth: "12", quantMode: "linear",
      ditherType: "off", filterType: "gentle", filterCutoffRatio: 0.85,
      aliasCharacter: 0.35, driveDb: 2,
      outputFilterType: "ssm2044", outputCutoffRatio: 0.85, outputResonance: 0.15,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  s950: {
    name: "S950",
    fields: {
      sampleRate: "22050", bitDepth: "12", quantMode: "linear",
      ditherType: "off", filterType: "steep", filterCutoffRatio: 0.84,
      aliasCharacter: 0.1, driveDb: 0,
      outputFilterType: "steep", outputCutoffRatio: 0.9, outputResonance: 0,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  mpc60: {
    name: "MPC60",
    fields: {
      sampleRate: "40000", bitDepth: "12", quantMode: "mulaw",
      ditherType: "off", filterType: "butter6", filterCutoffRatio: 0.9,
      aliasCharacter: 0.1, driveDb: 1,
      outputFilterType: "gentle", outputCutoffRatio: 0.95, outputResonance: 0,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  fairlight: {
    name: "Fairlight IIx",
    fields: {
      sampleRate: "30200", bitDepth: "8", quantMode: "linear",
      ditherType: "off", filterType: "butter2", filterCutoffRatio: 0.8,
      aliasCharacter: 0.6, driveDb: 3,
      outputFilterType: "off", outputCutoffRatio: 0.9, outputResonance: 0,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  mirage: {
    name: "Mirage",
    fields: {
      sampleRate: "29400", bitDepth: "8", quantMode: "mulaw",
      ditherType: "off", filterType: "gentle", filterCutoffRatio: 0.85,
      aliasCharacter: 0.4, driveDb: 2,
      outputFilterType: "gentle", outputCutoffRatio: 0.9, outputResonance: 0,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  lofi: {
    name: "Lo-Fi",
    fields: {
      sampleRate: "22050", bitDepth: "12", quantMode: "linear",
      ditherType: "off", filterType: "gentle", filterCutoffRatio: 0.8,
      aliasCharacter: 0.7, driveDb: 3,
      outputFilterType: "off", outputCutoffRatio: 0.9, outputResonance: 0,
      outputTrimDb: 0, normalizationMode: "peak", preGain: 0,
    },
  },
  custom: { name: "Custom", fields: null },
};

export const PRESET_ORDER = [
  "high_quality", "sp1200", "s950", "mpc60", "fairlight", "mirage", "lofi", "custom",
];

/** UserDefaults keys (AudioImportSettings.swift Keys enum). */
export const IMPORT_KEYS = {
  enabled: "audioImportSettingsEnabled",
  preset: "audioImportPreset",
  sampleRate: "audioImportSampleRate",
  bitDepth: "audioImportBitDepth",
  quantMode: "audioImportQuantMode",
  ditherType: "audioImportDitherType",
  filterType: "audioImportFilterType",
  filterCutoffRatio: "audioImportFilterCutoffRatio",
  aliasCharacter: "audioImportAliasCharacter",
  driveDb: "audioImportDriveDb",
  outputFilterType: "audioImportOutputFilterType",
  outputCutoffRatio: "audioImportOutputCutoffRatio",
  outputResonance: "audioImportOutputResonance",
  outputTrimDb: "audioImportOutputTrimDb",
  preGain: "audioImportPreGain",
  normalizationMode: "audioImportNormalizationMode",
} as const;
