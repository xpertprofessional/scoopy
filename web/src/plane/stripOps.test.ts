import { describe, expect, it } from 'vitest'
import { SL_TAPE_STATE } from '../../protocol/schema.ts'
import { emptyMap, type PlaneMap, type Strip } from '../persist/mapDocument.ts'
import {
  BR_SCALE,
  masterBrView,
  IDLE_LIVE,
  MAX_CHANNELS,
  enabledControls,
  freeChannel,
  freeDeck,
  freeTape,
  inputFor,
  inputRoute,
  mmss,
  nameAfterSessionLoad,
  newStrip,
  newGridElement,
  newStripKey,
  newTapeElement,
  linkedLooperFor,
  RECORD_SOURCE,
  recordTapFor,
  spawnPoint,
  stateWord,
  statusLine,
  type Live,
} from './stripOps.ts'

const tapeEl = (index: number) => newTapeElement(index, false)

function strip(over: Partial<Strip> = {}): Strip {
  return { ...newStrip(0, { x: 0, y: 0 }), ...over }
}

function mapWith(strips: Strip[]): PlaneMap {
  return { ...emptyMap(), strips }
}

const live = (over: Partial<Live> = {}): Live => ({ ...IDLE_LIVE, ...over })
const recording = live({ tapeState: SL_TAPE_STATE.recording })

describe('allocation', () => {
  it('reuses the lowest free channel rather than counting upward', () => {
    // Channels are eight fixed mixer lanes, not a growing list. Next-highest
    // would run out after eight LIFETIME strips instead of eight simultaneous
    // ones, which on a long set is the same as running out at random.
    const map = mapWith([strip({ key: 'a', channel: 0 }), strip({ key: 'c', channel: 2 })])
    expect(freeChannel(map)).toBe(1)
  })

  it('returns null when every channel is taken, rather than a wrong index', () => {
    const full = mapWith(
      Array.from({ length: MAX_CHANNELS }, (_, i) => strip({ key: `s${i}`, channel: i })),
    )
    expect(freeChannel(full)).toBeNull()
  })

  it('allocates tapes in their OWN index space, ignoring grid decks', () => {
    const map = mapWith([
      strip({ key: 'a', channel: 0, element: tapeEl(0) }),
      strip({
        key: 'b',
        channel: 1,
        element: newGridElement(1, 's', 120),
      }),
    ])
    // Tape 1 is free even though grid deck 1 is in use — different spaces.
    expect(freeTape(map)).toBe(1)
  })

  it('gives every strip a unique key', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newStripKey()))
    expect(keys.size).toBe(50)
  })

  it('creates strips EMPTY, unmuted and at unity', () => {
    // A strip that arrived with a dead tape element would be the "form to fill
    // in" the plane exists to avoid; one that arrived muted would teach that
    // the plane is a place where you configure things before you hear them.
    const s = newStrip(3, { x: 10, y: 20 })
    expect(s.element.kind).toBe('none')
    expect(s.level).toBe(1)
    expect(s.mute).toBe(false)
    expect(s.cell).toMatchObject({ x: 10, y: 20, w: 340, h: 196 })
  })

  it('gives a new tape LOOP ENABLED', () => {
    // Law C-3: stopping a recording plays it back immediately. A tape that
    // arrived not looping would make "how do I make it loop?" the first
    // question, which is the documented failure this design targets.
    const el = newTapeElement(2, false)
    expect(el.kind === 'tape' && el.loop.enabled).toBe(true)
    expect(el.kind === 'tape' && el.rate).toBe(1)
  })
})

describe('the state word', () => {
  it('reads the ENGINE, not the document', () => {
    // A document that thinks a tape is looping while it stopped is exactly the
    // drift the record→material transition produces.
    const s = strip({ element: tapeEl(0) })
    expect(stateWord(s, live({ tapeState: SL_TAPE_STATE.loop }))).toBe('loop')
    expect(stateWord(s, live({ tapeState: SL_TAPE_STATE.oneShot }))).toBe('shot')
    expect(stateWord(s, recording)).toBe('rec')
    expect(stateWord(s, IDLE_LIVE)).toBe('idle')
  })

  it('says ---- for a strip with no element, not "idle"', () => {
    // "idle" would claim there is something to play.
    expect(stateWord(strip(), IDLE_LIVE)).toBe('----')
  })

  it('is always short enough not to reflow the head', () => {
    const s = strip({ element: tapeEl(0) })
    for (const l of [
      IDLE_LIVE,
      recording,
      live({ tapeState: SL_TAPE_STATE.loop }),
      live({ tapeState: SL_TAPE_STATE.oneShot }),
    ])
      expect(stateWord(s, l).length).toBeLessThanOrEqual(4)
  })
})

