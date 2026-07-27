import { useEffect, useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import { asNumber, asString, useSetting } from "../useSetting.ts";
import {
  Button,
  Caption,
  FieldRow,
  PanelTitle,
  ParamRow,
  Select,
} from "../design/controls.tsx";
import {
  ARPEGGIO_PATTERNS,
  BANK_COUNT,
  INTERVALS_PER_BANK,
  normalizeBanks,
} from "./arpeggioPatterns.ts";
import "./paintmode.css";

/**
 * Paint Mode settings pane — web port per panels/settings.md §7.
 * Pure settings surface; the paint engine stays Swift-side.
 */
export function PaintModePanel({ link }: { link: EngineLink | null }) {
  const [pitchDelta, setPitchDelta] = useSetting(
    link, "paintModePitchDeltaSemitones", 1.0, asNumber);
  const [gainDelta, setGainDelta] = useSetting(
    link, "paintModeGainDeltaPercent", 10.0, asNumber);
  const [patternId, setPatternId] = useSetting(
    link, "paintModeArpeggioPattern", "custom", asString);
  const [activeBank, setActiveBank] = useSetting(
    link, "pitchPresetActiveBank", 0, asNumber);

  const [banks, setBanks] = useState<number[][]>(normalizeBanks(null));

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    link
      .command("getSetting", { key: "pitchPresetBanks" })
      .then((raw) => {
        if (cancelled) return;
        setBanks(normalizeBanks((raw as { value?: unknown })?.value));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [link]);

  const writeBanks = (next: number[][]) => {
    setBanks(next);
    link?.command("setSetting", { key: "pitchPresetBanks", value: next }).catch(() => {});
  };

  const setInterval_ = (index: number, value: number) => {
    writeBanks(
      banks.map((bank, b) =>
        b === activeBank ? bank.map((v, i) => (i === index ? value : v)) : bank,
      ),
    );
  };

  const fillFromTemplate = (intervals: number[]) => {
    writeBanks(
      banks.map((bank, b) =>
        b === activeBank
          ? Array.from({ length: INTERVALS_PER_BANK }, (_, i) => intervals[i] ?? 0)
          : bank,
      ),
    );
  };

  const pattern =
    ARPEGGIO_PATTERNS.find((p) => p.id === patternId) ?? ARPEGGIO_PATTERNS[0]!;
  const currentBank = banks[activeBank] ?? banks[0]!;

  return (
    <main className="panel paintmode">
      <PanelTitle>Paint Mode</PanelTitle>

      <ParamRow
        label="Pitch"
        value={pitchDelta}
        display={`${pitchDelta.toFixed(1)} st`}
        min={0.5}
        max={12}
        step={0.5}
        onChange={setPitchDelta}
      />
      <ParamRow
        label="Gain"
        value={gainDelta}
        display={`${gainDelta.toFixed(0)} %`}
        min={1}
        max={50}
        step={1}
        onChange={setGainDelta}
      />

      <FieldRow label="Mode">
        <Select
          value={patternId}
          options={ARPEGGIO_PATTERNS.map((p) => ({ value: p.id, label: p.displayName }))}
          onChange={setPatternId}
        />
      </FieldRow>
      <Caption>{pattern.description}</Caption>

      {patternId === "custom" && (
        <section className="bank-editor">
          <div className="bank-picker">
            {Array.from({ length: BANK_COUNT }, (_, b) => (
              <Button
                key={b}
                label={`${b + 1}`}
                active={activeBank === b}
                onClick={() => setActiveBank(b)}
              />
            ))}
            <select
              className="ds-select template-fill"
              value=""
              onChange={(e) => {
                const t = ARPEGGIO_PATTERNS.find((p) => p.id === e.target.value);
                if (t && t.intervals.length) fillFromTemplate(t.intervals);
              }}
            >
              <option value="" disabled>Fill from template…</option>
              {ARPEGGIO_PATTERNS.filter((p) => p.intervals.length > 0).map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </div>
          <div className="interval-grid">
            {currentBank.map((v, i) => (
              <input
                key={i}
                type="number"
                step={0.5}
                value={v}
                onChange={(e) => setInterval_(i, Number(e.target.value) || 0)}
              />
            ))}
          </div>
          <Caption>
            Semitone intervals from the anchor note, applied in order while
            painting. 0 = repeat anchor pitch.
          </Caption>
        </section>
      )}
    </main>
  );
}
