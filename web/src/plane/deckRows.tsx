/**
 * THE CLASSIC DECK ROWS (B1 · P7-T1/T2/T3 · STRIP-DECK.md).
 *
 * The donor's deck block, rebuilt on this app's own lanes. Three rows above the
 * expanded tile's grid:
 *
 *   toolbar   OPEN · ■ · ▶ · ▸¹ · » · DBL · SAVE · ⏏
 *   sync      SYNC · pulse ‹› · TR ‹› · TP · WIN · BR + scale + ‹› · REV · nudge
 *   scene     the pads, second rendering · GRID/PERF
 *
 * WHY REBUILT AND NOT MOUNTED (D-SL-DECKFULL-01). `panels/TransportPanel.tsx`
 * carries a fully-ported `DeckBlock` with these exact rows — and every one of
 * its controls speaks `deckSection` / `transportDeck` / `djSetting`, which NO
 * host answers, reading a `toolbar` topic whose fields are spelled-out
 * neutrals. Mounting it would put nine dead controls on screen. The verbs here
 * reach the companion (which owns the document) and `slDeck` (which owns the
 * engine), so every button on these rows does something.
 *
 * WHY THE COLLAPSED FACE KEEPS ITS OWN (D-SL-FACES-01). The pads and SYNC also
 * live on the collapsed strip. These are SECOND RENDERINGS of the same state,
 * not a move: the collapsed strip stays usable on its own, and both faces read
 * and write the one document.
 *
 * Donor reference, read before designing (PARALLEL-PROTOCOL §0):
 *   · `WebToolbarBinding.swift:390-460`  the op list and its laws
 *   · `GlobalToolbarView.swift:131-205`  open/eject/double as the host does them
 *   · `DJModeView.swift:885-921`         ejectDeck / doubleDeck refusals
 *   · `BeatSequencer.swift:3573-3587`    playOnce
 */
import { useEffect, useRef, useState } from 'react'

import { HotFrameLayout } from '../../protocol/schema.ts'
import type { EngineLink } from '../engineLink.ts'
import { nudgeTranspose } from '../audio/deckTransport.ts'
import { applyPitchModeExclusion } from '../audio/deckTransport.ts'
import { useContextMenu, type MenuItem } from '../design/ContextMenu.tsx'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'
import { deckTempoIntent } from '../persist/tempo.ts'
import { updateGridTempo, updateStrip } from '../state/mapStore.ts'
import { setNudge, useNudge } from '../state/nudgeStore.ts'
import { flushAutosave, useCompanion } from '../store/companionEngine.ts'
import { send } from './send.ts'
import { BR_SCALE, brScaleIndex } from './stripOps.ts'

type GridElement = Extract<StripDoc['element'], { kind: 'grid' }>

/** The pulse relations a deck can wear, in the order the ‹ › pair walks them —
    the donor cycles `DJPulseRelation.allCases` the same way
    (WebToolbarBinding.swift:406-413). */
const PULSE: GridElement['pulseRelation'][] = [
  'auto',
  '1:3',
  '1:2',
  '2:3',
  '1:1',
  '3:2',
  '2:1',
  '3:1',
]

export interface DeckRowsProps {
  strip: StripDoc
  element: GridElement
  link: EngineLink | null
  masterBpm: number
  /** Sessions the library offers, for OPEN. */
  sessions?: { name: string }[]
  onLoadSession?: (name: string) => void
  /** ⏏ — drop this session from the strip (the library keeps it). */
  onDropElement?: () => void
  /** The strips DBL may double onto, already filtered to eligible ones by the
      owner (it is the only thing that can see the whole plane). */
  doubleTargets?: { key: string; label: string; deck: number }[]
  onDouble?: (targetDeck: number) => void
  /** PERF/GRID — the tile's own view state, owned by the mount (session
      lifetime by user ruling 2026-07-31; a MAPPERF overlay row persists it). */
  cellsHidden?: boolean
  onToggleCells?: () => void
  performActive?: boolean
  onTogglePerform?: () => void
  /** P3-C2: a compose window owns this deck — ONE PUBLISHER AT A TIME. Every
      verb that would write the document or the transport locks with the reason
      in its title until that window closes. SAVE stays live on purpose:
      flushing a pending write is what you want most while another window is
      editing, and it publishes nothing. */
  locked?: boolean
}