describe('the status ladder (L3)', () => {
  const s = strip({ element: tapeEl(2) })

  it('renders EXACTLY ONE message, never a stack', () => {
    // A stack changes the strip's height, which invalidates cell.h, which
    // corrupts every saved arrangement around it.
    const st = statusLine(s, live({ capReached: true }), {
      unresolvedRef: '/takes/gone.wav',
      recordSource: 'Built-in Mic',
      takeName: 'take_0003.wav',
    })
    expect(st.text).toContain('audio missing')
    expect(st.text).not.toContain('cap')
    expect(st.text.split('\n')).toHaveLength(1)
  })

  it('puts audio-missing above everything', () => {
    expect(statusLine(s, IDLE_LIVE, { unresolvedRef: '/x.wav' }).tone).toBe('hot')
  })

  it('reports the cap, which the tape hit by ITSELF', () => {
    // Without this the tape stopped recording and went to loop, and the UI
    // shows a perfectly ordinary looping tape with no explanation.
    const st = statusLine(s, live({ capReached: true }), {})
    expect(st.text).toContain('256 MB')
    expect(st.tone).toBe('warn')
  })

  it('names the source and the destination tape while recording', () => {
    const st = statusLine(s, recording, { recordSource: 'Built-in Mic', recSeconds: 7 })
    expect(st.text).toBe('recording Built-in Mic → tape 2 · 0:07')
  })

  it('answers "what will REC capture?" before you press it', () => {
    expect(statusLine(strip(), IDLE_LIVE, { recordSource: 'Built-in Mic' }).text).toBe(
      'records: Built-in Mic',
    )
  })

  it('NEVER returns an empty string — the line is reserved', () => {
    // An empty string would collapse the line's box and move every row below it.
    const st = statusLine(strip(), IDLE_LIVE, {})
    expect(st.text.length).toBeGreaterThan(0)
  })

  it('names a strip that is SILENT FOR A ROUTING REASON', () => {
    // pd-strip-anatomy state 15. The console said this; the plane had dropped
    // it (defect D7), so a strip whose output went nowhere was simply
    // inaudible with nothing anywhere to explain it — the hardest kind of
    // fault to guess at.
    const st = statusLine(s, IDLE_LIVE, { noOutput: true })
    expect(st.text).toContain('no output')
    expect(st.tone).toBe('warn')
  })

  it('ranks audio-missing ABOVE no-output', () => {
    // Both say "this strip cannot make the sound you expect"; the missing file
    // is the one you can act on first.
    const st = statusLine(s, IDLE_LIVE, { noOutput: true, unresolvedRef: '/x.wav' })
    expect(st.text).toContain('audio missing')
  })

  it('states the honest price of a feedback edge', () => {
    const st = statusLine(s, IDLE_LIVE, { feedbackMs: 10.7 })
    expect(st.text).toContain('+10.7 ms')
    expect(st.tone).toBe('warn')
  })
})

describe('enabled controls', () => {
  it('keeps REC live on a strip whose audio is MISSING', () => {
    // Recording over a dead reference is a REPAIR. Disabling it would leave the
    // user with a broken strip and no way to fix it in place.
    const can = enabledControls(strip({ element: tapeEl(0) }), IDLE_LIVE, {
      unresolvedRef: '/gone.wav',
    })
    expect(can.record).toBe(true)
    expect(can.play).toBe(false) // there is nothing to play
  })

  it('keeps REC live on an EMPTY strip — that is how it gets material', () => {
    expect(enabledControls(strip(), IDLE_LIVE).record).toBe(true)
  })

  it('disables everything, REC included, only while decoding', () => {
    const can = enabledControls(strip({ element: tapeEl(0) }), IDLE_LIVE, { decoding: 0.4 })
    expect(can.record).toBe(false)
    expect(can.play).toBe(false)
  })

  it('disables the play verbs while recording, but not REC (it is STOP)', () => {
    const can = enabledControls(strip({ element: tapeEl(0) }), recording)
    expect(can.record).toBe(true)
    expect(can.play).toBe(false)
    expect(can.rate).toBe(false)
  })
})

