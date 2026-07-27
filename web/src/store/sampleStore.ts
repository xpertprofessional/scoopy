/**
 * P8-6 — the sample store: the chain that did not exist.
 *
 * `ScoopyAudio.registerSample(id, AudioBuffer)` has been sitting there since P8-2 **with no
 * producer**: nothing in `web/src` ever created an AudioBuffer, and nothing mapped the kit's
 * manifest to bytes. So the engine could render a world, and the world could name a `sampleId`, and
 * there was no way on earth to get audio behind that name. This module is that missing link:
 *
 *     kit.json  →  filePath  →  OPFS bytes  →  decodeAudioData  →  registerSample(sample.id)
 *                                                    ↓
 *                                              peaks (the browser's waveform)
 *
 * ⚠️ THE KEY IS THE KIT's `id`, NOT THE PATH. `WorldTrack.sampleId` refers to the manifest's UUID
 * (`Kit.SampleInfo.id`), while OPFS bytes are keyed by `filePath` and the decode cache by path too.
 * Those are three different keyspaces for the same audio, and conflating them is the bug this
 * module exists to prevent — so the id↔path join happens once, in `registerKit`, from the manifest
 * that owns both.
 *
 * Decoding is cached because the desktop caches (Swift's WaveformCache): re-selecting a file in the
 * browser must cost nothing, and `getFilePeaks` fires on every selection change.
 */
import type { KitJson } from "../persist/kit.ts";
import { kitSamples } from "../persist/kit.ts";
/** Only the one method this needs — NOT the concrete ScoopyAudio. The merged
    desktop app hands its samples to the NATIVE engine instead (nativeAudio.ts),
    and a concrete type here would have made that a rewrite rather than a
    swap. A kit-loader has no business knowing which engine it is filling. */
type SampleRegistrar = { registerSample(id: string, buffer: AudioBuffer): void };
import * as opfs from "./opfs.ts";

/** What the file browser will list. Anything else in the folder is not audio and is hidden. */
export const AUDIO_EXTENSIONS = ["wav", "aif", "aiff", "mp3", "m4a", "flac", "ogg", "caf"];

export function isAudioPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return AUDIO_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}

/** The `getFilePeaks` payload, minus the error field the link adds. */
export interface PeakEnvelope {
  /** Interleaved [min0,max0,min1,max1,…] — the shape `drawWave` already reads. */
  minMax: number[];
  rms: number[];
  durationMs: number;
}

/**
 * Decoded audio is big (a 4-second stereo 48k buffer is ~1.5 MB of float), so the cache is capped
 * and evicts oldest-first. Peaks are tiny and are kept for the life of the page.
 */
const DECODE_CACHE_MAX = 24;

export class SampleStore {
  private ctx: AudioContext | null = null;
  private decoded = new Map<string, AudioBuffer>();
  private peaks = new Map<string, PeakEnvelope>();

