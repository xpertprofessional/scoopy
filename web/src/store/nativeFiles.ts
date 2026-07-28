/**
 * P3-SES-1 — the library filesystem, NATIVE (the flip).
 *
 * The JUCE WKWebView host can LIST an OPFS library but cannot WRITE one
 * (measured: every "new session" was a zero-length landmine, 0cccde4). So on
 * the native host the library lives on disk behind the shell's `slFiles`
 * dispatch — same OPFS-shaped paths, same throw semantics, atomic writes —
 * and `opfs.ts` routes here whole-hog when a JUCE backend exists. Sessions,
 * samples and the file browser flip together; the browser path is untouched.
 *
 * Reached through the app's own link (`window.__scoopyLink`, the MergedLink —
 * `slFiles` is in its NATIVE_METHODS allowlist, so the routing is specified
 * and tested like every other native method). This module is called from
 * module-scoped stores with no link plumbing, which is exactly what that
 * global exists for; only if it is somehow absent does a bare `nativeLink()`
 * serve as fallback — imported LAZILY, because a static import here closes a
 * cycle (engineLink → browserLink → opfs → this file) that leaves
 * `BrowserLink` undefined at class-extends time.
 */
import { juceBackend } from "../../protocol/juceLink.ts";
import type { EngineLink } from "../engineLink.ts";
import type { OpfsEntry } from "./opfs.ts";

let cached: EngineLink | null = null;
let testLink: EngineLink | null = null;

/** Test seam: inject a fake link (pass null to restore the real one). */
export function setNativeFilesLinkForTest(link: EngineLink | null): void {
  testLink = link;
  cached = null;
}

/** True when this host's library is the native one. */
export function nativeFilesActive(): boolean {
  if (testLink) return true;
  return typeof window !== "undefined" && juceBackend() !== null;
}

async function link(): Promise<EngineLink> {
  if (testLink) return testLink;
  if (!cached) {
    const app = (window as unknown as { __scoopyLink?: EngineLink }).__scoopyLink;
    if (app) {
      cached = app;
    } else {
      const { nativeLink } = await import("../engineLink.ts");
      cached = nativeLink();
    }
  }
  return cached;
}

async function call<T>(params: Record<string, unknown>): Promise<T> {
  return (await (await link()).command("slFiles" as never, params)) as T;
}

// Base64 ↔ bytes, chunked: `String.fromCharCode(...bigArray)` overflows the
// argument list on real sample files, so the string is built in slices.
function toB64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromB64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function ensureDir(path: string): Promise<void> {
  await call<{ ok: boolean }>({ action: "mkdirs", path });
}

export async function writeFile(path: string, bytes: Uint8Array | string): Promise<void> {
  // Text goes as text (the common case — session JSON — skips base64 both
  // ways); bytes go as base64. The shell writes atomically and verifies size,
  // so a failure here THROWS and never leaves a landmine.
  if (typeof bytes === "string") await call({ action: "write", path, text: bytes });
  else await call({ action: "write", path, b64: toB64(bytes) });
}

export async function readFile(path: string): Promise<Uint8Array> {
  const r = await call<{ b64?: string }>({ action: "read", path });
  return fromB64(r.b64 ?? "");
}

export async function readText(path: string): Promise<string> {
  return new TextDecoder().decode(await readFile(path));
}

export async function exists(path: string): Promise<boolean> {
  const r = await call<{ exists?: boolean }>({ action: "exists", path });
  return r.exists === true;
}

export async function remove(path: string): Promise<void> {
  await call({ action: "remove", path });
}

export async function list(path: string): Promise<OpfsEntry[]> {
  const r = await call<{
    entries?: Array<{
      name: string;
      isDirectory: boolean;
      sizeBytes: number;
      modifiedMs: number;
    }>;
  }>({ action: "list", path });
  return (r.entries ?? []).map((e) => ({
    path: path === "/" ? `/${e.name}` : `${path}/${e.name}`,
    name: e.name,
    isDirectory: e.isDirectory,
    sizeBytes: e.sizeBytes,
    modifiedMs: e.modifiedMs,
  }));
}
