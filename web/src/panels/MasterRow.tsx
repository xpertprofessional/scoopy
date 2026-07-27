import type { GridMetaState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, GeoRange } from "../design/controls.tsx";
import { DragBox } from "../design/DragBox.tsx";
import { semanticColor } from "../design/tokens.ts";
import { ModStrip } from "./ModStrip.tsx";
import "./masterrow.css";

/** BeatSequencer.maxAudioTrackCount — and the grid's own ceiling (kMaxGridTracks). */
const MAX_TRACKS = 16;

/**
 * MASTER TRACK ROW (P6-08) — the per-deck row above the track list, mounted in
 * BOTH views (compose grid and every DJ deck). Native `MasterTrackRowView`.
 *
 *   BPM │ VOL │ DRV │ S1…S4
 *
 * The row IS the deck's master track (mixer overhaul, 2026-07-14): the deck's
 * MASTER sends to the FX buses live here as regular horizontal sends — they
 * replaced the mixer strips' vertical micro-faders, which were the one control
 * in the app that didn't use the slider+box language. DRV renders on every deck
 * and reaches DSP on every deck: each deck drives its own signal pre-sum (the
 * summed mix runs a separate safety clipper).
 *
 * The pattern-scene cluster is NOT here (user, 2026-07-13): snapshot switching
 * is a TRANSPORT act — it schedules against the pattern boundary, exactly like
 * launching a deck — so its one home is the deck's transport box, where it now
 * occupies a full row of regular-size buttons (djmode.md §4C).
 *
 * The row is per-SEQUENCER, so its state rides that sequencer's grid-meta topic
 * (`gridMeta` in compose, `djMeta/<d>` per DJ deck) — one payload describing one
 * sequencer, rather than a parallel topic that could disagree with it. The sends
 * are the one exception in ORIGIN (MixerConsole is their owner, and the deck
 * index for the write comes from `meta.deckIndex`), but they still ride the same
 * topic so the row cannot disagree with itself.
 *
 * BPM here is the SESSION tempo this deck plays at — not the DJ master tempo
 * (that lives once, in the DJ master box). When the sync system has locked the
 * deck, native strikes the session BPM through and prints the resolved tempo
 * beside it; we do the same, because "what is this deck actually running at"
 * is the question the row exists to answer.
 *
 * `+` (compose only) is the row's one topology control — the app had NO
 * reachable add-track button once the web grid replaced TrackListView (the
 * SwiftUI `+` lived in `BottomControlsView`, which is dead code, and in
 * `DeckMasterControls`, which dropped it). It adds ONE empty track: post-UT
 * MIDI is a destination, not a track type, so there is nothing to choose.
 * It stays out of the DJ deck rows (user, 2026-07-13) — adding a track is a
 * composition act, and the deck rows are a performance surface.
 */
