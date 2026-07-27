import { useEffect, useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import { COMMANDS, GridPatternState } from "../../protocol/schema.ts";
import { Button, SectionTitle } from "../design/controls.tsx";
import "./deckmixer.css";

/**
 * The track's INSTRUMENT window — the plugin scanner/picker for one track.
 *
 * Deliberately the SAME surface as `FxSlotPanel`: same window shell, same RESCAN row, same
 * picker list, same classes. A plugin picker cannot live in an in-page popover (MIX-R8: a
 * popover cannot escape its host WKWebView), and there is no reason for the app to have two
 * different-looking answers to "choose a plugin".
 *
 * The target track arrives as `window.__slPanelArg` (injected at document start by
 * `WebPanelHostView`), exactly like the FX slot's return index.
 */
type InstrumentList = ReturnType<typeof COMMANDS.listInstruments.result.parse>;

export function InstrumentPanel({ link }: { link: EngineLink | null }) {
  const trackIndex = Number(
    (window as { __slPanelArg?: string }).__slPanelArg ?? "0",
  );

  const [track, setTrack] = useState<GridPatternState | null>(null);
  const [plugins, setPlugins] = useState<InstrumentList | null>(null);

  const fetchPlugins = () => {
    link
      ?.command("listInstruments", {})
      .then((raw) => setPlugins(COMMANDS.listInstruments.result.parse(raw)))
      .catch(() => {});
  };

  // A scan runs out-of-process per plugin and can take well past any single refetch
  // delay (minutes on a first sweep) — poll while the engine reports scanning so the
  // list fills itself in when the scan lands, instead of showing "scanning…" forever.
  useEffect(() => {
    if (!link || !plugins?.scanning) return;
    const t = setInterval(fetchPlugins, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, plugins?.scanning]);

  useEffect(() => {
    if (!link) return;
    fetchPlugins();
    // The row's own state topic — so the window always shows the CURRENT binding and
    // output state, and an edit made here lights up in the row (and vice versa).
    // P5-06 step B: this used to subscribe to `grid/<i>`, which no longer exists — and it
    // CAST the payload instead of parsing it, so the type-checker could not see the topic go
    // away and the panel would simply have gone silently dead. Parse, don't cast.
    //
    // Everything this window reads (instrumentOutEnabled · hasInstrument · instrumentName) is
    // DOCUMENT state, so it wants the pattern half only.
    return link.onUiState(`gridPattern/${trackIndex}`, (raw) => {
      const parsed = GridPatternState.safeParse(raw);
      if (!parsed.success) {
        console.error(`gridPattern/${trackIndex} rejected:`, parsed.error.issues, raw);
        return;
      }
      setTrack(parsed.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, trackIndex]);

  const edit = (params: Record<string, unknown>) =>
    link?.command("trackEdit", { ...params, trackIndex }).catch(() => {});

  if (!track) {
    return <main className="fxslot-panel mono dim">waiting for track state…</main>;
  }

  return (
    <main className="fxslot-panel">
      <SectionTitle>Output</SectionTitle>
      <div className="fx-row">
        <Button
          label={track.instrumentOutEnabled ? "INST ON" : "INST OFF"}
          active={track.instrumentOutEnabled}
          disabled={!track.hasInstrument}
          onClick={() =>
            edit({ op: "setInstrumentOut", value: track.instrumentOutEnabled ? 0 : 1 })
          }
        />
        <Button
          label="EDIT"
          disabled={!track.hasInstrument || !track.instrumentOutEnabled}
          onClick={() => edit({ op: "openInstrumentEditor" })}
        />
        {/* Honest about the one thing that is easy to get wrong: switching the output off
            does NOT throw the plugin away, and neither does switching the track's sample
            back on. Nothing here can lose your patch. */}
        {track.hasInstrument && !track.instrumentOutEnabled && (
          <span className="dim ds-value">bound, not sounding — its state is kept</span>
        )}
      </div>

      <SectionTitle>Plugin</SectionTitle>
      <div className="fx-row">
        <Button
          label="RESCAN"
          onClick={() => {
            link?.command("rescanPlugins", {}).catch(() => {});
            setTimeout(fetchPlugins, 1500);
          }}
        />
        {plugins?.scanning && <span className="dim ds-value">scanning…</span>}
      </div>

      <div className="fx-picker-list">
        <button
          className={`ds-button fx-picker-item${!track.hasInstrument ? " active" : ""}`}
          onClick={() => edit({ op: "clearInstrument" })}
        >
          — none —
        </button>
        {(plugins?.plugins ?? []).map((p) => (
          <button
            key={p.identifier}
            className={`ds-button fx-picker-item${p.name === track.instrumentName ? " active" : ""}`}
            title={`${p.manufacturer} · ${p.format}`}
            onClick={() => edit({ op: "loadInstrument", mode: p.identifier })}
          >
            {p.name}
            <span className="dim picker-manufacturer"> {p.manufacturer}</span>
          </button>
        ))}
        {plugins && plugins.plugins.length === 0 && !plugins.scanning && (
          <span className="dim ds-value">no AU/VST3 instruments found</span>
        )}
        {!plugins && <span className="dim ds-value">loading instruments…</span>}
      </div>
    </main>
  );
}