/** The title every locked control wears, so the lock explains itself wherever
    it is met rather than only where it was set. */
const LOCKED_TITLE = 'editing in the compose window ⇱ — close it to change this here'

/**
 * ROW 1 — the toolbar. Load, stop, play, one-shot, skip, double, save, eject.
 *
 * `■` and `▶` are separate buttons rather than one toggle, deliberately: the
 * donor's row has both, and under stage light a button whose meaning depends on
 * a state you have to read first is the wrong shape.
 */
export function DeckToolbarRow({
  strip,
  element,
  link,
  sessions = [],
  onLoadSession,
  onDropElement,
  doubleTargets = [],
  onDouble,
  locked = false,
}: DeckRowsProps) {
  const deck = element.deck
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  const oneShot = useCompanion((c) => c.decks[deck]?.stopAtStep ?? null)
  const hasSession = useCompanion((c) => c.decks[deck]?.session != null)
  const { openMenu } = useContextMenu()

  // WHERE THE PLAYHEAD IS, for skip. `sl_deck_skip_step` takes an ABSOLUTE step
  // (the core's `requestSeek` contract), so "one step forward" has to be
  // computed from the live position — sending a constant 1 would jump to step 1
  // every press, which looks like a rewind and is the easiest thing to get
  // wrong here. Read off the HotFrame into a ref, the LcmBar pattern: a 30 Hz
  // number must never re-render React.
  const stepRef = useRef(-1)
  useEffect(() => {
    if (!link) return
    const idx = (HotFrameLayout as Record<string, number>)[`playheadStepDeck${deck}`]
    if (idx === undefined) return
    return link.onHotFrame((frame) => {
      stepRef.current = frame[idx] ?? -1
    })
  }, [link, deck])

  const openItems: MenuItem[] = sessions.map((s) => ({
    kind: 'item' as const,
    label: s.name,
    onSelect: () => onLoadSession?.(s.name),
  }))
  // THE DOUBLE'S TARGET IS ASKED FOR, not guessed (user ruling 2026-07-31). The
  // donor could hardcode "the other deck" because it had exactly two; the plane
  // has N strips of one kind each (D-SL-MORPH-01), so there is no "other" to
  // mean. An empty list is a DISABLED button with the reason in its title,
  // never a menu that opens onto nothing.
  const doubleItems: MenuItem[] = doubleTargets.map((t) => ({
    kind: 'item' as const,
    label: t.label,
    onSelect: () => onDouble?.(t.deck),
  }))

  return (
    <div className="ds-row strip-row deckrow deckrow-toolbar" data-no-drag>
      <button
        type="button"
        className="dr mono"
        disabled={locked || openItems.length === 0}
        onClick={(e) => openMenu(openItems, e.clientX, e.clientY)}
        title={
          locked
            ? LOCKED_TITLE
            : openItems.length === 0
              ? 'no sessions in the library yet'
              : 'OPEN — load a session into this strip'
        }
      >
        OPEN
      </button>
      <button
        type="button"
        className="dr mono"
        disabled={locked || !hasSession}
        onClick={() => useCompanion.getState().stop(deck)}
        title={locked ? LOCKED_TITLE : 'stop this deck'}
      >
        ■
      </button>
      <button
        type="button"
        className={`dr mono${playing && oneShot === null ? ' latched' : ''}`}
        disabled={locked || !hasSession}
        onClick={() => useCompanion.getState().play(deck)}
        title={locked ? LOCKED_TITLE : 'play this deck (from the top)'}
      >
        ▶
      </button>
      <button
        type="button"
        className={`dr mono${oneShot !== null ? ' latched' : ''}`}
        disabled={locked || !hasSession}
        onClick={() => useCompanion.getState().playOnce(deck)}
        title={
          // The two cases are genuinely different and the title says which one
          // this press will be — the donor's playOnce branches on isPlaying.
          locked
            ? LOCKED_TITLE
            : playing
            ? 'ONE-SHOT — let the cycle in flight finish, then stop'
            : 'ONE-SHOT — play one full pattern cycle, then stop'
        }
      >
        ▸¹
      </button>
      <button
        type="button"
        className="dr mono"
        disabled={locked || !hasSession}
        // ONE STEP PER PRESS (user ruling 2026-07-31, the donor's behaviour).
        // The engine applies it at the next STEP BOUNDARY — a jump landing
        // wherever the message thread finished would never be twice the same.
        // With no playhead yet (stopped, or no HotFrame on this host) the press
        // seeks to step 0 rather than to -1, which the engine would refuse.
        onClick={() =>
          send(link, 'slDeck', {
            action: 'skipStep',
            deck,
            step: Math.max(0, stepRef.current + 1),
          })
        }
        title="skip — nudge the playhead one step forward at the next boundary"
      >
        »
      </button>
      <button
        type="button"
        className="dr mono"
        disabled={locked || !hasSession || doubleItems.length === 0}
        onClick={(e) => openMenu(doubleItems, e.clientX, e.clientY)}
        title={
          locked
            ? LOCKED_TITLE
            : !hasSession
            ? 'nothing loaded to double'
            : doubleItems.length === 0
              ? 'DBL needs a free grid strip to double onto'
              : 'DBL — clone this session onto another strip, to mix it against itself'
        }
      >
        DBL
      </button>
      <button
        type="button"
        className="dr mono"
        onClick={() => void flushAutosave()}
        title="save now — edits autosave; this flushes the pending write immediately"
      >
        SAVE
      </button>
      <button
        type="button"
        className="dr mono"
        disabled={locked || !onDropElement}
        onClick={() => onDropElement?.()}
        title={
          locked ? LOCKED_TITLE : 'eject — drop this session from the strip (the library keeps it)'
        }
      >
        ⏏
      </button>
      <span className="dr-name mono" title={strip.name}>
        {strip.name}
      </span>
    </div>
  )
}

