/**
 * P8-6 — the audition player.
 *
 * The point of the browser panel, in its own words: *"you see and hear the sample BEFORE you spend
 * a track on it"* (FileBrowserPanel.tsx:301). On the desktop that is Swift's preview player; here it
 * is a plain `AudioBufferSourceNode`.
 *
 * ⚠️ DELIBERATELY NOT THE ENGINE. Auditioning does not go through the WASM worklet — it is a bare
 * Web Audio graph. That keeps the file browser fully alive before the engine has ever booted (and
 * with no emscripten build present at all), and it means a preview can never inject a voice into a
 * playing pattern. The desktop draws the same line for the same reason.
 *
 * Level and playhead are POLLED, not pushed: the panel reads `previewLevel`/`previewProgress` out of
 * the HotFrame at 30 Hz like every other meter (ARCHITECTURE: hot surfaces never re-render), so the
 * link's frame pump asks this object for its two numbers each tick.
 */
import type { SampleStore } from "./sampleStore.ts";

export class PreviewPlayer {
  private source: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuf = new Float32Array(1024);
  private startedAt = 0;
  private durationSec = 0;
  private playingPath: string | null = null;

  constructor(
    private store: SampleStore,
    /** Fired when playback ends on its own, so the backend can re-publish `previewPlaying: false`. */
    private onEnded: () => void,
  ) {}

  get playing(): boolean {
    return this.source !== null;
  }

  get path(): string | null {
    return this.playingPath;
  }

  /** Start (or restart) the audition. Must be reached from a user gesture — it resumes the context. */
  async play(path: string): Promise<void> {
    this.stop();

    const ctx = this.store.audioContext();
    // Every browser starts an AudioContext suspended unless it was born in a gesture. Selecting a
    // row IS a gesture, so this resolves; without it the graph runs and makes no sound, silently.
    if (ctx.state === "suspended") await ctx.resume();

    const buffer = await this.store.decode(path);
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;

    source.connect(analyser);
    analyser.connect(ctx.destination);

    source.onended = () => {
      // `stop()` also fires onended; guard so a manual stop does not double-report.
      if (this.source !== source) return;
      this.teardown();
      this.onEnded();
    };

    source.start();
    this.source = source;
    this.analyser = analyser;
    this.meterBuf = new Float32Array(analyser.fftSize);
    this.startedAt = ctx.currentTime;
    this.durationSec = buffer.duration;
    this.playingPath = path;
  }

  stop(): void {
    const source = this.source;
    if (!source) return;
    this.teardown();
    try {
      source.stop();
    } catch {
      // Already stopped — the spec throws on a second stop(); nothing to do.
    }
  }

  private teardown(): void {
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.analyser = null;
    this.playingPath = null;
  }

  /** RMS of the current window, 0 when idle — HotFrame slot `previewLevel`. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sumSquares = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const s = this.meterBuf[i]!;
      sumSquares += s * s;
    }
    return Math.sqrt(sumSquares / this.meterBuf.length);
  }

  /** 0..1 through the sample, or -1 when idle — HotFrame slot `previewProgress` (-1 = hide). */
  progress(): number {
    if (!this.source || this.durationSec <= 0) return -1;
    const elapsed = this.store.audioContext().currentTime - this.startedAt;
    return Math.min(1, Math.max(0, elapsed / this.durationSec));
  }
}
