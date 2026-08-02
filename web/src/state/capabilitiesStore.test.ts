import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { attachCapabilities, getCaps, useCapabilitiesStore } from "./capabilitiesStore.ts";

/**
 * P8-9 — the safety property under test is DEFAULT-FULL: the desktop must
 * render identically before the handshake, after it, and when it never
 * arrives. Only a successfully parsed host answer narrows anything.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));

const linkAnswering = (result: unknown): EngineLink => ({
  command: () => Promise.resolve(result),
  paramWrite: () => {},
  onHotFrame: () => () => {},
  onEvent: () => () => {},
  onUiState: () => () => {},
});

const BROWSER_CAPS = {
  schemaVersion: SCHEMA_VERSION,
  pluginHosting: false,
  fileSystem: true,
  midiHardware: false,
  audioDeviceSelection: false,
  returnFx: false,
  tape: false, // v100: the WASM engine has no recorder and no looper
};

describe("capabilitiesStore (P8-9)", () => {
  afterEach(async () => {
    await flush(); // let any in-flight attach settle before the next test
    useCapabilitiesStore.setState({
      caps: {
        ...getCaps(),
        pluginHosting: true,
        midiHardware: true,
        audioDeviceSelection: true,
        returnFx: true,
      },
    });
  });

  it("defaults to full capabilities", () => {
    const caps = getCaps();
    expect(caps.pluginHosting).toBe(true);
    expect(caps.midiHardware).toBe(true);
    expect(caps.audioDeviceSelection).toBe(true);
    expect(caps.fileSystem).toBe(true);
  });

  it("narrows on a host's successful answer", async () => {
    const off = attachCapabilities(linkAnswering(BROWSER_CAPS));
    await flush();
    expect(getCaps().pluginHosting).toBe(false);
    expect(getCaps().midiHardware).toBe(false);
    expect(getCaps().audioDeviceSelection).toBe(false);
    expect(getCaps().fileSystem).toBe(true);
    off();
  });

  it("a rejecting link leaves full caps (desktop degraded mode = unchanged UI)", async () => {
    const rejecting: EngineLink = {
      ...linkAnswering({}),
      command: () => Promise.reject(new Error("bridge down")),
    };
    const off = attachCapabilities(rejecting);
    await flush();
    expect(getCaps().pluginHosting).toBe(true);
    off();
  });

  it("a malformed answer leaves full caps (parse failure never narrows)", async () => {
    const off = attachCapabilities(linkAnswering({ nonsense: true }));
    await flush();
    expect(getCaps().pluginHosting).toBe(true);
    off();
  });

  it("detach restores full caps and cancels a late answer", async () => {
    let resolve!: (v: unknown) => void;
    const slow: EngineLink = {
      ...linkAnswering({}),
      command: () => new Promise((r) => (resolve = r)),
    };
    const off = attachCapabilities(slow);
    off(); // detached before the answer lands
    resolve(BROWSER_CAPS);
    await flush();
    expect(getCaps().pluginHosting).toBe(true); // the late answer was dropped
  });
});
