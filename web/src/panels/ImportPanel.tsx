import { useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import { asBoolean, asNumber, asString, useSetting } from "../useSetting.ts";
import {
  Button,
  Caption,
  Checkbox,
  FieldRow,
  PanelTitle,
  ParamRow,
  Select,
} from "../design/controls.tsx";
import {
  BIT_DEPTHS,
  DITHER_TYPES,
  FILTER_TYPES,
  IMPORT_KEYS,
  NORMALIZATION_MODES,
  OUTPUT_FILTER_TYPES,
  PRESETS,
  PRESET_ORDER,
  QUANT_MODES,
  SAMPLE_RATES,
} from "./importSettings.ts";
import "./paintmode.css";

/**
 * Audio Import settings pane — web port per panels/settings.md §3.
 * Preset fan-out mirrors Swift's applyPreset; manual edits flip to custom.
 * "Apply to Loaded Samples" re-bakes every loaded sample (all decks) with
 * the current settings via the reprocessSamples command.
 */
export function ImportPanel({ link }: { link: EngineLink | null }) {
  const [enabled, setEnabled] = useSetting(link, IMPORT_KEYS.enabled, false, asBoolean);
  const [preset, setPreset] = useSetting(link, IMPORT_KEYS.preset, "high_quality", asString);
  const [sampleRate, setSampleRate] = useSetting(link, IMPORT_KEYS.sampleRate, "project", asString);
  const [bitDepth, setBitDepth] = useSetting(link, IMPORT_KEYS.bitDepth, "original", asString);
  const [quantMode, setQuantMode] = useSetting(link, IMPORT_KEYS.quantMode, "linear", asString);
  const [dither, setDither] = useSetting(link, IMPORT_KEYS.ditherType, "off", asString);
  const [filterType, setFilterType] = useSetting(link, IMPORT_KEYS.filterType, "steep", asString);
  const [cutoff, setCutoff] = useSetting(link, IMPORT_KEYS.filterCutoffRatio, 0.9, asNumber);
  const [character, setCharacter] = useSetting(link, IMPORT_KEYS.aliasCharacter, 0, asNumber);
  const [drive, setDrive] = useSetting(link, IMPORT_KEYS.driveDb, 0, asNumber);
  const [outFilter, setOutFilter] = useSetting(link, IMPORT_KEYS.outputFilterType, "off", asString);
  const [outCutoff, setOutCutoff] = useSetting(link, IMPORT_KEYS.outputCutoffRatio, 0.9, asNumber);
  const [outRes, setOutRes] = useSetting(link, IMPORT_KEYS.outputResonance, 0, asNumber);
  const [outTrim, setOutTrim] = useSetting(link, IMPORT_KEYS.outputTrimDb, 0, asNumber);
  const [preGain, setPreGain] = useSetting(link, IMPORT_KEYS.preGain, 0, asNumber);
  const [normalize, setNormalize] = useSetting(link, IMPORT_KEYS.normalizationMode, "peak", asString);

  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  const applyPreset = (id: string) => {
    setPreset(id);
    const fields = PRESETS[id]?.fields;
    if (!fields) return;
    setSampleRate(fields.sampleRate);
    setBitDepth(fields.bitDepth);
    setQuantMode(fields.quantMode);
    setDither(fields.ditherType);
    setFilterType(fields.filterType);
    setCutoff(fields.filterCutoffRatio);
    setCharacter(fields.aliasCharacter);
    setDrive(fields.driveDb);
    setOutFilter(fields.outputFilterType);
    setOutCutoff(fields.outputCutoffRatio);
    setOutRes(fields.outputResonance);
    setOutTrim(fields.outputTrimDb);
    setPreGain(fields.preGain);
    setNormalize(fields.normalizationMode);
  };

  const custom = <T,>(setter: (v: T) => void) => (v: T) => {
    if (preset !== "custom") setPreset("custom");
    setter(v);
  };

  const opts = (list: readonly { id: string; name: string }[]) =>
    list.map((o) => ({ value: o.id, label: o.name }));

  const reprocess = async () => {
    if (!link || applying) return;
    setApplying(true);
    setApplied(null);
    try {
      const result = (await link.command("reprocessSamples", {})) as { count: number };
      setApplied(result.count);
    } catch {
      setApplied(null);
    } finally {
      setApplying(false);
    }
  };

  return (
    <main className="panel paintmode">
      <PanelTitle>Audio Import</PanelTitle>

      <FieldRow label="Enabled">
        <Checkbox checked={enabled} onChange={setEnabled} />
      </FieldRow>

      {!enabled ? (
        <Caption>
          Import processing is off — samples load at full quality. Enable to
          apply hardware-sampler emulation (rate/bit reduction, real AA and
          reconstruction filters, aliasing character) to imported samples.
        </Caption>
      ) : (
        <>
          <FieldRow label="Preset">
            <Select
              value={preset}
              options={PRESET_ORDER.map((id) => ({ value: id, label: PRESETS[id]!.name }))}
              onChange={applyPreset}
            />
          </FieldRow>

          <FieldRow label="Sample Rate">
            <Select value={sampleRate} options={opts(SAMPLE_RATES)} onChange={custom(setSampleRate)} />
          </FieldRow>
          <FieldRow label="Bit Depth">
            <Select value={bitDepth} options={opts(BIT_DEPTHS)} onChange={custom(setBitDepth)} />
          </FieldRow>
          {bitDepth !== "original" && (
            <>
              <FieldRow label="Quantizer">
                <Select value={quantMode} options={opts(QUANT_MODES)} onChange={custom(setQuantMode)} />
              </FieldRow>
              <FieldRow label="Dither">
                <Select value={dither} options={opts(DITHER_TYPES)} onChange={custom(setDither)} />
              </FieldRow>
            </>
          )}
          <FieldRow label="Filter Type">
            <Select value={filterType} options={opts(FILTER_TYPES)} onChange={custom(setFilterType)} />
          </FieldRow>

          {filterType !== "off" && (
            <>
              <ParamRow
                label="Cutoff"
                value={cutoff}
                display={`${(cutoff * 100).toFixed(0)}% Nyq`}
                min={0.5}
                max={1}
                step={0.01}
                onChange={custom(setCutoff)}
              />
              <ParamRow
                label="Character"
                value={character}
                display={`${(character * 100).toFixed(0)}% alias`}
                min={0}
                max={1}
                step={0.01}
                onChange={custom(setCharacter)}
              />
            </>
          )}

          <FieldRow label="Output Filter">
            <Select value={outFilter} options={opts(OUTPUT_FILTER_TYPES)} onChange={custom(setOutFilter)} />
          </FieldRow>
          {outFilter !== "off" && (
            <ParamRow
              label="Out Cutoff"
              value={outCutoff}
              display={`${(outCutoff * 100).toFixed(0)}% Nyq`}
              min={0.3}
              max={1.2}
              step={0.01}
              onChange={custom(setOutCutoff)}
            />
          )}
          {outFilter === "ssm2044" && (
            <ParamRow
              label="Resonance"
              value={outRes}
              display={`${(outRes * 100).toFixed(0)}%`}
              min={0}
              max={1}
              step={0.01}
              onChange={custom(setOutRes)}
            />
          )}
          <ParamRow
            label="Out Trim"
            value={outTrim}
            display={`${outTrim >= 0 ? "+" : ""}${outTrim.toFixed(1)} dB`}
            min={-12}
            max={12}
            step={0.5}
            onChange={custom(setOutTrim)}
          />

          <ParamRow
            label="Drive"
            value={drive}
            display={`+${drive.toFixed(1)} dB`}
            min={0}
            max={24}
            step={0.5}
            onChange={custom(setDrive)}
          />
          <ParamRow
            label="Pre-Gain"
            value={preGain}
            display={`${preGain >= 0 ? "+" : ""}${preGain.toFixed(1)} dB`}
            min={-24}
            max={24}
            step={0.5}
            onChange={custom(setPreGain)}
          />

          <FieldRow label="Normalize">
            <Select value={normalize} options={opts(NORMALIZATION_MODES)} onChange={custom(setNormalize)} />
          </FieldRow>

          <FieldRow label="">
            <Button
              label={applying ? "Re-processing…" : "Apply to Loaded Samples"}
              onClick={reprocess}
              disabled={applying || !link}
            />
            <Button label="Reset to Defaults" onClick={() => applyPreset("high_quality")} />
          </FieldRow>
          {applied !== null && (
            <Caption>Re-baked {applied} sample{applied === 1 ? "" : "s"} with the current settings.</Caption>
          )}
        </>
      )}
    </main>
  );
}
