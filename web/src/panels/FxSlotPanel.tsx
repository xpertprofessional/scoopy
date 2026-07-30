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

/**
 * The window's address, resolved and VALIDATED (P6-2b).
 *
 * `raw` is whatever arrived as `__slPanelArg` / `?arg=`; the answer is a 1-based
 * return index, or null for "this window was addressed to something that is not
 * a return". Null is a real answer the panel renders as a refusal — it used to
 * be impossible to distinguish from a slow engine:
 *
 * the plane's ≡ menu passed the 0-based menu ROW as the arg, so `FX 1` sent
 * "0"; `fxSlots[0 - 1]` is `fxSlots[-1]` → undefined → the panel fell through to
 * `WaitingForState` and sat on "waiting for state" forever. Meanwhile `FX 2`…
 * `FX 4` addressed returns 1…3, and return 4 had no door at all.
 *
 * Absent is NOT an error: an unaddressed window opens on return 1, which is
 * what the old `?? 1` fallback meant and is still useful in the browser dev
 * host. Only a PRESENT-but-invalid address is refused.
 */
export function addressedReturn(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return n;
}

export function FxSlotPanel({ link }: { link: EngineLink | null }) {
  const returnIndex = addressedReturn(
    (window as { __slPanelArg?: string }).__slPanelArg ??
      new URLSearchParams(location.search).get("arg"),
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

  // A REFUSAL, not an eternal spinner (see addressedReturn). The panel must not
  // depend on every future caller getting the base right.
  if (returnIndex === null) {
    return (
      <main className="fxslot-panel mono dim">
        <PanelTitle>FX · not addressed</PanelTitle>
        <p className="ds-value">this window was not opened for a return — returns are 1–4</p>
      </main>
    );
  }

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
