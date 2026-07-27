import { useEffect, useState } from "react";
import {
  SpectralUiState,
  type SpectralDeckState,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, Caption, PanelTitle, PairedParamRow } from "../design/controls.tsx";
import "./spectral.css";

/**
 * Time Stretch (spectral) panel — web port per panels/spectral.md.
 * View+command mode; layout B rows. Global debug section dropped per
 * user CONFIRM (spec §3).
 */

const DECK_NAMES = ["A", "B", "C"] as const;
const TEXTURE_NODES_MS = [25, 60, 120, 240, 480, 960];
const PRESETS = [
  { label: "Tight", value: 0.0 },
  { label: "Default", value: 2 / 5 },
  { label: "Wide", value: 4 / 5 },
  { label: "Paul", value: 1.0 },
];

const DEFAULT_DECK: SpectralDeckState = { texture: 2 / 5, chaos: 1, airDb: 0 };

/** Geometric interpolation across the window-bank nodes (spec §6.2). */
export function windowMs(texture: number): number {
  const t = Math.min(Math.max(texture, 0), 1) * (TEXTURE_NODES_MS.length - 1);
  const i = Math.min(Math.floor(t), TEXTURE_NODES_MS.length - 2);
  const frac = t - i;
  const lo = TEXTURE_NODES_MS[i]!;
  const hi = TEXTURE_NODES_MS[i + 1]!;
  return lo * Math.pow(hi / lo, frac);
}

export function chaosLabel(v: number): string {
  if (v < -0.999) return "roll";
  if (Math.abs(v) < 0.001) return "metallic";
  if (v > 0.999) return "airy";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

function airLabel(v: number): string {
  return v < 0.05 ? "off" : `+${v.toFixed(1)} dB`;
}

export function SpectralPanel({ link }: { link: EngineLink | null }) {
  const [deck, setDeck] = useState(0);
  const [decks, setDecks] = useState<SpectralDeckState[]>([
    DEFAULT_DECK,
    DEFAULT_DECK,
    DEFAULT_DECK,
  ]);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("spectral", (raw) => {
      const parsed = SpectralUiState.safeParse(raw);
      if (parsed.success) setDecks([...parsed.data.decks]);
    });
    link.command("getUiState", { topic: "spectral" }).catch(() => {});
    return off;
  }, [link]);

  const current = decks[deck] ?? DEFAULT_DECK;

  // Optimistic local echo + ParamWrite; Swift's UiState push confirms.
  const write = (
    field: keyof SpectralDeckState,
    param: "deckBusTexture" | "deckBusChaos" | "deckBusAir",
    value: number,
  ) => {
    setDecks((prev) =>
      prev.map((d, i) => (i === deck ? { ...d, [field]: value } : d)),
    );
    link?.paramWrite(param, value, deck);
  };

  return (
    <main className="panel spectral">
      <header className="panel-head">
        <PanelTitle>Time Stretch</PanelTitle>
        <div className="deck-picker" role="tablist">
          {DECK_NAMES.map((name, i) => (
            <button
              key={name}
              role="tab"
              aria-selected={deck === i}
              className={deck === i ? "active" : ""}
              onClick={() => setDeck(i)}
            >
              {name}
            </button>
          ))}
        </div>
      </header>
      <Caption>
        Tunes the deck time-stretch path (tempo-sync, freeze/scrub). Creative
        spectral warping lives in the Scoopy Spectral FX plugin.
      </Caption>

      <PairedParamRow
        id="spectral/texture"
        label="Window"
        value={current.texture}
        display={`≈${windowMs(current.texture).toFixed(0)} ms`}
        min={0}
        max={1}
        step={0.001}
        defaultValue={2 / 5}
        onChange={(v) => write("texture", "deckBusTexture", v)}
      />
      <div className="preset-row">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            label={p.label}
            onClick={() => write("texture", "deckBusTexture", p.value)}
          />
        ))}
      </div>

      <PairedParamRow
        id="spectral/chaos"
        label="Chaos"
        value={current.chaos}
        display={chaosLabel(current.chaos)}
        min={-1}
        max={1}
        step={0.01}
        defaultValue={1}
        onChange={(v) => write("chaos", "deckBusChaos", v)}
      />
      <PairedParamRow
        id="spectral/air"
        label="Air"
        value={current.airDb}
        display={airLabel(current.airDb)}
        min={0}
        max={12}
        step={0.1}
        defaultValue={0}
        onChange={(v) => write("airDb", "deckBusAir", v)}
      />
      <Caption>
        Chaos only speaks beyond ~2× stretch. Air recovers stretched-away
        highs.
      </Caption>
    </main>
  );
}