  /**
   * The decode context. Constructed lazily and left SUSPENDED — `decodeAudioData` does not need a
   * running context and does not need a user gesture, so the browser can draw a waveform before the
   * user has ever clicked play. Preview playback resumes it (inside a click, where that is legal).
   */
  audioContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: "interactive" });
    return this.ctx;
  }

  /** Decode a library file to an AudioBuffer, cached by path. */
  async decode(path: string): Promise<AudioBuffer> {
    const hit = this.decoded.get(path);
    if (hit) return hit;

    const bytes = await opfs.readFile(path);
    // decodeAudioData DETACHES the buffer it is given, so hand it a copy — the caller's bytes (and
    // any OPFS read we might want to reuse) must survive.
    const buffer = await this.audioContext().decodeAudioData(bytes.slice().buffer as ArrayBuffer);

    if (this.decoded.size >= DECODE_CACHE_MAX) {
      const oldest = this.decoded.keys().next().value;
      if (oldest !== undefined) this.decoded.delete(oldest);
    }
    this.decoded.set(path, buffer);
    return buffer;
  }

  /**
   * The preview waveform. Same peak/RMS reduction the grid's cells use, so a sample looks IDENTICAL
   * in the browser footer and in the row it lands on — which is the whole promise of the panel's
   * `drawWave` sharing (FileBrowserPanel.tsx:342).
   */
  async peakEnvelope(path: string, points: number): Promise<PeakEnvelope> {
    const key = `${path}#${points}`;
    const hit = this.peaks.get(key);
    if (hit) return hit;

    const buffer = await this.decode(path);
    const frames = buffer.length;
    const channels = buffer.numberOfChannels;
    const minMax: number[] = new Array(points * 2).fill(0);
    const rms: number[] = new Array(points).fill(0);

    // Mono-sum before reducing: a stereo file whose channels are out of phase must not read as
    // silence in one bucket and full-scale in the next.
    const data: Float32Array[] = [];
    for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

    for (let p = 0; p < points; p++) {
      const from = Math.floor((p * frames) / points);
      const to = Math.max(from + 1, Math.floor(((p + 1) * frames) / points));
      let lo = 0;
      let hi = 0;
      let sumSquares = 0;
      let n = 0;
      for (let i = from; i < to && i < frames; i++) {
        let sample = 0;
        for (let c = 0; c < channels; c++) sample += data[c]![i]!;
        sample /= channels;
        if (sample < lo) lo = sample;
        if (sample > hi) hi = sample;
        sumSquares += sample * sample;
        n++;
      }
      minMax[p * 2] = lo;
      minMax[p * 2 + 1] = hi;
      rms[p] = n > 0 ? Math.sqrt(sumSquares / n) : 0;
    }

    const envelope: PeakEnvelope = {
      minMax,
      rms,
      durationMs: (frames / buffer.sampleRate) * 1000,
    };
    this.peaks.set(key, envelope);
    return envelope;
  }

  /**
   * Hand a whole kit to the engine. THE join: the manifest is the only place that knows both the
   * UUID the world will ask for and the path the bytes live at.
   *
   * A sample that fails to decode is REPORTED, not skipped silently — a track whose audio quietly
   * never arrived is indistinguishable from a track that is meant to be silent, and the user would
   * spend an hour on the wrong bug.
   */
  async registerKit(
    kit: KitJson,
    audio: SampleRegistrar,
  ): Promise<{
    registered: number;
    failures: { name: string; error: string }[];
    /**
     * sampleId → the decoded rate. The world needs it: the document stores the sample trim in
     * MILLISECONDS and the engine wants FRAMES, and only the decoded buffer knows the rate.
     */
    rates: Map<string, number>;
  }> {
    const failures: { name: string; error: string }[] = [];
    const rates = new Map<string, number>();
    let registered = 0;

    for (const sample of kitSamples(kit)) {
      try {
        const buffer = await this.decode(sample.filePath);
        audio.registerSample(sample.id, buffer);
        rates.set(sample.id, buffer.sampleRate);
        registered++;
      } catch (err) {
        failures.push({ name: sample.name, error: (err as Error).message });
      }
    }
    return { registered, failures, rates };
  }

  /** Drop cached audio for a path that changed or was deleted underneath us. */
  invalidate(path: string): void {
    this.decoded.delete(path);
    for (const key of [...this.peaks.keys()]) {
      if (key.startsWith(`${path}#`)) this.peaks.delete(key);
    }
  }

  /**
   * Copy files into the library. This is what `chooseFolder` and a drop actually do in a browser:
   * there is no "point at a folder" — bytes come IN, once, and then they are ours.
   */
  async importFiles(destDir: string, files: File[]): Promise<{ imported: number; skipped: number }> {
    let imported = 0;
    let skipped = 0;
    for (const file of files) {
      // `webkitRelativePath` is set by a directory picker and carries the folder shape; preserve it
      // so an imported drum folder stays a drum folder instead of collapsing into a flat heap.
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (!isAudioPath(rel)) {
        skipped++;
        continue;
      }
      const target = `${destDir}/${rel}`;
      await opfs.ensureDir(opfs.parentPath(target));
      await opfs.writeFile(target, new Uint8Array(await file.arrayBuffer()));
      this.invalidate(target);
      imported++;
    }
    return { imported, skipped };
  }
}
