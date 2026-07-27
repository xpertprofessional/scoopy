import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChannelStrip } from "./ChannelStrip.tsx";
import { DEFAULT_TOKENS, semanticColor } from "../design/tokens.ts";

/**
 * Render evidence for the SEMANTIC surfaces (Phase SEM, DESIGN-SYSTEM §2b).
 *
 * The point of the system is a link between two controls that are FAR APART on
 * screen — a track's send 3 and the mixer's FX3 return — so the thing worth
 * pinning is not "a color appears" but "the SAME color appears on both ends".
 * These render the mixer half; the track-row half (`S1..S4`, the `M<n>·<TGT>`
 * slots) is covered by trackRowControls.test.tsx's band render.
 */

const SEND = DEFAULT_TOKENS.semantic.send;
const DECK = DEFAULT_TOKENS.semantic.deck;

const noop = () => {};
const level = { value: 0.8, min: 0, max: 1, onChange: noop };

describe("mixer channel identity", () => {
  it("an FX return wears the SAME color as the send that feeds it", () => {
    // FX3's return channel and every track's S3 slider are one signal path.
    // returnIndex is 1-based, the palette is 0-based — the off-by-one here is
    // exactly the bug that would silently mis-pair every send with the wrong bus.
    const returnIndex = 3;
    const html = renderToStaticMarkup(
      <ChannelStrip
        label={`FX${returnIndex}`}
        identity={semanticColor("send", returnIndex - 1)}
        level={level}
        bottom={null}
      />,
    );
    expect(html).toContain(`--sem-color:${SEND[2]}`); // S3's color, not S4's
    expect(html).toContain("sem-fill");
  });

  it("a deck strip wears its deck identity", () => {
    const html = renderToStaticMarkup(
      <ChannelStrip label="DECK B" identity={semanticColor("deck", 1)} level={level} bottom={null} />,
    );
    expect(html).toContain(`--sem-color:${DECK[1]}`);
  });

  it("each micro-send carries its OWN bus color, not the channel's", () => {
    // The deck strip is deck-colored, but its four micro-sends must each show
    // their FX bus. A naive inherit would paint all four in the deck's color and
    // destroy the very mapping the system exists to show.
    const sends = [0, 1, 2, 3].map((i) => ({
      value: 0.5,
      label: `Deck A master send to FX${i + 1}`,
      onChange: noop,
    }));
    const html = renderToStaticMarkup(
      <ChannelStrip
        label="DECK A"
        identity={semanticColor("deck", 0)}
        level={level}
        sends={sends}
        bottom={null}
      />,
    );
    for (const c of SEND) expect(html).toContain(`--sem-color:${c}`);
    expect(html).toContain(`--sem-color:${DECK[0]}`); // and the strip keeps its own
  });

  it("a channel with no family (INPUT, XFADE) gets no identity at all", () => {
    const html = renderToStaticMarkup(<ChannelStrip label="INPUT" level={level} bottom={null} />);
    expect(html).not.toContain("--sem-color");
    expect(html).not.toContain("sem-fill");
  });
});
