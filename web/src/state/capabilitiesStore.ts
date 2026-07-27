import { useEffect, useState } from "react";
import { create } from "zustand";
import { SCHEMA_VERSION, Capabilities } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";

/**
 * Host capabilities (P8-9) — what the engine host can actually DO, so shared
 * components can render native-only surfaces inert instead of broken.
 *
 * The default is FULL capabilities on purpose: Swift answers every flag true,
 * so the desktop render path is identical under every ordering — before the
 * handshake resolves, if it never resolves, and after it resolves. Only a
 * successful parse of a host's answer narrows anything (the browser companion
 * answers pluginHosting/midiHardware/audioDeviceSelection false).
 */
const FULL_CAPS: Capabilities = {
  schemaVersion: SCHEMA_VERSION,
  pluginHosting: true,
  fileSystem: true,
  midiHardware: true,
  audioDeviceSelection: true,
  returnFx: true,
};

interface Store {
  caps: Capabilities;
}

export const useCapabilitiesStore = create<Store>(() => ({ caps: FULL_CAPS }));

/** Hook for components. Never null — full caps until a host says otherwise.
 * Reads the CURRENT state at render (not zustand's server snapshot, which is
 * pinned to the initial state and would blind SSR/render-to-markup tests to a
 * narrowed store), then subscribes for live narrowing after mount. */
export function useCapabilities(): Capabilities {
  const [caps, setCaps] = useState(() => useCapabilitiesStore.getState().caps);
  useEffect(() => {
    setCaps(useCapabilitiesStore.getState().caps); // anything missed pre-subscribe
    return useCapabilitiesStore.subscribe((s) => setCaps(s.caps));
  }, []);
  return caps;
}

/** Non-React callers. */
export function getCaps(): Capabilities {
  return useCapabilitiesStore.getState().caps;
}

/**
 * Fetch the host's answer and narrow the store — root-mounted next to
 * attachScenePins/attachMidiLearn. A failed handshake leaves full caps: the
 * desktop's degraded mode is "everything renders as before", not "controls
 * vanish because a promise rejected".
 */
export function attachCapabilities(link: EngineLink): () => void {
  let cancelled = false;
  link
    .command("getCapabilities", {})
    .then((raw) => {
      // Parsed here (not via fetchCapabilities) so this module stays free of
      // engineLink's window-bound module scope; a malformed answer never narrows.
      const parsed = Capabilities.safeParse(raw);
      if (!cancelled && parsed.success) useCapabilitiesStore.setState({ caps: parsed.data });
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    useCapabilitiesStore.setState({ caps: FULL_CAPS });
  };
}