describe('formatting', () => {
  it('renders m:ss at a fixed width past a minute', () => {
    expect(mmss(0)).toBe('0:00')
    expect(mmss(7)).toBe('0:07')
    expect(mmss(67)).toBe('1:07')
    expect(mmss(-5)).toBe('0:00') // never negative
  })
})

describe('the input route — what makes REC work at all', () => {
  it('patches a DEVICE INPUT into the strip channel', () => {
    // Without this a strip records its own channel bus, which carries nothing:
    // REC captures silence perfectly and forever, with nothing saying why.
    // `plane_audio_test` (C++, real engine, real samples) is what caught it.
    const r = inputRoute(3)
    expect(r.src.kind).toBe('deviceInput')
    expect(r.dst.kind).toBe('channelIn')
    expect(r.dst.index).toBe(3)
    expect(r.feedback).toBe(false) // an input is not a loop
    expect(r.gain).toBe(1)
  })

  it('carries a STEREO pair, not just the left channel', () => {
    // `sub` is the right-hand input channel; dropping it gives a mono strip
    // fed from the left input only, which sounds like a wiring fault.
    const r = inputRoute(0)
    expect(r.src.index).toBe(0)
    expect(r.src.sub).toBe(1)
  })

  it('finds the input feeding a given strip, and only that strip', () => {
    const s0 = strip({ key: 'a', channel: 0 })
    const s1 = strip({ key: 'b', channel: 1 })
    const map = { ...mapWith([s0, s1]), routes: [inputRoute(1)] }
    expect(inputFor(map, s1)).not.toBeNull()
    expect(inputFor(map, s0)).toBeNull()
  })
})

describe('grid decks — the third index space', () => {
  const gridStrip = (channel: number, deck: number) =>
    strip({ key: `g${deck}`, channel, element: newGridElement(deck, 's', 120) })

  it('allocates the lowest free deck', () => {
    expect(freeDeck(mapWith([]))).toBe(0)
    expect(freeDeck(mapWith([gridStrip(0, 0)]))).toBe(1)
  })

  it('REUSES a hole rather than counting upward', () => {
    // Decks are three fixed engine slots, not a growing list. Counting upward
    // would run out at three LIFETIME grid strips instead of three simultaneous
    // ones — and three is a small enough number to hit in one session.
    expect(freeDeck(mapWith([gridStrip(0, 0), gridStrip(1, 2)]))).toBe(1)
  })

  it('returns null when all three are taken, rather than a fourth deck', () => {
    const full = mapWith([gridStrip(0, 0), gridStrip(1, 1), gridStrip(2, 2)])
    // The engine REFUSES an out-of-range deck; handing one out here would just
    // move the failure somewhere with less to say about it.
    expect(freeDeck(full)).toBeNull()
  })

  it('counts only GRID strips — a tape does not occupy a deck', () => {
    expect(freeDeck(mapWith([strip({ element: tapeEl(0) })]))).toBe(0)
  })

  it('a loaded session arrives UNSYNCED, at its own tempo', () => {
    // "Decks load into strips, each with its own BPM" is the mission sentence,
    // so a session arriving locked to the plane's master would be its opposite.
    const el = newGridElement(1, 'forest', 174)
    // Spelled out, NOT `{...newGridElement(...)}` — this asserts the DEFAULTS a
    // fresh grid element carries, and comparing the function to itself would
    // assert nothing. Unsynced at its own tempo, pitch-preserving if it is ever
    // synced, and `auto` so the pulse relation is the engine's problem.
    expect(el).toEqual({
      kind: 'grid',
      deck: 1,
      sessionId: 'forest',
      bpm: 174,
      syncToMaster: false,
      tempoMode: 'timeStretch',
      pulseRelation: 'auto',
      transpose: 0,
      // TP mode off (v9): sync and transpose coexist until asked otherwise —
      // the donor's default, and what every map written before v9 behaved like.
      pitchMode: false,
    })
  })
})

