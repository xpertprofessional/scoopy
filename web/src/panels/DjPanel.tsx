import { useEffect, useMemo, useState } from "react";
import {
  COMMANDS,
  DjBrowserState,
  DjUiState,
  ToolbarUiState,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { BrowserShell, BrowserRow } from "../design/BrowserShell.tsx";
import { claimKey } from "../design/keyForward.ts";
import { semanticColor } from "../design/tokens.ts";
import { GridPanel, djSource } from "./GridPanel.tsx";
import { deckInSlot, type Slot } from "./djProjection.ts";
import { WaitingForState } from "./WaitingForState.tsx";
import "./djmode.css";

/**
 * DJ view (P6-03, panels/djmode.md).
 *
 * TWO structural decisions, both from the P6-00 audit + the user's CONFIRMs:
 *
 * 1. **Reuse, don't fork** (§8 Q1). The deck strip IS the compose track row at
 *    a different density — native itself calls the DJ row "DJDeckTrackColumn's
 *    controls laid out horizontally". So each deck mounts the SAME <GridPanel>
 *    with a deck-scoped `djSource(deck)` at `density: "dj"`. Every future row
 *    fix lands on both surfaces; there is no second row implementation to
 *    keep in sync.
 *
 * 2. **Deck C PROJECTS into a slot** (§8 Q3) — it takes over slot A or B and
 *    there is never a third column. REVISED 2026-07-14: the projection was
 *    view-local here (mirroring native's @State), but its flip button moved to
 *    the TRANSPORT strip — a different WKWebView — so DJModeManager owns it now
 *    and this panel just READS `dj.deckCProjectedSlot`. Same for the GRID
 *    collapse (`dj.gridHidden`). The deck header that carried both buttons is
 *    deleted; the transport deck box, column-aligned directly above each slot,
 *    is their single home (djmode.md §4C).
 *
 * ⚠️ Workflow law (user, 2026-07-12): **X·MIX is the crossfader** and the
 * **sync system answers all BPM questions**. The classic constant-power blend
 * and crossfader-driven tempo blending ("smart BPM") are workflow-dead — this
 * surface deliberately exposes neither. The Swift laws still support them (and
 * the P6-01 fixtures still guard them as engine truth); they simply get no UI.
 */

const DECK_LABELS = ["A", "B", "C"] as const;

// The xfader-side picker is GONE entirely (mixer overhaul): sides are fixed
// policy — A→a, B→b, rest own (DJModeManager.init) — until the X-MIX matrix.

export function DjPanel({ link }: { link: EngineLink | null }) {
  const [dj, setDj] = useState<DjUiState | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarUiState | null>(null);
  // The session-browser fold. Lifted OUT of SessionBrowser so ⌘B can reach it:
  // native yields the shortcut to whichever webview holds first-responder (the
  // DJ deck surface, here), so the toggle has to live where a key handler can
  // see it — the panel root — not buried in the rail component. Native's own
  // ⌘B path in DJ toggles a dead @State (`showSessionBrowser` is suppressed
  // under the web surface), which is why the shortcut did nothing before.
  const [browserOpen, setBrowserOpen] = useState(false);

  // ⌘B — the compose sample browser's fold shortcut, brought to the DJ session
  // browser. We CLAIM it (keyForward) so the root relay does not also forward it
  // to native, where it would toggle the suppressed native rail instead. The
  // grid does not own ⌘B, so there is nothing to collide with.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        !e.ctrlKey &&
        (e.code === "KeyB" || e.key.toLowerCase() === "b")
      ) {
        setBrowserOpen((v) => !v);
        claimKey(e);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!link) return;
    const offs = [
      link.onUiState("dj", (raw) => {
        const parsed = DjUiState.safeParse(raw);
        if (!parsed.success) {
          console.error("dj rejected:", parsed.error.issues, raw);
          return;
        }
        setDj(parsed.data);
      }),
      link.onUiState("toolbar", (raw) => {
        const parsed = ToolbarUiState.safeParse(raw);
        if (parsed.success) setToolbar(parsed.data);
      }),
    ];
    link.command("getUiState", { topic: "dj" }).catch(() => {});
    link.command("getUiState", { topic: "toolbar" }).catch(() => {});
    return () => offs.forEach((off) => off());
  }, [link]);

  const deckCEnabled = toolbar?.deckCEnabled ?? false;

  if (!dj || !toolbar) {
    return (
      <WaitingForState
        topics={[...(dj ? [] : ["dj"]), ...(toolbar ? [] : ["toolbar"])]}
        className="dj mono dim"
      />
    );
  }

  // The projection + GRID collapse are READ here, written from the transport
  // strip's deck boxes (their single home since 2026-07-14). The owner
  // (DJModeManager) enforces the deck-C-disabled fallback, so no effect here.
  const projection: Slot | null =
    dj.deckCProjectedSlot === "a" || dj.deckCProjectedSlot === "b"
      ? dj.deckCProjectedSlot
      : null;

  const slot = (s: Slot) => {
    const deck = deckInSlot(s, projection, deckCEnabled);
    return (
      <DeckSlot
        deck={deck}
        link={link}
        dj={dj}
        // Column position drives the one-ring L→R cross-deck navigation: "a" is
        // the left slot, "b" the right. Slot — not deck — because deck C projects
        // into whichever slot, so its column is the slot it lands in.
        slotIndex={s === "a" ? 0 : 1}
        // Keyed by DECK, not by slot: hiding deck C's grid must follow C when
        // it projects into the other slot, not stay behind with the slot.
        gridHidden={dj.gridHidden[deck] ?? false}
      />
    );
  };

  return (
    <main className="dj">
      <div className="dj-decks">
        {slot("a")}
        {slot("b")}
        {/* Overlay, not a flex sibling: an in-flow rail steals width from the
            deck columns and breaks their 1:1 alignment with the transport deck
            boxes above. Native does the same (.overlay(alignment: .trailing)). */}
        <div className="dj-sessions-overlay">
          <SessionBrowser
            link={link}
            deckCEnabled={deckCEnabled}
            expanded={browserOpen}
            onExpandedChange={setBrowserOpen}
          />
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// One deck slot: the deck's track strip (the compose grid at DJ density — see
// the module doc). The header row is GONE (2026-07-14): the letter badge's job
// went to the identity-colored transport box aligned directly above, and its
// GRID + C buttons moved into that box (djmode.md §4C — one control, one home).
// ---------------------------------------------------------------------------

function DeckSlot({
  deck,
  link,
  dj,
  gridHidden,
  slotIndex,
}: {
  deck: number;
  link: EngineLink | null;
  dj: DjUiState;
  gridHidden: boolean;
  /** 0 = left column, 1 = right column — for cross-deck ring navigation. */
  slotIndex: number;
}) {
  const active = dj.activeDeckIndex === deck;
  const label = DECK_LABELS[deck];
  // STABLE identity: GridPanel keys its topic subscriptions off `source`, so a
  // fresh object each render would tear down and re-subscribe all 17 topics
  // every frame. Re-created only when the slot's deck actually changes (i.e.
  // deck C projecting in or out).
  const source = useMemo(() => djSource(deck), [deck]);

  return (
    <section
      className={`dj-deck sem${active ? " active" : ""}`}
      style={{ "--sem-color": semanticColor("deck", deck) } as React.CSSProperties}
      aria-label={`Deck ${label}`}
    >
      {/* THE deck strip: the same grid + fat row the compose view uses, at DJ
          density, scoped to this deck's topics + edit target. */}
      <div className={`dj-deck-grid${gridHidden ? " cells-hidden" : ""}`}>
        <GridPanel link={link} source={source} cellsHidden={gridHidden} djSlotIndex={slotIndex} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Session browser (P6-04) — foldable rail, spec'd from the LIVE
// CollapsibleBrowserPanel (FileBrowserView.swift:733), NOT the dead
// DJSessionBrowser.swift. Preload is Swift's (background JSON parse so a deck
// swap is instant mid-set); this renders its progress and sends load intents.
// ---------------------------------------------------------------------------

function SessionBrowser({
  link,
  deckCEnabled,
  expanded,
  onExpandedChange,
}: {
  link: EngineLink | null;
  deckCEnabled: boolean;
  // Fold state is owned by DjPanel (so ⌘B can reach it — see the panel root),
  // not view-local here as it was before.
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
}) {
  const [state, setState] = useState<DjBrowserState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Select-then-load (native sessionDeckStrip's model, restored 2026-07-16):
  // the per-row A/B/C buttons sat at the list's right edge, exactly under the
  // overlay scrollbar, and were unclickable while the list scrolled. View-local
  // on purpose — DjBrowserState has no selection and Swift never needed one.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("djBrowser", (raw) => {
      const parsed = DjBrowserState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "djBrowser" }).catch(() => {});
    return off;
  }, [link]);

  // The notice is transient (native shows a 1.8 s toast).
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 1800);
    return () => clearTimeout(t);
  }, [notice]);

  const browse = (op: string, extra: Record<string, unknown> = {}) =>
    link
      ?.command("djBrowser", { op, ...extra })
      .then((raw) => {
        const res = COMMANDS.djBrowser.result.safeParse(raw);
        if (res.success && res.data.notice) setNotice(res.data.notice);
      })
      .catch((err) => console.error("djBrowser failed:", err));

  const decks: { deck: number; label: string }[] = [
    { deck: 0, label: "A" },
    { deck: 1, label: "B" },
    ...(deckCEnabled ? [{ deck: 2, label: "C" }] : []),
  ];

  // A refresh/folder change can remove the selected session from the list; a
  // stale path must not stay armed on the deck buttons.
  const selected =
    selectedPath && (state?.sessions ?? []).some((s) => s.path === selectedPath)
      ? selectedPath
      : null;

  // BR-5: the chrome is now the SHARED BrowserShell — the same rail, header,
  // list frame and footer the compose sample browser uses. Natively these two
  // browsers were literally one view behind a `BrowserMode` enum, so letting
  // them drift into two hand-styled rails would have been a regression. Every
  // P6-04 BEHAVIOUR is unchanged: the load is still an intent onto Swift's own
  // loadSession, the refusal notice still comes back over the wire, and preload
  // progress still renders.
  return (
    <BrowserShell
      title="SESSIONS"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      railTitle="Sessions (⌘B)"
      actions={
        <>
          <button onClick={() => browse("chooseFolder")} title="Choose a playlist folder">
            ⌘
          </button>
          <button onClick={() => browse("refresh")} title="Re-scan the folder">
            ↻
          </button>
        </>
      }
      banner={
        <>
          {/* Preload progress: a set-critical signal — a not-yet-preloaded
              session still loads, just not instantly. */}
          {state?.isLoading && (
            <div className="br-progress" role="progressbar">
              <span style={{ width: `${Math.round(state.progress * 100)}%` }} />
            </div>
          )}
          {state?.error && <p className="br-error mono">{state.error}</p>}
          {notice && <p className="br-notice mono">{notice}</p>}
        </>
      }
      // The universal deck strip — native's sessionDeckStrip, relocated to the
      // pinned footer where the scrollbar can never cover it. The buttons are
      // the session window's only deck cue — they wear the deck identity color,
      // so "which deck am I loading this into" is answered without reading the
      // letter. Disabled until a row is selected, same as native.
      footer={
        <div className="dj-deck-strip">
          {decks.map(({ deck, label }) => (
            <button
              key={deck}
              className="dj-deck-load mono sem sem-edge"
              style={{ "--sem-color": semanticColor("deck", deck) } as React.CSSProperties}
              disabled={!selected}
              title={
                selected ? `Load selected session into deck ${label}` : "Select a session first"
              }
              onClick={() => selected && browse("load", { path: selected, deck })}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <ul className="br-list">
        {(state?.sessions ?? []).map((s) => (
          <BrowserRow
            key={s.path}
            name={s.name}
            // A preloaded session swaps INSTANTLY (its pattern/kit JSON is
            // already parsed), so the glyph is the one thing a DJ mid-set needs
            // to read at a glance: ● ready, ○ still parsing.
            icon={s.preloaded ? "●" : "○"}
            dim={!s.preloaded}
            title={s.path}
            selected={s.path === selected}
            onClick={() => setSelectedPath(s.path)}
          />
        ))}
        {state && state.sessions.length === 0 && !state.isLoading && (
          <li className="br-empty mono">
            {state.folder ? "no sessions in folder" : "choose a folder"}
          </li>
        )}
      </ul>
    </BrowserShell>
  );
}

// The X·MIX BAR WAS HERE. Deleted in P6-09: the crossfader (position + ENGAGE)
// already existed as a mixer channel strip (MIX-R4), and this bar was a second
// copy of it. X·MIX *is* the crossfader, so its character controls (CARVE ·
// FULLER · SHIMMER · AMT) moved onto that strip too (P6-10) — one fader, one
// home, and the mixer row is visible above BOTH views, so the DJ view loses
// nothing. Master tempo / tempo mode / launch quantize left with it: they are
// global, and they live once in the DJ master box (djmode.md §4C).
