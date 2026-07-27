import { useEffect, useState } from "react";
import { COMMANDS, ToolbarUiState, type FxSlotState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, PanelTitle } from "../design/controls.tsx";
import { semanticColor } from "../design/tokens.ts";
import { WaitingForState } from "./WaitingForState.tsx";
import "./deckmixer.css";

/**
 * FX slot window (MIX-R8, carved down in the mixer overhaul): the PLUGIN
 * SCANNER/PICKER for one send — and nothing else. Every control it used to
 * hold (HOST/EXT, PRE/POST, EDIT, the output routing) lives inline on the
 * mixer strip now; this window is only how you CHOOSE a plugin, which needs
 * a scrollable list no strip has room for. Hosted by FxSlotWindowController
 * in a floating NSWindow.
 *
 * (Why a window at all: this began as an in-page popover on the mixer strip,
 * which never showed — the mixer's WKWebView is a short toolbar strip and a
 * popover cannot escape its host web view.)
 *
 * The target return arrives as `window.__slPanelArg` (injected at document
 * start by WebPanelHostView).
 */
type PluginList = ReturnType<typeof COMMANDS.listPlugins.result.parse>;

export function FxSlotPanel({ link }: { link: EngineLink | null }) {
  const returnIndex = Number(
    (window as { __slPanelArg?: string }).__slPanelArg ??
      new URLSearchParams(location.search).get("arg") ??
      1,
  );

  const [state, setState] = useState<ToolbarUiState | null>(null);
  const [plugins, setPlugins] = useState<PluginList | null>(null);

  const fetchPlugins = () =>
    link
      ?.command("listPlugins", {})
      .then((raw) => setPlugins(COMMANDS.listPlugins.result.parse(raw)))
      .catch(() => {});

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
    const off = link.onUiState("toolbar", (raw) => {
      const parsed = ToolbarUiState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "toolbar" }).catch(() => {});
    void fetchPlugins();
    return off;
  }, [link]);

  const slot: FxSlotState | undefined = state?.fxSlots[returnIndex - 1];
  if (!slot) {
    return <WaitingForState topics={["toolbar"]} className="fxslot-panel mono dim" />;
  }

  return (
    // This window floats free of the mixer, so its title is the ONLY thing that
    // says which return you are picking for — it carries the send identity color.
    <main
      className="fxslot-panel sem"
      style={{ "--sem-color": semanticColor("send", returnIndex - 1) } as React.CSSProperties}
    >
      <PanelTitle>
        <span className="sem-ink">FX {returnIndex} · plugin</span>
      </PanelTitle>

      <div className="fx-row">
        <Button
          label="RESCAN"
          onClick={() => {
            link?.command("rescanPlugins", {}).catch(() => {});
            setTimeout(fetchPlugins, 1500);
          }}
        />
        {plugins?.scanning && <span className="dim ds-value">scanning…</span>}
        {/* Reported plugin latency — a readout about the LOADED plugin, so it
            stays beside the list that loads one. */}
        {slot.latencyMs > 0 && <span className="dim ds-value">{slot.latencyMs.toFixed(1)} ms</span>}
      </div>

      <div className="fx-picker-list">
        <button
          className={`ds-button fx-picker-item${slot.pluginName === null ? " active" : ""}`}
          onClick={() =>
            link?.command("selectFxPlugin", { returnIndex, identifier: null }).catch(() => {})
          }
        >
          — none —
        </button>
        {(plugins?.plugins ?? []).map((p) => (
          <button
            key={p.identifier}
            className={`ds-button fx-picker-item${p.name === slot.pluginName ? " active" : ""}`}
            title={`${p.manufacturer} · ${p.format}`}
            onClick={() =>
              link
                ?.command("selectFxPlugin", { returnIndex, identifier: p.identifier })
                .catch(() => {})
            }
          >
            {p.name}
            <span className="dim picker-manufacturer"> {p.manufacturer}</span>
          </button>
        ))}
        {plugins && plugins.plugins.length === 0 && !plugins.scanning && (
          <span className="dim ds-value">no AU/VST3 plugins found</span>
        )}
        {!plugins && <span className="dim ds-value">loading plugins…</span>}
      </div>
    </main>
  );
}