/**
 * ROW 2 — SYNC · pulse · TR · TP · WIN · BR · REV · nudge.
 *
 * Everything here is a live hand control: you change it one-handed with sound
 * running and hear the answer. That is the same test `GridControls` applies to
 * decide what sits on the object rather than in the Inspector — the difference
 * is that the tile HAS room, so the pulse relation and transpose get their pair
 * of arrows here instead of a labelled field.
 */
export function DeckSyncRow({ strip, element, link, masterBpm, locked = false }: DeckRowsProps) {
  const deck = element.deck
  const intent = deckTempoIntent(element, masterBpm, 0)
  const br = useCompanion((c) => c.decks[deck]?.beatRepeat ?? null)
  const rev = useCompanion((c) => c.decks[deck]?.reverse ?? false)
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  const nudge = useNudge((s) => s.deltas[deck] ?? 0)
  const [brIdx, setBrIdx] = useState(3)
  // WIN is LIVE, not a document field: it is the grain character you ride
  // during a set, and the engine holds it as a realtime atomic
  // (`setDeckBusTexture`). Persisting it would need a second schema bump in one
  // step for a value nobody sets once and lives with.
  const [texture, setTexture] = useState(0)

  const latchedIdx = brScaleIndex(br)
  const brLabel = BR_SCALE[br && latchedIdx >= 0 ? latchedIdx : brIdx]?.label ?? '2'
  const trOn = element.transpose !== 0

  /** Write the sync/transpose pair through the donor's exclusion, then push. */
  const setPair = (next: { syncEnabled: boolean; transposeEnabled: boolean }, changed: 'sync' | 'transpose') => {
    const r = applyPitchModeExclusion(next, element.pitchMode, changed)
    updateGridTempo(strip.key, link, {
      syncToMaster: r.syncEnabled,
      // Disengaging TR parks the semitones at 0 — the lamp IS `transpose !== 0`
      // in this model, so there is no separate bool that could disagree with it.
      ...(r.transposeEnabled ? {} : { transpose: 0 }),
    })
  }

  return (
    <div className="ds-row strip-row deckrow deckrow-sync" data-no-drag>
      <button
        type="button"
        className={`dr mono${element.syncToMaster ? ' latched' : ''}`}
        disabled={locked}
        onClick={() => setPair({ syncEnabled: !element.syncToMaster, transposeEnabled: trOn }, 'sync')}
        title={
          locked
            ? LOCKED_TITLE
            : element.syncToMaster
            ? `synced at ${intent.pulse} — running at ${intent.syncedBpm?.toFixed(1) ?? '—'} BPM`
            : 'free — this deck runs at its own tempo'
        }
      >
        {element.syncToMaster ? 'SYNC' : 'FREE'}
      </button>
      {/* PULSE — cycling it turns SYNC ON, which is the donor's law
          (`cyclePulse` calls `setSync(true)`, WebToolbarBinding.swift:406-413).
          Choosing a musical relation IS asking to be synced; leaving the deck
          free afterwards would make the control look broken. */}
      {([-1, 1] as const).map((dir) => (
        <button
          key={dir}
          type="button"
          className="dr mono"
          disabled={locked}
          onClick={() => {
            const i = PULSE.indexOf(element.pulseRelation)
            const next = PULSE[((i + dir) % PULSE.length + PULSE.length) % PULSE.length]!
            updateGridTempo(strip.key, link, { pulseRelation: next, syncToMaster: true })
          }}
          title={locked ? LOCKED_TITLE : `pulse relation — ${dir < 0 ? 'previous' : 'next'} (engages SYNC)`}
        >
          {dir < 0 ? '‹' : '›'}
        </button>
      ))}
      <span className="dr-read mono" title="the musical relation this deck keeps to the master">
        {element.pulseRelation}
      </span>

      <button
        type="button"
        className={`dr mono${trOn ? ' latched' : ''}`}
        disabled={locked}
        onClick={() =>
          setPair({ syncEnabled: element.syncToMaster, transposeEnabled: !trOn }, 'transpose')
        }
        title={
          locked
            ? LOCKED_TITLE
            : trOn
            ? `TR — transposed ${element.transpose > 0 ? '+' : ''}${element.transpose} st; press to return to concert pitch`
            : 'TR — engage transpose (the ‹ › pair moves it)'
        }
      >
        TR
      </button>
      {([-1, 1] as const).map((d) => (
        <button
          key={d}
          type="button"
          className="dr mono"
          disabled={locked}
          onClick={() => {
            const semis = nudgeTranspose(element.transpose, d)
            setPair({ syncEnabled: element.syncToMaster, transposeEnabled: semis !== 0 }, 'transpose')
            updateGridTempo(strip.key, link, { transpose: semis })
          }}
          title={locked ? LOCKED_TITLE : `transpose ${d > 0 ? 'up' : 'down'} a semitone (±12 max)`}
        >
          {d < 0 ? '‹' : '›'}
        </button>
      ))}
      <span className="dr-read mono" title="semitones on this deck's stretch bus">
        {element.transpose > 0 ? `+${element.transpose}` : element.transpose}
      </span>

      {/* TP — the donor's pitch mode, per strip. With it lit, SYNC and TR
          exclude each other; with it dark both may run, which is what every map
          before v9 did. */}
      <button
        type="button"
        className={`dr mono${element.pitchMode ? ' latched' : ''}`}
        disabled={locked}
        onClick={() =>
          updateStrip(strip.key, (s) =>
            s.element.kind === 'grid'
              ? { ...s, element: { ...s.element, pitchMode: !s.element.pitchMode } }
              : s,
          )
        }
        title={
          locked
            ? LOCKED_TITLE
            : element.pitchMode
              ? 'TP mode ON — SYNC and TR exclude each other on this strip'
              : 'TP mode off — SYNC and TR may both run'
        }
      >
        TP
      </button>

      {/* WIN — the donor's window texture, straight down the param lane. */}
      <label className="dr-win mono" title="WIN — stretch grain: tight at 0, smeared at 1">
        WIN
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={texture}
          aria-label="window texture"
          disabled={locked}
          onChange={(e) => {
            const v = Number(e.target.value)
            setTexture(v)
            send(link, 'slDeck', { action: 'setTexture', deck, value: v })
          }}
        />
      </label>

      <button
        type="button"
        className={`dr mono${br ? ' latched' : ''}`}
        disabled={locked}
        onClick={() => {
          const sc = BR_SCALE[brIdx] ?? BR_SCALE[3]!
          useCompanion
            .getState()
            .setBeatRepeat(
              deck,
              br ? null : { startStep: 0, length: sc.length, subdivision: sc.subdivision },
            )
        }}
        title={locked ? LOCKED_TITLE : br ? 'release the beat repeat' : 'BR — loop the window on this deck'}
      >
        BR
      </button>
      <button
        type="button"
        className="dr mono"
        disabled={locked}
        onClick={() => {
          const cur = br && latchedIdx >= 0 ? latchedIdx : brIdx
          const next = (cur + 1) % BR_SCALE.length
          setBrIdx(next)
          if (br) {
            const sc = BR_SCALE[next]!
            useCompanion
              .getState()
              .setBeatRepeat(deck, { startStep: 0, length: sc.length, subdivision: sc.subdivision })
          }
        }}
        title="beat-repeat length — 16…2 whole steps, then 1/2…1/32 rolls (live while latched)"
      >
        {brLabel}
      </button>
      {/* BR SHIFT — walks the latched window. Disabled rather than hidden when
          nothing is latched: the donor's own guards make it a no-op, and a
          control that vanishes moves everything beside it. */}
      {([-1, 1] as const).map((d) => (
        <button
          key={d}
          type="button"
          className="dr mono dr-brshift"
          disabled={locked || !br || !playing}
          onClick={() => useCompanion.getState().shiftBeatRepeat(deck, d)}
          title={
            !br
              ? 'latch BR first — then this walks the window'
              : !playing
                ? 'the window walks while the deck is playing'
                : `shift the repeat window ${d < 0 ? 'left' : 'right'} one slot`
          }
        >
          {d < 0 ? '«' : '»'}
        </button>
      ))}

      <button
        type="button"
        className={`dr mono${rev ? ' latched' : ''}`}
        disabled={locked}
        onClick={() => useCompanion.getState().setReverse(deck, !rev)}
        title={
          locked
            ? LOCKED_TITLE
            : rev
              ? 'play forward again'
              : 'REV — this session backwards, true tape reverse'
        }
      >
        REV
      </button>
      {/* NUDGE — hold to bend, release to snap back. Never the document. */}
      {(['‹', '›'] as const).map((glyph) => {
        const delta = glyph === '‹' ? -4 : 4
        return (
          <button
            key={glyph}
            type="button"
            className={`dr mono${nudge === delta ? ' latched' : ''}`}
            disabled={locked || !element.syncToMaster}
            onPointerDown={() => setNudge(link, deck, delta)}
            onPointerUp={() => setNudge(link, deck, 0)}
            onPointerLeave={() => setNudge(link, deck, 0)}
            onPointerCancel={() => setNudge(link, deck, 0)}
            title={
              element.syncToMaster
                ? `nudge — hold to bend ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} BPM, snaps back on release`
                : 'nudge bends the SYNCED tempo — turn SYNC on first'
            }
          >
            {glyph}
          </button>
        )
      })}
    </div>
  )
}

