/**
 * P8-6 — the session library, over OPFS.
 *
 * The prize test is `preserves an unrecognised archive entry across a FULL round-trip`. It is the
 * container half of preserve-don't-drop, and it caught a real bug in the first draft of this module:
 * `packageSession` passed `extras: new Map()`, so a `.scoopySession` carrying `notes.txt` would come
 * back from the companion with `notes.txt` DELETED — silently, with a well-formed zip and every
 * other test still green. That is the exact failure P8-0's header warns about, one level up from the
 * schema. Byte-identical output is not enough; you have to check that what you never understood is
 * still there.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unpackSession } from "../persist/sessionPackage.ts";
import { kitSamples } from "../persist/kit.ts";
import { installFakeOpfs } from "./opfsFake.ts";
import * as opfs from "./opfs.ts";
import {
  importSessionFile,
  listSessions,
  openSession,
  packageSession,
  saveSession,
  type WorkingSession,
} from "./sessionStore.ts";

const FIXTURE = fileURLToPath(new URL("../../fixtures/session/session.zip", import.meta.url));

let reset: () => void;
beforeEach(() => {
  reset = installFakeOpfs();
});
afterEach(() => reset());

/** The real Swift-written package — the same bytes `sessionPackage.zip.test.ts` reads. */
async function fixtureFile(): Promise<File> {
  const bytes = await readFile(FIXTURE);
  return new File([bytes], "Demo.scoopySession");
}

describe("importSessionFile", () => {
  it("lands the package's samples in the LIBRARY, browsable, and rewrites the kit to match", async () => {
    const session = await importSessionFile(await fixtureFile());

    // The samples are now real library files — which is the whole payoff of OPFS-as-library: a
    // session from the studio arrives with its audio, and every sample it carries is immediately
    // browsable and auditionable in the panel.
    expect(await opfs.exists("/samples/Demo/kick.wav")).toBe(true);
    expect(await opfs.exists("/samples/Demo/snare.wav")).toBe(true);

    // ...and the kit points at them, not at `Samples/kick.wav`, which resolves to nothing here.
    const paths = kitSamples(session.kit).map((s) => s.filePath);
    expect(paths).toContain("/samples/Demo/kick.wav");
    expect(paths).toContain("/samples/Demo/snare.wav");
  });

  it("puts the session in the library, so a reload finds it", async () => {
    await importSessionFile(await fixtureFile());

    expect((await listSessions()).map((s) => s.name)).toEqual(["Demo"]);
    const reopened = await openSession("Demo");
    expect(kitSamples(reopened.kit).length).toBe(2);
  });
});

describe("packageSession", () => {
  it("rewrites library paths back to package-relative ones — never an absolute path", async () => {
    const imported = await importSessionFile(await fixtureFile());
    const { bytes, missing } = await packageSession(imported);
    expect(missing).toEqual([]);

    const pkg = unpackSession(bytes);
    for (const sample of kitSamples(pkg.kit)) {
      // kit.ts:52 — "the companion must never write an absolute path". Pin it.
      expect(sample.filePath.startsWith("Samples/")).toBe(true);
    }
    expect([...pkg.samples.keys()].sort()).toEqual(["Samples/kick.wav", "Samples/snare.wav"]);
  });

  it("preserves an unrecognised archive entry across a FULL round-trip", async () => {
    const original = unpackSession(new Uint8Array(await (await fixtureFile()).arrayBuffer()));
    expect(original.extras.has("notes.txt")).toBe(true); // the fixture's tripwire

    // zip → OPFS → (reload from OPFS, as a reboot would) → zip
    await importSessionFile(await fixtureFile());
    const reloaded = await openSession("Demo");
    const { bytes } = await packageSession(reloaded);
    const roundTripped = unpackSession(bytes);

    expect(roundTripped.extras.has("notes.txt")).toBe(true);
    expect(roundTripped.extras.get("notes.txt")).toEqual(original.extras.get("notes.txt"));
  });

  it("carries the sample bytes through unchanged", async () => {
    const original = unpackSession(new Uint8Array(await (await fixtureFile()).arrayBuffer()));
    await importSessionFile(await fixtureFile());
    const { bytes } = await packageSession(await openSession("Demo"));
    const roundTripped = unpackSession(bytes);

    expect(roundTripped.samples.get("Samples/kick.wav")).toEqual(
      original.samples.get("Samples/kick.wav"),
    );
  });

  it("de-duplicates a BASENAME COLLISION instead of silently overwriting one sample", async () => {
    // The library is a tree; `Samples/` in the package is FLAT. Two different samples that happen to
    // share a basename would collapse into one entry — and two tracks on the desktop would quietly
    // play the same audio. This is only visible if you look for it.
    await opfs.ensureDir("/samples/Kicks");
    await opfs.ensureDir("/samples/Snares");
    await opfs.writeFile("/samples/Kicks/hit.wav", new Uint8Array([1, 1, 1]));
    await opfs.writeFile("/samples/Snares/hit.wav", new Uint8Array([2, 2, 2]));

    const base = await importSessionFile(await fixtureFile());
    const session: WorkingSession = {
      ...base,
      kit: {
        ...base.kit,
        samples: [
          { id: "a", name: "Kick", filePath: "/samples/Kicks/hit.wav", defaultVolume: 1, defaultPan: 0 },
          { id: "b", name: "Snare", filePath: "/samples/Snares/hit.wav", defaultVolume: 1, defaultPan: 0 },
        ],
      },
    };

    const pkg = unpackSession((await packageSession(session)).bytes);
    expect([...pkg.samples.keys()].sort()).toEqual(["Samples/hit-2.wav", "Samples/hit.wav"]);
    // Both sets of bytes survived, and the kit points each track at its OWN file.
    expect([...pkg.samples.values()].map((b) => b[0]).sort()).toEqual([1, 2]);
    const byName = Object.fromEntries(kitSamples(pkg.kit).map((s) => [s.name, s.filePath]));
    expect(byName.Kick).not.toBe(byName.Snare);
  });

  it("REPORTS a sample that vanished from the library rather than shipping a broken session", async () => {
    const imported = await importSessionFile(await fixtureFile());
    await opfs.remove("/samples/Demo/kick.wav");

    const { missing } = await packageSession(await openSession("Demo"));
    expect(missing.length).toBe(1);
  });
});

describe("saveSession", () => {
  it("round-trips a session through OPFS byte-for-byte", async () => {
    const imported = await importSessionFile(await fixtureFile());
    const before = (await packageSession(imported)).bytes;

    await saveSession(imported);
    const after = (await packageSession(await openSession("Demo"))).bytes;

    expect(after).toEqual(before);
  });
});
