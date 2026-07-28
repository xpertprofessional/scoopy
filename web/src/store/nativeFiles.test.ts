// P3-SES-1 — the library filesystem's native route.
//
// What must hold on the JUCE host: `opfs.ts` delegates every I/O call to the
// `slFiles` dispatch (sessions, samples and the file browser flip together),
// bytes survive the base64 crossing exactly (including >127 values and
// payloads bigger than the encoder's chunk), and failure keeps OPFS's throw
// semantics so callers' error surfaces don't fork by host.
import { afterEach, describe, expect, it } from "vitest";

import type { EngineLink } from "../engineLink.ts";
import * as opfs from "./opfs.ts";
import {
  nativeFilesActive,
  setNativeFilesLinkForTest,
} from "./nativeFiles.ts";

/** An in-memory slFiles host, faithful to SlDispatch's envelope: `command`
    resolves with the RESULT object and throws on a refusal. */
function fakeHost() {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  const calls: string[] = [];
  const norm = (p: string) => "/" + p.split("/").filter(Boolean).join("/");
  const parent = (p: string) => norm(p.split("/").slice(0, -1).join("/"));
  const link = {
    async command(method: string, params: unknown): Promise<unknown> {
      expect(method).toBe("slFiles");
      const { action, path, text, b64 } = params as {
        action: string;
        path: string;
        text?: string;
        b64?: string;
      };
      const p = norm(path);
      calls.push(`${action} ${p}`);
      if (action === "mkdirs") {
        for (let d = p; d !== "/"; d = parent(d)) dirs.add(d);
        return { ok: true };
      }
      if (action === "write") {
        if (text === undefined && b64 === undefined) throw new Error("slFiles/write: text or b64 required");
        for (let d = parent(p); d !== "/"; d = parent(d)) dirs.add(d);
        files.set(
          p,
          text !== undefined
            ? new TextEncoder().encode(text)
            : Uint8Array.from(atob(b64 ?? ""), (c) => c.charCodeAt(0)),
        );
        return { ok: true };
      }
      if (action === "read") {
        const bytes = files.get(p);
        if (!bytes) throw new Error("slFiles/read: no such file");
        let s = "";
        for (const byte of bytes) s += String.fromCharCode(byte);
        return { ok: true, b64: btoa(s) };
      }
      if (action === "exists") return { ok: true, exists: files.has(p) || dirs.has(p) };
      if (action === "remove") {
        if (!files.has(p) && !dirs.has(p)) throw new Error("slFiles/remove: no such entry");
        files.delete(p);
        dirs.delete(p);
        for (const key of [...files.keys()]) if (key.startsWith(p + "/")) files.delete(key);
        return { ok: true };
      }
      if (action === "list") {
        if (!dirs.has(p)) throw new Error("slFiles/list: no such directory");
        const seen = new Map<string, { isDirectory: boolean; sizeBytes: number }>();
        for (const key of files.keys())
          if (parent(key) === p)
            seen.set(key.split("/").pop()!, { isDirectory: false, sizeBytes: files.get(key)!.length });
        for (const d of dirs)
          if (d !== p && parent(d) === p) seen.set(d.split("/").pop()!, { isDirectory: true, sizeBytes: 0 });
        return {
          ok: true,
          entries: [...seen.entries()].map(([name, e]) => ({ name, ...e, modifiedMs: 0 })),
        };
      }
      throw new Error(`slFiles: unknown action '${action}'`);
    },
  } as unknown as EngineLink;
  return { link, files, calls };
}

afterEach(() => setNativeFilesLinkForTest(null));

describe("the native library route (P3-SES-1)", () => {
  it("is inactive without a JUCE backend — the browser keeps OPFS", () => {
    expect(nativeFilesActive()).toBe(false);
  });

  it("routes opfs writes/reads through slFiles, text round-tripping exactly", async () => {
    const { link, calls } = fakeHost();
    setNativeFilesLinkForTest(link);
    await opfs.writeFile("/sessions/Untitled 2/pattern.json", '{"bpm":120}');
    expect(await opfs.readText("/sessions/Untitled 2/pattern.json")).toBe('{"bpm":120}');
    expect(calls[0]).toBe("write /sessions/Untitled 2/pattern.json");
  });

  it("round-trips binary bytes exactly, past the base64 chunk boundary", async () => {
    const { link } = fakeHost();
    setNativeFilesLinkForTest(link);
    // Bigger than the 0x8000 fromCharCode chunk, every byte value present —
    // the payload shape of a real sample file.
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await opfs.writeFile("/samples/kit/hit.wav", bytes);
    expect(await opfs.readFile("/samples/kit/hit.wav")).toEqual(bytes);
  });

  it("keeps OPFS's throw semantics: a missing file throws, it does not null", async () => {
    const { link } = fakeHost();
    setNativeFilesLinkForTest(link);
    await expect(opfs.readText("/sessions/Nope/pattern.json")).rejects.toThrow(/no such file/);
    await expect(opfs.list("/nowhere")).rejects.toThrow(/no such directory/);
    await expect(opfs.remove("/nothing")).rejects.toThrow(/no such entry/);
  });

  it("lists the session library shape the store expects (dirs under /sessions)", async () => {
    const { link } = fakeHost();
    setNativeFilesLinkForTest(link);
    await opfs.writeFile("/sessions/A/pattern.json", "{}");
    await opfs.ensureDir("/sessions/B");
    const dirs = await opfs.listDirs("/sessions");
    expect(dirs.sort()).toEqual(["A", "B"]);
  });

  it("walkFiles and copyInto ride the same route (import/export unchanged)", async () => {
    const { link } = fakeHost();
    setNativeFilesLinkForTest(link);
    await opfs.copyInto("/sessions/Pkg", [
      ["pattern.json", new TextEncoder().encode("{}")],
      ["Samples/kick.wav", Uint8Array.of(1, 2, 3)],
    ]);
    const walked = await opfs.walkFiles("/sessions/Pkg");
    expect([...walked.keys()].sort()).toEqual(["Samples/kick.wav", "pattern.json"]);
    expect(walked.get("Samples/kick.wav")).toEqual(Uint8Array.of(1, 2, 3));
  });
});