describe('universal transport — a deck answers the same verbs (P3-1)', () => {
  const gridStrip = () => strip({ element: newGridElement(0, 'beach', 120) })

  it('lets a GRID strip be played and stopped', () => {
    // ⚠️ THE GAP THIS CLOSES. A scoopy deck sat in a strip and ignored every
    // verb on it: `enabledControls` gated the whole transport on
    // `element.kind === 'tape'`, so the buttons were permanently inert. "Deck
    // transport, controlled universally for all elements" starts here.
    const can = enabledControls(gridStrip(), IDLE_LIVE)
    expect(can.play).toBe(true)
    expect(can.stop).toBe(true)
  })

  it('leaves ONE-SHOT inert on a grid strip — a pattern has no one-shot', () => {
    // Rendered but disabled (layout law L2), not given a fake behaviour: a
    // sequenced pattern repeats by nature, so ▸ has no meaning for it. This is
    // why `oneShot` is split from `play` at all.
    expect(enabledControls(gridStrip(), IDLE_LIVE).oneShot).toBe(false)
    expect(enabledControls(strip({ element: tapeEl(0) }), IDLE_LIVE).oneShot).toBe(true)
  })

  it('keeps varispeed and scrub TAPE-only', () => {
    // A deck's rate is its tempo, which is the bpm field on the strip. A second
    // speed control would be two ways to do one thing, in different units.
    const can = enabledControls(gridStrip(), IDLE_LIVE)
    expect(can.rate).toBe(false)
    expect(can.scrub).toBe(false)
  })

  it('reads the DECK for its state word, not the tape bank', () => {
    // `live.tapeState` describes tape N and a grid strip owns no tape, so
    // before the deck axis a grid strip showed either 'idle' forever or
    // whatever the tape sharing its index was doing.
    expect(stateWord(gridStrip(), IDLE_LIVE, true)).toBe('play')
    expect(stateWord(gridStrip(), IDLE_LIVE, false)).toBe('idle')
    // …and a PLAYING tape is unaffected by the deck flag.
    const tapeS = strip({ element: tapeEl(0) })
    expect(stateWord(tapeS, live({ tapeState: SL_TAPE_STATE.loop }), false)).toBe('loop')
  })

  it('does not let a deck flag leak into a tape strip', () => {
    const tapeS = strip({ element: tapeEl(0) })
    expect(stateWord(tapeS, IDLE_LIVE, true)).toBe('idle')
  })
})

describe('the record tap (the split tap)', () => {
  const anInput = { left: 2, right: 3 }

  it('a fresh strip arrives NOT monitoring — the feedback fix', () => {
    // A strip arrives with its input patched (otherwise REC captures silence)
    // and used to arrive HEARING it, so a strip made next to a live mic fed
    // back instantly and the only control that stopped it also muted the tape.
    expect(newStrip(0, { x: 0, y: 0 }).monitor).toBe(false)
    expect(newStrip(0, { x: 0, y: 0 }).recordTap).toBeNull()
  })

  it('records the INPUT when there is one — capture stops depending on monitoring', () => {
    const tap = recordTapFor(strip(), anInput, 'Built-in Mic')
    expect(tap.kind).toBe(RECORD_SOURCE.deviceInput)
    expect(tap.chan0).toBe(2)
    expect(tap.chan1).toBe(3)
    expect(tap.label).toBe('Built-in Mic')
  })

  it('records its own BUS when there is no input — "one tap" still holds there', () => {
    const tap = recordTapFor(strip({ channel: 5 }), null)
    expect(tap.kind).toBe(RECORD_SOURCE.channelBus)
    expect(tap.chan0).toBe(5)
  })

  it('a mono input records mono, not a phantom right channel', () => {
    expect(recordTapFor(strip(), { left: 1, right: null }).chan1).toBe(-1)
  })

  it('an explicit BUS override keeps "record the chain routed into me"', () => {
    // THE CAPABILITY THE RULE ALONE WOULD DELETE. Patch strip A into strip B
    // and press REC on B: that used to capture A, because the bus carries
    // whatever is routed in. With an input present the rule would capture only
    // the input, and nothing would say where the chain went.
    const tap = recordTapFor(strip({ channel: 4, recordTap: 'bus' }), anInput)
    expect(tap.kind).toBe(RECORD_SOURCE.channelBus)
    expect(tap.chan0).toBe(4)
  })

  it('an explicit mainMix override captures what leaves the app', () => {
    expect(recordTapFor(strip({ recordTap: 'mainMix' }), anInput).kind).toBe(
      RECORD_SOURCE.mainMix,
    )
  })

  it('falls back to the bus when a pinned INPUT is gone, rather than refusing', () => {
    // The interface was unplugged. A strip that cannot record at all is worse
    // than one that records what it still has, and the status line names the
    // tap either way.
    const tap = recordTapFor(strip({ channel: 6, recordTap: 'input' }), null)
    expect(tap.kind).toBe(RECORD_SOURCE.channelBus)
    expect(tap.chan0).toBe(6)
  })
})

