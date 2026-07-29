import { useEffect, useMemo, useState } from "react";
import { SCHEMA_VERSION, HotFrameLayout } from "../protocol/schema.ts";
import { createEngineLink, fetchCapabilities } from "./engineLink.ts";
import { BrowserLink } from "./browserLink.ts";
import { useBrowserKeymap } from "./commands/browserKeymap.ts";
import { loadAndApplyTokens, refreshTokens } from "./design/tokens.ts";
import { ContextMenuProvider } from "./design/ContextMenu.tsx";
import { useNativeKeyForwarding } from "./design/keyForward.ts";
import { installFocusRelay } from "./design/focusRelay.ts";
import { attachMidiLearn } from "./state/midiLearn.ts";
import { attachScenePins } from "./state/scenePins.ts";
import { attachCapabilities } from "./state/capabilitiesStore.ts";
import { PanelTitle } from "./design/controls.tsx";
import { OutputMeter } from "./design/OutputMeter.tsx";
import { SpectralPanel } from "./panels/SpectralPanel.tsx";
import { PaintModePanel } from "./panels/PaintModePanel.tsx";
import { ImportPanel } from "./panels/ImportPanel.tsx";
import { GeneralPanel } from "./panels/GeneralPanel.tsx";
import { TemplatePanel } from "./panels/TemplatePanel.tsx";
import { AudioPanel } from "./panels/AudioPanel.tsx";
import { AppearancePanel } from "./panels/AppearancePanel.tsx";
import { MidiPanel } from "./panels/MidiPanel.tsx";
import { PerfPanel } from "./panels/PerfPanel.tsx";
import { DeckMixerPanel } from "./panels/DeckMixerPanel.tsx";
import { FxSlotPanel } from "./panels/FxSlotPanel.tsx";
import { InstrumentPanel } from "./panels/InstrumentPanel.tsx";
import { TransportPanel } from "./panels/TransportPanel.tsx";
import { GridPanel } from "./panels/GridPanel.tsx";
import { DjPanel } from "./panels/DjPanel.tsx";
import { FileBrowserPanel } from "./panels/FileBrowserPanel.tsx";
import { CapturePanel } from "./panels/CapturePanel.tsx";
import { CompanionPanel } from "./panels/CompanionPanel.tsx";
import { PlanePanel } from "./plane/PlanePanel.tsx";
import { ComposeWindow } from "./plane/ComposeWindow.tsx";

/**
 * Panel host shell: routes ?panel=<name> to its component; the debug view
 * proves the SLP link (capabilities handshake + HotFrame).
 */
export function App() {
  const link = useMemo(() => createEngineLink(), []);
  const panel = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return (
      (window as { __slPanel?: string }).__slPanel ??
      params.get("panel") ??
      // The browser companion has no host to tell it which panel to be — it IS the app, so it opens
      // on its own shell (P8-7). On macOS the host always names a panel, so this never fires there.
      (params.get("host") === "browser" ? "companion" : "debug")
    );
  }, []);

  // Merge the persisted theme over the defaults once the link is up.
  useEffect(() => {
    void loadAndApplyTokens(link);
  }, [link]);

  // Cross-webview theme sync: the Appearance editor lives in its own webview,
  // so its saves only restyled THIS panel after a reload. Native broadcasts
  // settingChanged on theme.tokens saves; re-fetch and re-apply live.
  useEffect(() => {
    if (!link) return;
    return link.onEvent((evt) => {
      const e = evt as { type?: string; key?: string };
      if (e?.type === "settingChanged" && e.key === "theme.tokens") {
        void refreshTokens(link);
      }
    });
  }, [link]);

  // BG-FIX: while the native window layer is painting a background image, every
  // page goes glass (body background: transparent) so the ONE native image shows
  // continuously behind all panels — a per-panel copy would restart the picture
  // at every webview seam. The topic is registered on every link by WebEngineLink
  // itself (no per-panel attach to forget); replay covers late subscribers.
  useEffect(() => {
    if (!link) return;
    return link.onUiState("background", (state) => {
      const hasImage = Boolean((state as { hasImage?: boolean })?.hasImage);
      document.body.classList.toggle("bg-image-live", hasImage);
    });
  }, [link]);

  // MIDI-learn (CM-2) and scene-pin (CM-3) state feed the right-click menu on
  // every DragBox, so the subscriptions belong at the root, not in one panel.
  useEffect(() => {
    if (!link) return;
    const offLearn = attachMidiLearn(link);
    const offPins = attachScenePins(link);
    // P8-9: host capabilities — shared components render native-only surfaces
    // (plugin/MIDI/output-assign) inert on hosts that answer them false. The
    // default is full caps, so the desktop never changes.
    const offCaps = attachCapabilities(link);
    return () => {
      offLearn();
      offPins();
      offCaps();
    };
  }, [link]);

  // KB-01: the native shortcut relay. The single-owner rule yields EVERY key to
  // the web while a migration webview holds first-responder, so without this a
  // click on any web control killed the whole native library until you clicked
  // back out. It mounts at the root — after the panels' own key listeners, which
  // claim what they own — so every panel inherits the shortcuts for free.
  //
  // HOST SPLIT (P8-8): in the browser there is no AppKit behind `forwardKey` —
  // the relay would preventDefault every native-owned key straight into
  // BrowserLink's documented swallow. So the browser host mounts the
  // KeyboardEvent.code keymap instead, and unmatched keys keep their browser
  // defaults (Enter activates a focused button again). Desktop is untouched by
  // construction: keyForward.ts is not modified, it just isn't given the link.
  const browserHosted = link instanceof BrowserLink ? link : null;
  useNativeKeyForwarding(browserHosted ? null : link);
  useBrowserKeymap(browserHosted);

  // Cross-webview controls-focus relay (the ö/ä fix): claims broadcast so at
  // most one accent ring exists across ALL webviews, and ö/ä landing in a
  // parked webview is relayed to the owner instead of dying. Root-mounted for
  // the same reason as the key relay — every panel gets it for free.
  useEffect(() => installFocusRelay(link), [link]);

  // Every panel is its own WKWebView; the menu host sits at the root of each so
  // a popup can't be clipped by a scrolled/transformed ancestor (CM-1).
  return (
    <ContextMenuProvider>
      <PanelRoute link={link} panel={panel} />
    </ContextMenuProvider>
  );
}