/**
 * ROW 3 — the view switches.
 *
 * ⚠️ SCOPED, AND THE SCOPE IS THE POINT. P7-T3 asks for S·R·CU·SCN·MUTE beside
 * the pads. Every one of those is a SCENE verb — switch mode, pin latch, mute
 * group — and they reach `patternScene` / `sceneOverride`, which no host
 * answers: `scenesStore` subscribes to a `scenes/<d>` topic nothing publishes.
 * Building them here would put five dead controls on a live row, which is the
 * defect the four rules exist for. They are B2's, with the binding behind them.
 *
 * What IS live is the pair below, so that is what ships.
 */
export function DeckViewRow({
  cellsHidden = false,
  onToggleCells,
  performActive = false,
  onTogglePerform,
}: DeckRowsProps) {
  return (
    <div className="ds-row strip-row deckrow deckrow-view" data-no-drag>
      <button
        type="button"
        className={`dr mono${cellsHidden ? ' latched' : ''}`}
        disabled={!onToggleCells}
        onClick={() => onToggleCells?.()}
        title={
          cellsHidden
            ? 'GRID — show the cells again'
            : 'GRID — hide the cells, leaving the controls (the donor’s deck-row collapse)'
        }
      >
        GRID
      </button>
      <button
        type="button"
        className={`dr mono${performActive ? ' latched' : ''}`}
        disabled={!onTogglePerform}
        onClick={() => onTogglePerform?.()}
        title={
          performActive
            ? 'PERF — back to editing; drags select cells again'
            : 'PERF — perform mode: drag a track to set its locator window live'
        }
      >
        PERF
      </button>
      <span className="dr-note mono">
        scene switch modes · pin · mute arrive with the scene binding
      </span>
    </div>
  )
}
