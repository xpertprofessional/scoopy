/**
 * SCOOPY STUDIO — the app's main window (S1 · D-SL-STUDIO-01).
 *
 * The standalone product is the original's COMPOSE VIEW, expanded, with no DJ
 * mode and therefore ONE engine. This face is what `WizardMerged` opens; there
 * is no launch chooser any more, and the plane is frozen behind `?panel=plane`.
 *
 * WHAT MAKES IT DIFFERENT FROM `ComposeWindow`, which it otherwise resembles:
 *
 *   IT IS NOT ADDRESSED. The compose window exists because a strip on the plane
 *   spawned it, so it decodes `__slPanelArg` and opens THAT deck's session.
 *   Studio is where the app STARTS — nobody addressed it, and deck 0 is not a
 *   choice it makes but the only deck there is. So the arg is not read at all
 *   rather than read and defaulted: an address this face could receive but not
 *   honour would be a lie in the type.
 *
 *   IT MOUNTS `STUDIO_SOURCE`. The compose lanes the plain compose grid reads
 *   are never written by the merged engine, so `ComposeWindow` shows a frozen
 *   playhead in this host today. `STUDIO_SOURCE` keeps the compose document and
 *   moves only the three telemetry indices onto deck 0's block, which IS written
 *   every audio block. See its header in `panels/GridPanel.tsx` — the reasoning
 *   is the single-engine ruling expressed as three array indices, and it is the
 *   one thing about this face that would be silently wrong if copied carelessly.
 *
 * EMPTY IS A DOOR, not a dead end — the rule `PluginDeckPanel` had to learn in a
 * DAW. An empty studio SAYS it is empty and puts `session ▾` (new · open ·
 * import) beside the words, rather than manufacturing an `Untitled` folder in
 * the user's library on every launch. Restoring the last session is S7's job,
 * with recents; until then the menu is the door and it is one click.
 */
import { useEffect, useState } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { TapeRow } from '../blocks/TapeRow.tsx'
import { GridPanel, STUDIO_SOURCE } from '../panels/GridPanel.tsx'
import { useCompanion } from '../store/companionEngine.ts'
import { silenceNote } from '../store/sampleReport.ts'
import { juceBackend } from '../../protocol/juceLink.ts'
import { autoStartEngine } from '../plane/bootEngine.ts'
import { ComposeFiles } from '../plane/ComposeFiles.tsx'
import { ComposeSessions } from '../plane/ComposeSessions.tsx'
import { useComposeBinding } from '../plane/useComposeBinding.ts'
import { useComposeLifecycle } from '../plane/useComposeLifecycle.ts'
import { Transport } from './Transport.tsx'
import { MASTER_TEMPO, MASTER_TEMPO_KEY, MasterBar } from './MasterBar.tsx'
import { installStudioMap } from './studioMap.ts'
import { asNumber, useSetting } from '../useSetting.ts'
import '../plane/plane.css'

/** One engine, one deck. Not a default — the only deck there is (see header). */
const DECK = 0

