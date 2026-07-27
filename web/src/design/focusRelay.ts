import type { EngineLink } from "../engineLink.ts";
import { isNoteKeyboardActive } from "./keyForward.ts";
import {
  setFocusClaimNotifier,
  setRemoteAdjustRelay,
  useFocusModel,
} from "./focusModel.ts";

/**
 * Cross-webview controls-focus relay (the ö/ä "double-click" fix).
 *
 * Every panel is its own WKWebView with its own FocusModel store, and ö/ä is
 * web-owned — never forwarded to native. So a DragBox single-clicked in the
 * mixer webview lit its ring, but the keystroke kept landing in the deck
 * surface (still first responder), whose store had nothing focused: the key
 * died. Only a second click — which happened to transfer first responder —
 * made ö/ä work.
 *
 * The fix keeps first responder where it is (the grid keeps its web-owned
 * bare arrows) and bridges the focus instead:
 *   - a local claim (setFocus / setCellFocus / clearFocus) is sent to native,
 *     which broadcasts it to every OTHER webview (settingChanged pattern) so
 *     their stores clear or park — one accent ring across ALL webviews;
 *   - ö/ä landing in a parked webview is relayed through native to the owner,
 *     which applies focused.adjust().
 *
 * Musical-keyboard mode wins over the relay: ö/ä are piano notes E/F there
 * (keyForward.ts), so the relay declines and the key falls through untouched.
 */
export function installFocusRelay(link: EngineLink | null): (() => void) | undefined {
  if (!link) return undefined;

  setFocusClaimNotifier((kind) => {
    void link.command("focusRelay", { op: "claim", kind }).catch(() => {});
  });

  setRemoteAdjustRelay((delta, fine) => {
    if (isNoteKeyboardActive()) return false;
    void link.command("focusRelay", { op: "adjust", delta, fine }).catch(() => {});
    return true;
  });

  const offEvent = link.onEvent((evt) => {
    const e = evt as {
      type?: string;
      op?: string;
      kind?: string;
      delta?: number;
      fine?: boolean;
    };
    if (e?.type !== "focusRelay") return;
    const s = useFocusModel.getState();
    if (e.op === "claim") {
      s.applyRemoteClaim(e.kind === "controls" ? "controls" : "grid");
      return;
    }
    if (e.op === "adjust") {
      // Broadcast reaches every webview; only the single one actually holding
      // controls focus applies it (the claim invariant guarantees at most one).
      if (s.lane === "controls" && s.focused) {
        s.focused.adjust(e.delta === -1 ? -1 : 1, e.fine === true);
      }
    }
  });

  return () => {
    setFocusClaimNotifier(null);
    setRemoteAdjustRelay(null);
    offEvent();
  };
}