export function MasterRow({
  link,
  meta,
  deck,
  showMod,
  showAdd,
}: {
  link: EngineLink | null;
  meta: GridMetaState;
  /** DJ deck index; undefined = the compose grid's sequencer. */
  deck?: number;
  /** The M1–M4 mod strip is compose-only (DJ decks never rendered it). */
  showMod: boolean;
  /** `+` is compose-only — track topology is not a live-performance act. */
  showAdd: boolean;
}) {
  // Deck scope, folded into every write — same contract as gridEdit.deck.
  const scope = deck === undefined ? undefined : deck;
  const write = (p: "sessionBpm" | "sessionMasterVolume" | "sessionMasterDrive", v: number) =>
    link?.paramWrite(p, v, scope);

  const synced = meta.syncedBpm;
  /** Focus-id scope: the compose row and each DJ deck's row must not collide. */
  const idScope = deck ?? 0;

  return (
    <>
    <section className="master-row" aria-label="Master track row">
      <label className="mr-field" title="Session tempo of THIS deck (the DJ master tempo lives in the toolbar)">
        <span className="mono dim">BPM</span>
        <span className={synced !== null ? "mr-struck" : undefined}>
          <DragBox
            id={`master/${idScope}/bpm`}
            value={meta.bpm}
            display={meta.bpm.toFixed(2)}
            min={20}
            max={200}
            step={1}
            defaultValue={120}
            learn={{ kind: "singleton", learnId: "master_bpm" }}
            scenePin={{ key: "bpm", deck }}
            onChange={(v) => write("sessionBpm", v)}
          />
        </span>
        {/* Locked by the sync system → the session tempo is not what you hear. */}
        {synced !== null && <span className="mr-synced mono">{synced.toFixed(2)}</span>}
      </label>

      <label className="mr-field" title="Master volume — above 100 drives the master clipper (double-click resets to 80)">
        <span className="mono dim">VOL</span>
        <DragBox
          id={`master/${idScope}/vol`}
          value={meta.masterVolume}
          display={String(Math.round(meta.masterVolume * 100))}
          min={0}
          max={2}
          step={0.01}
          defaultValue={0.8}
          learn={{ kind: "singleton", learnId: "master_volume" }}
          scenePin={{ key: "masterVolume", deck }}
          onChange={(v) => write("sessionMasterVolume", v)}
        />
      </label>

      {/* DRV on every deck. Each deck drives its own signal PRE-sum (in-main decks
          drive before the crossfader; dedicated-out decks on their own lane), and
          the summed mix runs a separate safety clipper — so a deck's DRV always
          reaches DSP now, no inert case. */}
      <label className="mr-field" title="Master clipper drive">
        <span className="mono dim">DRV</span>
        <DragBox
          id={`master/${idScope}/drv`}
          value={meta.masterDrive}
          display={meta.masterDrive.toFixed(2)}
          min={1}
          max={32}
          step={0.1}
          defaultValue={1}
          learn={{ kind: "singleton", learnId: "master_drive" }}
          scenePin={{ key: "masterClipperDrive", deck }}
          onChange={(v) => write("sessionMasterDrive", v)}
        />
      </label>

      {/* THE DECK'S MASTER SENDS (mixer overhaul) — deck full output → FX bus,
          pre-fader/pre-mute (MIX-NATIVE-1). Each wears the send identity color:
          S3 here, every track's S3 slider and the mixer's FX3 return are one
          signal path. The write is deck-scoped by META (the resolved deck), not
          the mount prop — in compose the row shows whichever deck is being
          edited. */}
      {meta.deckIndex !== null &&
        meta.masterSends.map((v, b) => (
          <label
            key={b}
            className="mr-field mr-send sem sem-fill"
            style={{ "--sem-color": semanticColor("send", b) } as React.CSSProperties}
            title={`Deck master send to FX${b + 1} (pre-fader)`}
          >
            <span className="mono dim">S{b + 1}</span>
            <GeoRange
              label={`S${b + 1}`}
              value={v}
              min={0}
              max={1}
              step={0.01}
              onChange={(v2) => link?.paramWrite("deckMasterSend", v2, meta.deckIndex!, b + 1)}
            />
          </label>
        ))}

      {showAdd && (
        <span className="mr-add">
          <Button
            label="+"
            disabled={meta.trackCount >= MAX_TRACKS}
            title={
              meta.trackCount >= MAX_TRACKS
                ? `Track limit reached (${MAX_TRACKS})`
                : "Add a track to this session (⌘T)"
            }
            onClick={() => {
              // Fire-and-forget: the new row arrives on the grid/<i> push, not
              // in this promise. A refusal (the cap) rejects — nothing to undo.
              link?.command("addTrack", deck === undefined ? {} : { deck }).catch(() => {});
            }}
          />
        </span>
      )}
    </section>
    {/* MOD-6: the M1–M4 strip lives BELOW the master row — native's rows 2 & 3
        (MasterTrackRowView:188-209), collapsed from a two-row wall of drag boxes into four
        live shape lanes. Compose only: the native strip is gated on `showModulationSystem`
        and DJ decks never rendered it. */}
    {showMod && <ModStrip link={link} />}
    </>
  );
}