describe('placement', () => {
  it('spawns at the centre of what you are LOOKING at, not the origin', () => {
    const at = spawnPoint({ width: 1000, height: 600 }, { scale: 1, panX: 0, panY: 0 }, 0)
    expect(at.x).toBe(1000 / 2 - 170)
    expect(at.y).toBe(600 / 2 - 98)
  })

  it('accounts for pan and zoom', () => {
    // plane = screen/scale − pan. Getting this wrong puts new strips off-screen.
    const at = spawnPoint({ width: 1000, height: 600 }, { scale: 2, panX: -100, panY: -50 }, 0)
    expect(at.x).toBe(1000 / 2 / 2 + 100 - 170)
    expect(at.y).toBe(600 / 2 / 2 + 50 - 98)
  })

  it('cascades successive additions so they do not stack exactly', () => {
    const v = { width: 1000, height: 600 }
    const p = { scale: 1, panX: 0, panY: 0 }
    expect(spawnPoint(v, p, 1).x).toBeGreaterThan(spawnPoint(v, p, 0).x)
  })
})

describe('nameAfterSessionLoad (P3-U2)', () => {
  const base = () => newStrip(0, { x: 0, y: 0 }) // name "STRIP 1"

  it('a default-named strip takes the session name', () => {
    expect(nameAfterSessionLoad(base(), 'My Jam')).toBe('My Jam')
  })

  it('a strip named after its PREVIOUS session follows a swap', () => {
    const s = { ...base(), name: 'Old Jam', element: newGridElement(0, 'Old Jam', 120) }
    expect(nameAfterSessionLoad(s, 'New Jam')).toBe('New Jam')
  })

  it('a name the user typed WINS — renames are sacred', () => {
    const s = { ...base(), name: 'front left monitor' }
    expect(nameAfterSessionLoad(s, 'My Jam')).toBe('front left monitor')
    // …including when the strip already holds a different session.
    const g = { ...s, element: newGridElement(0, 'Old Jam', 120) }
    expect(nameAfterSessionLoad(g, 'New Jam')).toBe('front left monitor')
  })

  it('the default is per-CHANNEL, so "STRIP 2" on channel 1 also follows', () => {
    const s = { ...newStrip(1, { x: 0, y: 0 }) }
    expect(s.name).toBe('STRIP 2')
    expect(nameAfterSessionLoad(s, 'My Jam')).toBe('My Jam')
  })
})

