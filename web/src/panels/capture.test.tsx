import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaptureState } from "../../protocol/schema.ts";
import { CaptureChannelView, clock } from "./CaptureChannel.tsx";
import { CapturePanelView } from "./CapturePanel.tsx";

/**
 * Capture (CAP-3). The surface P4-05d deferred and never re-homed: with
 * `web.panel.toolbartools` on, GlobalToolbarView row1 is gone — including the
 * Capture button — so the app could not record at all. These pin the two things
 * that make the replacement honest: the one-button state machine, and the take
 * window's crop.
 */
const state = (over: Partial<CaptureState> = {}): CaptureState => ({
  phase: "idle",
  hasTake: false,
  waveform: [],
  trimStart: 0,
  trimEnd: 1,
  previewPlaying: false,
  savedToDisk: false,
  error: null,
  ...over,
});

describe("CaptureChannel", () => {
  it("is a sink: no level fader, no sends, no M/S", () => {
    const html = renderToStaticMarkup(
      <CaptureChannelView phase="idle" elapsedMs={0} onOp={() => {}} />,
    );
    // Capture records the main bus — it has nothing to route out and no gain of
    // its own. If a level or send ever appears here, the model has drifted.
    expect(html).not.toContain("ch-sends");
    expect(html).not.toContain("ds-geo");
    expect(html).toContain("CAPTURE");
  });

  it("idle shows READY and a record dot", () => {
    const html = renderToStaticMarkup(
      <CaptureChannelView phase="idle" elapsedMs={0} onOp={() => {}} />,
    );
    expect(html).toContain("READY");
    expect(html).toContain("●");
  });

  it("recording swaps the dot for a stop square and counts elapsed", () => {
    const html = renderToStaticMarkup(
      <CaptureChannelView phase="recording" elapsedMs={72_000} onOp={() => {}} />,
    );
    expect(html).toContain("■");
    expect(html).toContain("1:12");
    expect(html).not.toContain("READY");
  });

  it("a finished take offers the crop window on the routing baseline", () => {
    const html = renderToStaticMarkup(
      <CaptureChannelView phase="recorded" elapsedMs={0} onOp={() => {}} />,
    );
    expect(html).toContain("TAKE");
  });

  it("the button is ONE toggle in every phase — no arm step", () => {
    for (const phase of ["idle", "recording", "recorded"] as const) {
      const onOp = vi.fn();
      // The record button always dispatches `toggle`; the phase machine lives in
      // Swift (ToolbarRecorder.toggle), never in the page. A third press from
      // `recorded` therefore discards and re-records, as it does natively.
      const button = findByLabel(
        CaptureChannelView({ phase, elapsedMs: 0, onOp }),
        phase === "recording" ? "■" : "●",
      );
      expect(button).not.toBeNull();
      button?.props.onClick?.();
      expect(onOp).toHaveBeenCalledWith("toggle");
    }
  });
});

/** Finds the first control rendered with `label`, so a test can fire its click. */
function findByLabel(node: ReactNode, label: string): ReactElement<{ onClick?: () => void }> | null {
  if (!isValidElement(node)) return null;
  const props = node.props as { label?: string; children?: ReactNode };
  if (props.label === label) return node as ReactElement<{ onClick?: () => void }>;
  const kids = props.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = findByLabel(kid, label);
    if (hit) return hit;
  }
  return null;
}

describe("clock", () => {
  it("formats mm:ss, zero-padding seconds", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9_000)).toBe("0:09");
    expect(clock(72_000)).toBe("1:12");
    expect(clock(600_000)).toBe("10:00");
  });
});

describe("CapturePanel", () => {
  const render = (s: CaptureState) =>
    renderToStaticMarkup(<CapturePanelView state={s} onOp={() => {}} onLocalTrim={() => {}} />);

  it("shows the crop + both destinations once a take exists", () => {
    const html = render(state({ phase: "recorded", hasTake: true, waveform: [0.1, 0.9, 0.4] }));
    expect(html).toContain("cap-wave");
    expect(html).toContain("→ Track");
    expect(html).toContain("→ Hard Drive");
  });

  it("hides the crop while idle or recording — there is nothing to crop yet", () => {
    expect(render(state({ phase: "idle" }))).not.toContain("cap-wave");
    expect(render(state({ phase: "recording" }))).not.toContain("cap-wave");
  });

  it("a disk write replaces the button with Saved, so a take can't be double-written", () => {
    const html = render(state({ phase: "recorded", hasTake: true, savedToDisk: true }));
    expect(html).toContain("Saved");
    expect(html).not.toContain("→ Hard Drive");
  });

  it("surfaces a capture error (no owner engine / file failure)", () => {
    const html = render(state({ error: "No audio engine is driving the device — can't capture." }));
    expect(html).toContain("can&#x27;t capture");
  });
});
