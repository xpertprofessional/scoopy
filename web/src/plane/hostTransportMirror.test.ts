import { describe, expect, it } from "vitest";

import { adoptHostTransport, type HostTransportState } from "./hostTransportMirror.ts";

const base: HostTransportState = {
  followTransport: true,
  hostPlaying: false,
  mirrored: null,
  hasSession: true,
  deckPlaying: false,
};

describe("adoptHostTransport", () => {
  it("adopts the DAW's play edge", () => {
    expect(adoptHostTransport({ ...base, hostPlaying: true, mirrored: false })).toEqual({
      act: "play",
      mirrored: true,
    });
  });

  it("adopts the DAW's stop edge", () => {
    expect(
      adoptHostTransport({ ...base, hostPlaying: false, mirrored: true, deckPlaying: true }),
    ).toEqual({ act: "stop", mirrored: false });
  });

  it("does nothing on a repeat of what it already adopted", () => {
    // `hostTransport` is change-detected natively, but the boot read can repeat
    // it, and an effect re-runs for reasons of its own.
    expect(adoptHostTransport({ ...base, hostPlaying: true, mirrored: true })).toEqual({
      act: null,
      mirrored: true,
    });
  });

  it("LEAVES A ◼ ALONE while the DAW keeps rolling — the half that keeps ◼ real", () => {
    // The user stopped a deck the host is still playing. That is a stated stop
    // and the processor honours it; a re-render must not start it again.
    const stopped = adoptHostTransport({
      ...base,
      hostPlaying: true,
      mirrored: true,
      deckPlaying: false,
    });
    expect(stopped.act).toBeNull();
  });

  it("holds the edge until a session exists — a window opened mid-playback", () => {
    // The panel boots asynchronously: the DAW's transport is known before the
    // document is. Recording the edge here would mean never adopting it.
    const empty = adoptHostTransport({ ...base, hostPlaying: true, hasSession: false });
    expect(empty).toEqual({ act: null, mirrored: null });
    expect(adoptHostTransport({ ...base, hostPlaying: true, mirrored: empty.mirrored })).toEqual({
      act: "play",
      mirrored: true,
    });
  });

  it("CONSUMES an edge that changes nothing", () => {
    // The user pressed ▸ a beat before the DAW did. Nothing to do — but the
    // edge is spent, or the next stop would be read as a play edge.
    expect(
      adoptHostTransport({ ...base, hostPlaying: true, mirrored: false, deckPlaying: true }),
    ).toEqual({ act: null, mirrored: true });
  });

  it("CLK INT hands the transport back, and forgets", () => {
    expect(
      adoptHostTransport({ ...base, followTransport: false, hostPlaying: true, mirrored: false }),
    ).toEqual({ act: null, mirrored: null });
  });
});
