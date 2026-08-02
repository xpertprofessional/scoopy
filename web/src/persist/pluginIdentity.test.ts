import { describe, expect, it } from "vitest";
import {
  portableRefFor,
  resolveInstrumentIdentifier,
  type PortablePluginRef,
  type ScannedPlugin,
} from "./pluginIdentity.ts";

/**
 * S6 — the resolve ladder, rung by rung, against the donor's own semantics
 * (BeatSequencer.swift:19809). Each rung exists because the one above it can
 * fail on a real machine, and a wrong order is a wrong answer precisely where
 * it matters: somebody else's computer.
 */

const AU: ScannedPlugin = { identifier: "AudioUnit-Massive-1a2b", name: "Massive", manufacturer: "NI" };
const VST: ScannedPlugin = { identifier: "VST3-Massive-9f8e", name: "Massive", manufacturer: "NI" };
const OTHER: ScannedPlugin = { identifier: "VST3-Serum-4c4c", name: "Serum", manufacturer: "Xfer" };

const ref = (over: Partial<PortablePluginRef> = {}): PortablePluginRef => ({
  manufacturer: "NI",
  name: "Massive",
  version: "1.5.0",
  ...over,
});

describe("resolveInstrumentIdentifier", () => {
  it("rung 1 — an unbound track resolves to nothing", () => {
    expect(resolveInstrumentIdentifier(null, ref(), [AU])).toBeNull();
    expect(resolveInstrumentIdentifier("", ref(), [AU])).toBeNull();
  });

  it("rung 2 — the exact identifier wins, and is the only same-binary guarantee", () => {
    expect(resolveInstrumentIdentifier(AU.identifier, ref(), [AU, VST])).toBe(AU.identifier);
  });

  it("rung 3 — no portable ref means no guessing", () => {
    // Pre-v32 sessions have nothing to search WITH. Guessing from a bare
    // format-encoded string is how you load someone else's plugin that happens
    // to share a name.
    expect(resolveInstrumentIdentifier(AU.identifier, null, [VST])).toBeNull();
  });

  it("rung 4a — falls to the ref's own per-format hint", () => {
    // The AU is gone; the session was authored against it; the VST3 is here and
    // the ref knows its id.
    const r = ref({ au: AU.identifier, vst3: VST.identifier });
    expect(resolveInstrumentIdentifier(AU.identifier, r, [VST, OTHER])).toBe(VST.identifier);
  });

  it("rung 4b — then manufacturer+name in ANY format, case-insensitively", () => {
    // No hint matches, but the plugin is plainly installed under another id.
    // Vendors are not consistent about capitalisation between formats, and a
    // case difference would look exactly like "not installed".
    const r = ref({ manufacturer: "ni", name: "MASSIVE" });
    expect(resolveInstrumentIdentifier("AudioUnit-gone", r, [OTHER, VST])).toBe(VST.identifier);
  });

  it("resolves to nothing when nothing here can stand in", () => {
    // The caller's contract: inert, but the binding is PRESERVED in the file.
    expect(resolveInstrumentIdentifier("AudioUnit-gone", ref(), [OTHER])).toBeNull();
  });

  it("does NOT match on version — an update is still the plugin you meant", () => {
    // The donor omits version deliberately. Matching it would make every vendor
    // update silence a session.
    const r = ref({ version: "9.9.9" });
    expect(resolveInstrumentIdentifier("AudioUnit-gone", r, [VST])).toBe(VST.identifier);
  });

  it("never mutates its inputs — the file keeps the binding it was authored with", () => {
    // The rule most likely to be "improved" away. Rewriting the stored id would
    // rebind the session to this machine's plugin set the first time it opened
    // somewhere else, and carrying it home would no longer resolve exactly.
    const r = ref({ au: AU.identifier });
    const before = JSON.stringify(r);
    const list = [VST, OTHER];
    const listBefore = JSON.stringify(list);
    resolveInstrumentIdentifier(AU.identifier, r, list);
    expect(JSON.stringify(r)).toBe(before);
    expect(JSON.stringify(list)).toBe(listBefore);
  });
});

describe("portableRefFor", () => {
  it("files the id under its OWN format, which is what makes rung 4a work later", () => {
    const r = portableRefFor(AU, "au", "1.5.0");
    expect(r.au).toBe(AU.identifier);
    expect(r.vst3).toBeUndefined();
    expect(r.manufacturer).toBe("NI");
    // …and it round-trips: saved here, resolved on a machine with only the VST3.
    const withBoth = { ...r, vst3: VST.identifier };
    expect(resolveInstrumentIdentifier(AU.identifier, withBoth, [VST])).toBe(VST.identifier);
  });
});