describe('linkedLooperFor (P3-R3)', () => {
  const busRoute = (fromChannel: number, toChannel: number) => ({
    src: { kind: 'channelOut' as const, index: fromChannel, sub: null },
    dst: { kind: 'channelIn' as const, index: toChannel },
    gain: 1,
    feedback: false,
  })

  it('finds the tape strip this grid strip feeds whose tap is the bus', () => {
    const grid = strip({ channel: 0, element: newGridElement(0, 'ses', 120) })
    const looper = strip({ channel: 1, element: tapeEl(0), recordTap: 'bus' })
    const map = { ...mapWith([grid, looper]), routes: [busRoute(0, 1)] }
    expect(linkedLooperFor(map, grid)?.key).toBe(looper.key)
  })

  it('a routed tape strip WITHOUT the bus tap is not linked — its REC captures something else', () => {
    const grid = strip({ channel: 0, element: newGridElement(0, 'ses', 120) })
    const looper = strip({ channel: 1, element: tapeEl(0), recordTap: null })
    const map = { ...mapWith([grid, looper]), routes: [busRoute(0, 1)] }
    expect(linkedLooperFor(map, grid)).toBeNull()
  })

  it('a bus-tapped tape strip nobody routed is not linked — the cable is the link', () => {
    const grid = strip({ channel: 0, element: newGridElement(0, 'ses', 120) })
    const looper = strip({ channel: 1, element: tapeEl(0), recordTap: 'bus' })
    const map = mapWith([grid, looper])
    expect(linkedLooperFor(map, grid)).toBeNull()
  })

  it('another grid strip never qualifies, whatever its routing', () => {
    const grid = strip({ channel: 0, element: newGridElement(0, 'ses', 120) })
    const other = strip({ channel: 1, element: newGridElement(1, 'other', 120), recordTap: 'bus' })
    const map = { ...mapWith([grid, other]), routes: [busRoute(0, 1)] }
    expect(linkedLooperFor(map, grid)).toBeNull()
  })

  // P3.5-E3: the cable that actually carries a grid strip is `deckOut` naming
  // its DECK — a grid strip's channel bus is empty by construction, which is
  // why the old channelOut cable recorded silence.
  const deckRoute = (deck: number, toChannel: number) => ({
    src: { kind: 'deckOut' as const, index: deck, sub: null },
    dst: { kind: 'channelIn' as const, index: toChannel },
    gain: 1,
    feedback: false,
  })

  it('finds the looper fed by this strip’s DECK OUT (the cable P3.5-E3 authors)', () => {
    const grid = strip({ channel: 0, element: newGridElement(2, 'ses', 120) })
    const looper = strip({ channel: 1, element: tapeEl(0), recordTap: 'bus' })
    const map = { ...mapWith([grid, looper]), routes: [deckRoute(2, 1)] }
    expect(linkedLooperFor(map, grid)?.key).toBe(looper.key)
  })

  it('matches on the DECK, not the channel — the two index spaces are different', () => {
    // Deck 2 in channel 0. A deckOut cable naming deck 0 (== this strip's
    // CHANNEL) must NOT read as this strip's looper; confusing the spaces is
    // how a gesture lands on someone else's deck.
    const grid = strip({ channel: 0, element: newGridElement(2, 'ses', 120) })
    const looper = strip({ channel: 1, element: tapeEl(0), recordTap: 'bus' })
    const map = { ...mapWith([grid, looper]), routes: [deckRoute(0, 1)] }
    expect(linkedLooperFor(map, grid)).toBeNull()
  })

  it('still recognises the OLD channelOut link — maps saved before the fix keep reading as a pair', () => {
    // The cable is silent in those maps (that is the defect), but the pair must
    // not silently spawn a SECOND looper next to the one already there.
    const grid = strip({ channel: 0, element: newGridElement(0, 'ses', 120) })
    const looper = strip({ channel: 1, element: tapeEl(0), recordTap: 'bus' })
    const map = { ...mapWith([grid, looper]), routes: [busRoute(0, 1)] }
    expect(linkedLooperFor(map, grid)?.key).toBe(looper.key)
  })
})

describe('the master BR view — a fan-out, never a second truth (P11-0)', () => {
  // THE SCOPE LAW: BR · TR · WIN · REV · SYNC are DECK controls; the master row
  // FEEDS them and owns none of them. The master used to keep its own `brOn`
  // boolean synced from nothing, so a strip engaging BR left the master lamp
  // dark, and the master's next press computed `!brOn` from that stale value.
  const win = (length: number, subdivision?: number) => ({ length, subdivision })
  const none = () => null

  it('lights when ANY deck it drives has BR engaged — even one it did not start', () => {
    const v = masterBrView([0, 1, 2], (d) => (d === 2 ? win(2) : null), 3)
    expect(v.active).toBe(true)
    // …and the next press therefore CLEARS, completing the gesture the lamp shows.
    expect(v.nextOn).toBe(false)
  })

  it('stays dark, and arms, when no deck is repeating', () => {
    const v = masterBrView([0, 1], none, 3)
    expect(v.active).toBe(false)
    expect(v.nextOn).toBe(true)
  })

  it('ignores decks the master cannot drive', () => {
    // A composing deck is not in activeDecks, so its BR must not light the
    // master — the master genuinely cannot turn that one off.
    const v = masterBrView([0], (d) => (d === 1 ? win(2) : null), 3)
    expect(v.active).toBe(false)
  })

  it('reports the LATCHED window, not what the master last asked for', () => {
    // A strip's own BR may have set a different scale. The master shows what is
    // happening; showing its own pending index would be a claim about a deck.
    const v = masterBrView([0], () => win(1, 16), 3) // pending is '2'
    expect(v.label).toBe('1/16')
  })

  it('falls back to the pending label for an off-scale window', () => {
    // A hand-built window is not on the scale; showing nothing would be worse
    // than showing what the next press will send.
    const v = masterBrView([0], () => win(7), 3)
    expect(v.label).toBe('2')
  })

  it('shows the pending scale while nothing is latched', () => {
    expect(masterBrView([0], none, 0).label).toBe(BR_SCALE[0]!.label)
  })

  it('is dark with no decks at all', () => {
    const v = masterBrView([], none, 3)
    expect(v.active).toBe(false)
    expect(v.nextOn).toBe(true)
  })
})