function PanelRoute({
  link,
  panel,
}: {
  link: ReturnType<typeof createEngineLink>;
  panel: string;
}) {
  if (panel === "spectral") return <SpectralPanel link={link} />;
  if (panel === "paintmode") return <PaintModePanel link={link} />;
  if (panel === "import") return <ImportPanel link={link} />;
  if (panel === "general") return <GeneralPanel link={link} />;
  if (panel === "template") return <TemplatePanel link={link} />;
  if (panel === "audio") return <AudioPanel link={link} />;
  if (panel === "appearance") return <AppearancePanel link={link} />;
  if (panel === "midi") return <MidiPanel link={link} />;
  if (panel === "perf") return <PerfPanel link={link} />;
  if (panel === "deckmixer") return <DeckMixerPanel link={link} />;
  if (panel === "fxslot") return <FxSlotPanel link={link} />;
  if (panel === "instrument") return <InstrumentPanel link={link} />;
  if (panel === "transport") return <TransportPanel link={link} />;
  // No "toolbartools" panel (TB-1): the tools row was a strip of dead controls
  // (settings/zoom/wave all no-ops once the web grid replaced the SwiftUI one)
  // wrapped around two live meters. The meters moved into the console — OUT to
  // CAPTURE, CPU to the MIXER block — and the row is gone.
  if (panel === "grid") return <GridPanel link={link} />;
  // The compose WINDOW (P3-C1): the real composer, addressed to one deck +
  // session via __slPanelArg. Spawned per strip by the plane's COMPOSE ⇱.
  if (panel === "compose") return <ComposeWindow link={link} />;
  if (panel === "djmode") return <DjPanel link={link} />;
  if (panel === "filebrowser") return <FileBrowserPanel link={link} />;
  if (panel === "capture") return <CapturePanel link={link} />;
  if (panel === "companion") return <CompanionPanel link={link} />;
  // The merged app's top-level surface (merge P2 step 4): a plane of strips on
  // the merged engine's tape/channel/routing surface. Answered only by
  // WizardMerged — ScoopyLoops.app links the pinned core, which has none of
  // that, so the panel's commands refuse there like any unimplemented method.
  if (panel === "plane") return <PlanePanel link={link} />;
  return <DebugPanel link={link} panel={panel} />;
}

function DebugPanel({
  link,
  panel,
}: {
  link: ReturnType<typeof createEngineLink>;
  panel: string;
}) {
  const [status, setStatus] = useState("connecting…");
  const [frameInfo, setFrameInfo] = useState("no HotFrame yet");

  useEffect(() => {
    if (!link) {
      setStatus("no engine link (plain-browser dev mode)");
      return;
    }
    let cancelled = false;
    fetchCapabilities(link)
      .then((caps) => {
        if (cancelled) return;
        if (caps.schemaVersion !== SCHEMA_VERSION) {
          setStatus(
            `SCHEMA MISMATCH: ui v${SCHEMA_VERSION} vs engine v${caps.schemaVersion}`,
          );
        } else {
          setStatus(`linked · schema v${caps.schemaVersion}`);
        }
      })
      .catch((err: Error) => setStatus(`handshake failed: ${err.message}`));

    let lastCounter = 0;
    let drops = 0;
    const off = link.onHotFrame((frame) => {
      const counter = frame[HotFrameLayout.frameCounter] ?? 0;
      if (lastCounter && counter > lastCounter + 1) drops += counter - lastCounter - 1;
      lastCounter = counter;
      const load = frame[HotFrameLayout.callbackLoad] ?? 0;
      setFrameInfo(
        `HotFrame #${counter} · cpu ${(load * 100).toFixed(0)}% · dropped ${drops}`,
      );
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [link]);

  return (
    <main className="panel">
      <PanelTitle>SCOOPYLOOPS · {panel}</PanelTitle>
      <p className="mono">{status}</p>
      <p className="mono dim">{frameInfo}</p>
      <OutputMeter link={link} widthPx={240} />
    </main>
  );
}
