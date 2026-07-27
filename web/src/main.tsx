import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTokens, DEFAULT_TOKENS } from "./design/tokens.ts";
import { installCapabilityClasses } from "./design/pointerCapability.ts";
import { installLongPressContextMenu } from "./design/longPress.ts";
import "./design/base.css";

// Failure visibility (migration debugging): a blank panel must never be
// silent. Runtime errors render as readable text instead of a black page.
//
// DEDUPED AND CAPPED, which is not a softening of that rule but the thing that
// makes it survive contact with a repeating fault. The original prepended a
// fresh <pre> per event with no bound: a panel issuing a dozen commands against
// a host that answers none of them prepended a dozen identical blocks, pushed
// its own 100vh layout off the bottom of the window, and looked catastrophically
// broken when the real fault was one missing method. The twelfth copy of a
// message carries no information the first did not — but it does hide the app.
const seen = new Map<string, { el: HTMLElement; n: number }>();
const MAX_DISTINCT = 4;

function showFatal(message: string) {
  const prior = seen.get(message);
  if (prior) {
    // Same fault again: count it in place. A rising count is real information
    // (it says "this is a loop, not a one-off") and costs no layout.
    prior.n += 1;
    prior.el.textContent = `panel error (×${prior.n}):\n${message}`;
    return;
  }
  if (seen.size >= MAX_DISTINCT) return; // past this it is noise burying the UI
  // One fixed container, so the blocks overlay the panel rather than pushing it
  // out of the window (base.css #fatal-errors).
  let host = document.getElementById("fatal-errors");
  if (!host) {
    host = document.createElement("div");
    host.id = "fatal-errors";
    document.body.prepend(host);
  }
  const el = document.createElement("pre");
  el.className = "fatal-error";
  el.textContent = `panel error:\n${message}`;
  host.append(el);
  seen.set(message, { el, n: 1 });
}
window.addEventListener("error", (e) => showFatal(`${e.message}\n${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => showFatal(String(e.reason)));

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre className="fatal-error">
          render error:{"\n"}
          {String(this.state.error?.stack ?? this.state.error)}
        </pre>
      );
    }
    return this.props.children;
  }
}

applyTokens(DEFAULT_TOKENS); // paint with defaults; App merges persisted theme

// The DJ-mixer extension's control surface (extension/ at the repo root) — companion mode only.
// Dynamic import so the mac WKWebView host never loads a byte of it.
const isBrowserHost = new URLSearchParams(window.location.search).get("host") === "browser";
if (isBrowserHost) {
  void import("./companion/companionBridge.ts").then((m) => m.initCompanionBridge());
  // Touch's right-click: a long-press synthesizes `contextmenu` at the touched
  // element, so every existing menu surface works untouched (longPress.ts).
  installLongPressContextMenu();
}

// Mobile scoping classes (host-browser / touch-capable) — stamped before first
// render so every scoped CSS rule is decided by first paint.
installCapabilityClasses(isBrowserHost);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
