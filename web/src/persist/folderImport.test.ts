/**
 * P3.5-E7 — the three import doors, pinned at the decisions that can silently
 * fail. There is no jsdom in this project (P6-2b's house rule), so what is
 * tested is the READING — the parts that turn a platform gesture into entries —
 * not the markup around it.
 *
 * Every case here reproduces a way the import has actually broken or would:
 * a folder falling through to the file branch (imports a 0-byte "archive"),
 * a session named after one of its own samples, and a picker whose relative
 * paths the engine did not fill in.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  dirNameFromRelativePaths,
  entriesFromDirectoryInput,
  readDrop,
  relativePathOf,
} from "./folderImport.ts";
import { KIT_ENTRY, PATTERN_ENTRY, packageFromEntries } from "./sessionPackage.ts";

/** A File carrying the `webkitRelativePath` a directory picker fills in. */
function pickedFile(relPath: string, bytes: Uint8Array): File {
  const file = new File([bytes as BlobPart], relPath.split("/").pop() ?? relPath);
  Object.defineProperty(file, "webkitRelativePath", { value: relPath });
  return file;
}

describe("readDrop — a directory must never fall through to the file branch", () => {
  const dirEntry = { isDirectory: true, isFile: false, name: "Demo.scoopySession" };

  it("reads a dropped FOLDER as a directory, even though it also shows up in files", () => {
    // This is the real shape of a Finder folder drop: `dataTransfer.files` holds a
    // useless 0-byte File for it. Taking that branch would "import" an empty archive.
    const drop = readDrop({
      items: [{ webkitGetAsEntry: () => dirEntry as unknown as FileSystemEntry }],
      files: [new File([], "Demo.scoopySession")],
    });
    expect(drop.kind).toBe("directory");
    if (drop.kind === "directory") expect(drop.entry.name).toBe("Demo.scoopySession");
  });

  it("reads a dropped ZIP as a file", () => {
    const fileEntry = { isDirectory: false, isFile: true, name: "Demo.scoopySession.zip" };
    const zip = new File([new Uint8Array([1, 2])], "Demo.scoopySession.zip");
    const drop = readDrop({
      items: [{ webkitGetAsEntry: () => fileEntry as unknown as FileSystemEntry }],
      files: [zip],
    });
    expect(drop.kind).toBe("file");
    if (drop.kind === "file") expect(drop.file.name).toBe("Demo.scoopySession.zip");
  });

  it("falls back to files where the entry API is absent (an engine without it)", () => {
    const zip = new File([new Uint8Array([1, 2])], "Demo.scoopySession.zip");
    expect(readDrop({ items: [{}], files: [zip] }).kind).toBe("file");
    expect(readDrop({ files: [zip] }).kind).toBe("file");
  });

  it("says NONE rather than guessing when a drop carries nothing readable", () => {
    expect(readDrop({}).kind).toBe("none");
    expect(readDrop({ items: [], files: [] }).kind).toBe("none");
  });
});

describe("dirNameFromRelativePaths — the session is named after the FOLDER", () => {
  it("takes the root segment, not the file", () => {
    expect(
      dirNameFromRelativePaths(["Demo.scoopySession/pattern.json", "Demo.scoopySession/kit.json"]),
    ).toBe("Demo.scoopySession");
  });

  it("skips a path with no root rather than naming the session after a sample", () => {
    expect(dirNameFromRelativePaths(["kick.wav", "Demo.scoopySession/kit.json"])).toBe(
      "Demo.scoopySession",
    );
  });

  it("normalises separators (a Windows-side picker)", () => {
    expect(dirNameFromRelativePaths(["Demo.scoopySession\\Samples\\kick.wav"])).toBe(
      "Demo.scoopySession",
    );
  });

  it("names nothing after nothing — no relative paths at all", () => {
    expect(dirNameFromRelativePaths([])).toBe("Imported Session");
    expect(dirNameFromRelativePaths(["kick.wav"])).toBe("Imported Session");
  });
});

describe("entriesFromDirectoryInput — a picked folder reaches the ONE package reader", () => {
  const enc = new TextEncoder();
  // The real manifests the Swift desktop writes — the same fixtures
  // `sessionPackage.test.ts` reads, so a package that parses here parses there.
  const read = (name: string) =>
    readFileSync(new URL(`../../fixtures/session/${name}`, import.meta.url), "utf8");
  const PATTERN_JSON = read("session-pattern.json");
  const KIT_JSON = read("session-kit.json");
  const sampleBytes = new Uint8Array([1, 2, 3, 4]);

  it("carries a webkitdirectory FileList through to a readable package", async () => {
    const files = [
      pickedFile(`Demo.scoopySession/${PATTERN_ENTRY}`, enc.encode(PATTERN_JSON)),
      pickedFile(`Demo.scoopySession/${KIT_ENTRY}`, enc.encode(KIT_JSON)),
      pickedFile("Demo.scoopySession/Samples/kick.wav", sampleBytes),
    ];

    const { dirName, entries } = await entriesFromDirectoryInput(files);
    expect(dirName).toBe("Demo.scoopySession");

    // The payoff: `packageFromEntries` strips the common root and finds the manifests.
    // A folder import that produced entries this reader cannot open is the bug.
    const pkg = packageFromEntries(entries);
    expect([...pkg.samples.keys()]).toEqual(["Samples/kick.wav"]);
    expect(pkg.samples.get("Samples/kick.wav")).toEqual(sampleBytes);
  });

  it("uses the bare name when the engine leaves webkitRelativePath empty", () => {
    expect(relativePathOf(new File([], "kick.wav"))).toBe("kick.wav");
    expect(relativePathOf(pickedFile("Demo/kick.wav", new Uint8Array()))).toBe("Demo/kick.wav");
  });
});