export function StudioPanel({ link }: { link: EngineLink | null }) {
  /** The face's ONE error surface, like the compose window's and the plane's. */
  const [note, setNote] = useState<string | null>(null)
  /** Whether the S8 tape row is showing. See the dock's comment below. */
  const [tapeOpen, setTapeOpen] = useState(false)
  const error = useCompanion((c) => c.error)
  const notice = useCompanion((c) => c.notice)
  const engine = useCompanion((c) => c.engine)
  const decodeFailures = useCompanion((c) => c.decks[DECK]?.decodeFailures)
  const missingSamples = useCompanion((c) => c.decks[DECK]?.missingSamples)

  // THE SINK STARTS WITH NO SESSION, and that is the whole lesson of B5: this
  // used to be conditional on having something to open, which meant "new
  // session" created and opened a document into an engine that was never
  // started — nothing publishes, the transport silently no-ops. Sink first;
  // the session menu fills it afterwards.
  useEffect(() => {
    void autoStartEngine(juceBackend() !== null, () => useCompanion.getState())
  }, [])

  useComposeLifecycle(setNote)

  const { session } = useComposeBinding(link, DECK)

  // THE TEMPO AUTHORITY follows the open session (S3). `applyTempo` walks the
  // map's grid strips, so without a strip the master tempo would move on screen
  // and reach no deck — the exact defect `setMasterBpm`'s signature was changed
  // to prevent, one layer up. Re-installed on every session change because the
  // element carries the SESSION's own bpm, which is the denominator of the
  // sync ratio.
  const [storedMaster] = useSetting(link, MASTER_TEMPO_KEY, MASTER_TEMPO.def, asNumber)
  useEffect(() => {
    if (!session) return
    installStudioMap({
      sessionId: session.name,
      bpm: (session.pattern as { bpm?: number }).bpm ?? MASTER_TEMPO.def,
      masterBpm: storedMaster,
      // Synced by default: the master tempo is the number a person came here to
      // set, and a deck ignoring it would make every mode switch inaudible.
      syncToMaster: true,
      tempoMode: 'timeStretch',
    })
  }, [session?.name, storedMaster])

  const quiet = silenceNote(session?.name ?? '', {
    engine,
    decodeFailures,
    missingSamples,
  })

  return (
    <main className="panel compose-window" aria-label={`studio ${session?.name ?? 'empty'}`}>
      <header className="compose-window-bar mono">
        <ComposeSessions deck={DECK} onNote={setNote} />
        {/* THE TRANSPORT HAD NO DOOR. The verb was already reachable — Space
            goes through `browserKeymap` to the handler `useComposeBinding`
            registers — but a keyboard-only transport in the app's MAIN WINDOW
            is the fourth of the four rules failing on its own: built, shipped,
            and not reachable by anyone who does not already know it is there. */}
        <Transport deck={DECK} session={session?.name ?? null} />
        <MasterBar link={link} session={session?.name ?? null} />
        <span>{`studio · ${session?.name ?? 'no session'}`}</span>
        {!session && (
          <span className="dim">{' empty studio — use “session ▾” to make or open one'}</span>
        )}
        {note && <span className="dim">{` · ${note}`}</span>}
        {error && <span className="warn">{` ${error}`}</span>}
        {!error && quiet && <span className="warn">{` ${quiet}`}</span>}
        {/* Beside the warnings rather than instead of them: a kit that cannot
            play and a sample that is mid-load are two different facts. */}
        {!error && notice && <span className="dim">{` · ${notice}`}</span>}
      </header>
      <div className="compose-window-body">
        <div className="compose-grid-pane">
          <GridPanel link={link} source={STUDIO_SOURCE} />
        </div>
        <ComposeFiles link={link} />
      </div>
      {/* THE TAPE ROW (S8) — the same block ScoopyTape mounts, given a short
          collapsible box instead of a window. That difference is the whole of
          the product difference here, which is what D-SL-STUDIO-01 L1 asks for:
          a face composes blocks and never rebuilds one.

          COLLAPSED BY DEFAULT because the row is optional by decision — the
          ruling calls it "an optional Scoopy Tape bottom row" — and an unasked-
          for 200px of recorder under every session would be the face making a
          choice that belongs to the person. The toggle is the door, and it is
          one click; it does not remember yet (a setting is S7's shape, and
          guessing at the key now would be a second home for it). */}
      <div className={`studio-tape-dock${tapeOpen ? ' open' : ''}`}>
        <button
          type="button"
          className="studio-tape-toggle mono"
          aria-expanded={tapeOpen}
          title={tapeOpen ? 'hide the tape row' : 'show the tape row — 8 loopers and the input recorder'}
          onClick={() => setTapeOpen((v) => !v)}
        >
          {`${tapeOpen ? '▾' : '▸'} tape`}
        </button>
        {/* Studio has no host playhead, so the FACE is what knows the tempo a
            scratch pattern locks to — the same master the tempo law uses. */}
        {tapeOpen && <TapeRow link={link} bpm={storedMaster} />}
      </div>
    </main>
  )
}
