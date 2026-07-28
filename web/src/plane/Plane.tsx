/**
 * Plane — the boundless workspace of strips (merge P2 step 4).
 *
 * Strips are placed by their `cell` geometry; the plane applies ONE pan/zoom
 * transform over all of them. Screen = (planeCoord + pan) · scale, so the CSS
 * transform is `scale(s) translate(pan)` with a top-left origin — the exact
 * convention `fitToContent()` computes against. No grid: placement is the
 * user's, and it is mnemonic only — moving a strip changes no audio, ever.
 *
 * Zoom controls sit bottom-right (GRM's verified placement) with a 1× reset and
 * fit-to-content, which is ours because GRM has no overview aid at all.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { EngineLink } from '../engineLink.ts'
import {
  getMap,
  setSelected,
  updatePlaneView,
  updateStrip,
  useMapStore,
} from '../state/mapStore.ts'
import { useContextMenu } from '../design/ContextMenu.tsx'
import { useCompanion } from '../store/companionEngine.ts'
import { fitToContent, zoomAbout, type Viewport } from './planeLayout.ts'
import { Cables } from './Cables.tsx'
import { chipsOf, feedbackInto, feedbackMs, hasOutput, type Cable } from './cables.ts'
import { cellsOf, inputFor, inputRoute } from './stripOps.ts'
import { send } from './send.ts'
import { Strip } from './Strip.tsx'

const MIN_SCALE = 0.2
const MAX_SCALE = 2.5

/** Below this many SCREEN pixels a pointer gesture is a CLICK, not a drag.
    Without it every click on a strip nudges it a pixel or two and a carefully
    arranged plane rots by the end of a set. Screen pixels, not plane units, so
    the threshold feels identical at every zoom. */
const DRAG_THRESHOLD_PX = 4

type PanDrag = { px: number; py: number; panX: number; panY: number }
type StripDrag = {
  key: string
  px: number
  py: number
  cellX: number
  cellY: number
  moved: boolean
}

export function Plane({
  link,
  onAddStrip,
  onOpenMatrix,
  onLoadSession,
  onDropElement,
  onCompose,
  takeIndex,
}: {
  link: EngineLink | null
  onAddStrip: () => void
  onOpenMatrix: () => void
  /** Load a session into a strip — deck allocation belongs to the panel, which
      owns the map and can refuse when all three decks are taken. */
  onLoadSession?: (stripKey: string, sessionId: string) => void
  onDropElement?: (stripKey: string) => void
  /** Open the composer beside the map, bound to a deck. */
  onCompose?: (deck: number) => void
  /** The take library, path → display facts (P3-U4). `null` until the first
      listing answers — a strip must not claim "audio missing" merely because
      nobody has asked the disk yet. */
  takeIndex?: ReadonlyMap<string, { name: string; seconds: number | null }> | null
}) {
  const strips = useMapStore((s) => s.map.strips)
  const plane = useMapStore((s) => s.map.plane)
  const map = useMapStore((s) => s.map)
  // The scene actually RUNNING, from the session store. The map remembers a
  // scene per (strip, session); the engine is what is playing one, and those
  // differ the moment anything else selects.
  //
  // ⚠️ PER DECK. This used to read ONE `scene` and hand it to every strip, which
  // was correct only while the store could hold one session: two grid strips
  // showed the same pad lit no matter which was playing what, and clicking
  // either one moved them both. The deck axis is what makes a scene belong to
  // the strip you clicked.
  const decks = useCompanion((c) => c.decks)
  const sessions = useCompanion((c) => c.sessions)
  const selectScene = useCompanion((c) => c.selectScene)
  const playDeck = useCompanion((c) => c.play)
  const stopDeck = useCompanion((c) => c.stop)
  const { openMenu } = useContextMenu()
  const selectedKey = useMapStore((s) => s.selectedKey)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const panDrag = useRef<PanDrag | null>(null)
  const stripDrag = useRef<StripDrag | null>(null)
  const patchDrag = useRef<{ fromChannel: number; send: number | null } | null>(null)
  // Live transform during a gesture. Held in local state so a pan repaints at
  // pointer rate without writing the document sixty times a second; committed
  // to the store on release.
  const [view, setView] = useState(plane)

  // Follow the document when it changes underneath us (a load, a fit), but not
  // while a gesture owns the transform.
  useLayoutEffect(() => {
    if (!panDrag.current) setView(plane)
  }, [plane])

  const viewport = useCallback((): Viewport => {
    const el = surfaceRef.current
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  }, [])

  const commit = (v: typeof view) => {
    setView(v)
    updatePlaneView(v)
  }

  const fit = () => commit(fitToContent(cellsOf(getMap()), viewport()))

  /**
   * Re-point a strip's input.
   *
   * The DOCUMENT's route is replaced and the ENGINE is re-patched — a remove
   * followed by an add rather than an edit, because a route's endpoints are
   * what identify it and `sl_route_*` has no "re-point" verb. The unpatch ramps
   * out and the new cable ramps in, so switching input mid-performance is a
   * crossfade rather than a click.
   *
   * The old route is found by DESTINATION (this channel), not by remembering an
   * id: ids are the engine's, the document does not carry them, and a stale one
   * would unpatch someone else's cable.
   */
  const repointInput = (channel: number, left: number, right: number | null) => {
    const next = { ...inputRoute(channel, left, right ?? undefined), src: { kind: 'deviceInput' as const, index: left, sub: right } }
    useMapStore.setState((st) => ({
      map: {
        ...st.map,
        routes: [
          ...st.map.routes.filter(
            (r) => !(r.src.kind === 'deviceInput' && r.dst.kind === 'channelIn' && r.dst.index === channel),
          ),
          next,
        ],
      },
      dirty: true,
    }))
    void repatch(channel, left, right)
  }

  /**
   * UNPATCH a cable, by clicking it.
   *
   * The engine ramps the gain out and drops the slot only once it reaches zero,
   * so removing a live cable is a crossfade rather than a click. The route is
   * found on the ENGINE by matching endpoints, not by an id the document
   * carries — ids are the engine's, and a stale one would unpatch someone
   * else's cable.
   */
  const unpatch = async (c: Cable) => {
    useMapStore.setState((st) => ({
      map: { ...st.map, routes: st.map.routes.filter((r) => r !== c.route) },
      dirty: true,
    }))
    if (!link) return
    const listed = (await link
      .command('slRouteList', {})
      .catch(() => null)) as { routes?: Array<Record<string, number | boolean>> } | null
    const srcKind = c.send === null ? 0 : 1
    const srcSub = c.send ?? 0xffffffff
    for (const [id, r] of (listed?.routes ?? []).entries())
      if (
        r.active &&
        r.srcKind === srcKind &&
        r.srcIndex === c.route.src.index &&
        r.srcSub === srcSub &&
        r.dstKind === 0 &&
        r.dstIndex === c.route.dst.index
      )
        send(link, 'slRoute', { action: 'remove', id })
  }

  /**
   * PATCH one strip's output into another's input.
   *
   * ⚠️ THE CYCLE IS ASKED ABOUT FIRST. A route that would close a loop is
   * REFUSED by the engine unless the caller consents to a `feedback` edge — and
   * a refusal with no explanation is indistinguishable from a broken button. So
   * `wouldCycle` is consulted before the add, and the user is offered the
   * feedback edge WITH ITS PRICE rather than being told no. That is the whole
   * of "refusing silently-created cycles while allowing consented ones".
   */
  const patch = async (
    fromChannel: number,
    toChannel: number,
    sendIndex: number | null,
    at: { x: number; y: number },
  ) => {
    if (!link || fromChannel === toChannel) return
    const wc = (await link
      .command('slRoute', { action: 'wouldCycle', srcIndex: fromChannel, dstIndex: toChannel })
      .catch(() => null)) as { wouldCycle?: boolean } | null

    if (!wc?.wouldCycle) {
      commitPatch(fromChannel, toChannel, sendIndex, false)
      return
    }

    // ⚠️ NOT `window.confirm`. A JS modal BLOCKS the whole WebView — in the
    // JUCE host it would freeze the page and take the audio UI with it — so the
    // offer uses the app's own menu, which is a DOM popover and cannot block
    // anything. The price is in the offer, not discovered afterwards.
    openMenu(
      [
        { kind: 'info', label: 'that would close a loop' },
        {
          kind: 'item',
          label: `patch as feedback · +${feedbackMs().toFixed(1)} ms`,
          onSelect: () => commitPatch(fromChannel, toChannel, sendIndex, true),
        },
        { kind: 'item', label: 'cancel', onSelect: () => {} },
      ],
      at.x,
      at.y,
    )
  }

  /** The add itself, once consent (if any) is settled. */
  const commitPatch = (
    fromChannel: number,
    toChannel: number,
    sendIndex: number | null,
    feedback: boolean,
  ) => {
    const route = {
      src: {
        kind: (sendIndex === null ? 'channelOut' : 'channelSend') as 'channelOut' | 'channelSend',
        index: fromChannel,
        sub: sendIndex,
      },
      dst: { kind: 'channelIn' as const, index: toChannel },
      gain: 1,
      feedback,
    }
    useMapStore.setState((st) => ({
      map: { ...st.map, routes: [...st.map.routes, route] },
      dirty: true,
    }))
    send(link, 'slRoute', {
      action: 'add',
      srcKind: sendIndex === null ? 0 : 1,
      srcIndex: fromChannel,
      srcSub: sendIndex ?? 0xffffffff,
      dstKind: 0,
      dstIndex: toChannel,
      gain: 1,
      feedback,
    })
  }

  /** Engine side of the above: drop every deviceInput cable into this channel,
      then patch the chosen one. Read from the LIVE graph rather than the
      document, so a cable added outside the document's view is also cleared —
      otherwise two inputs would sum into one strip and the second would be
      invisible. */
  const repatch = async (channel: number, left: number, right: number | null) => {
    if (!link) return
    const listed = (await link
      .command('slRouteList', {})
      .catch(() => null)) as { routes?: Array<Record<string, number | boolean>> } | null
    for (const [id, r] of (listed?.routes ?? []).entries())
      if (r.active && r.srcKind === 2 && r.dstKind === 0 && r.dstIndex === channel)
        send(link, 'slRoute', { action: 'remove', id })
    send(link, 'slRoute', {
      action: 'add',
      srcKind: 2,
      srcIndex: left,
      srcSub: right ?? 0xffffffff,
      dstKind: 0,
      dstIndex: channel,
      gain: 1,
      feedback: false,
    })
  }

  // Frame the patch on first mount ONLY when the map carries no viewport of its
  // own. Fitting unconditionally would throw away the framing the user
  // deliberately left, which is the entire point of persisting it.
  const framed = useRef(false)
  useLayoutEffect(() => {
    if (framed.current || strips.length === 0) return
    framed.current = true
    const untouched = plane.scale === 1 && plane.panX === 0 && plane.panY === 0
    if (untouched) fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strips.length])

  /* ── pointer ─────────────────────────────────────────────────────────────
   * One handler set on the surface, dispatching by what was hit. Strips do not
   * capture their own pointers: a drag that leaves the strip's box (which every
   * drag does) would otherwise stop tracking mid-gesture.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement

    /* ⚠️ ONLY THE PRIMARY BUTTON DRAGS, AND THIS LINE IS WHY RIGHT-CLICK WAS
     * DEAD ON THE WHOLE PLANE.
     *
     * This handler ran for EVERY button and called `setPointerCapture` on
     * pointer-DOWN. Capturing the pointer suppresses the browser's subsequent
     * `contextmenu` event — so every right-click on a strip was swallowed here
     * before it could reach the strip header's menu, and the user got the
     * WebView's native "Reload" instead.
     *
     * It hid well: a synthetic `dispatchEvent('contextmenu')` opens the menu
     * fine (no pointer sequence to capture), so the handler tested as working
     * while the real gesture never fired. The cost was the entire session-load
     * gesture — the only route to a grid deck, and therefore to every control
     * P3-1 and P3-2 built.
     *
     * `DragBox` had this right from the start (`if (e.button !== 0) return`);
     * the plane surface never did. Selection still happens on any button — you
     * right-click a thing to act on it, and the menu should act on what you hit
     * — but nothing may CAPTURE unless it is the drag button. */
    const primary = e.button === 0

    /* ── PATCHING: shift-drag from one strip to another ────────────────────
     * A separate gesture from moving, and deliberately a modified one. Moving
     * a strip must stay the cheap, thoughtless action — placement is mnemonic
     * and changes no audio — while patching DOES change audio, so it should
     * not be reachable by an accidental 4 px drag. Shift is the modifier the
     * plane already reserves for structural gestures.
     */
    if (e.shiftKey && primary) {
      const stripEl = el.closest('.plane-strip') as HTMLElement | null
      const s = getMap().strips.find((x) => x.key === stripEl?.dataset.key)
      if (s) {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        patchDrag.current = { fromChannel: s.channel, send: null }
        return
      }
    }

    const stripEl = el.closest('.plane-strip') as HTMLElement | null

    // SELECTION AND DRAGGING ARE DIFFERENT DECISIONS, and conflating them was a
    // bug the layout gate caught: the wave field and the transport row are
    // marked `data-no-drag` (a fader drag must never also move the strip), so
    // one early return meant clicking the CENTRE of a strip — most of its
    // area — selected nothing. Clicking anywhere in a strip selects it; only
    // the DRAG is suppressed over a control.
    if (stripEl) {
      const key = stripEl.dataset.key
      const s = getMap().strips.find((x) => x.key === key)
      if (!s) return
      setSelected(s.key)
      // Selection above happens on any button; the DRAG below must not.
      if (!primary) return
      if (el.closest('input, button, select, textarea, [data-no-drag]')) return
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      stripDrag.current = {
        key: s.key,
        px: e.clientX,
        py: e.clientY,
        cellX: s.cell.x,
        cellY: s.cell.y,
        moved: false,
      }
      return
    }

    // Outside a strip, a control still owns its own gesture (the zoom bar).
    if (el.closest('input, button, select, textarea, [data-no-drag]')) return
    if (!primary) return // never capture on right/middle — see the note above
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    // Empty background: clear the selection and start panning.
    setSelected(null)
    panDrag.current = { px: e.clientX, py: e.clientY, panX: view.panX, panY: view.panY }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (patchDrag.current) return // the cable is drawn on release, not dragged
    const sd = stripDrag.current
    if (sd) {
      const dx = e.clientX - sd.px
      const dy = e.clientY - sd.py
      if (!sd.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      sd.moved = true
      // Screen delta → plane delta is a division by scale, so a strip tracks
      // the pointer exactly at any zoom.
      updateStrip(sd.key, (s) => ({
        ...s,
        cell: {
          ...s.cell,
          x: Math.round(sd.cellX + dx / view.scale),
          y: Math.round(sd.cellY + dy / view.scale),
        },
      }))
      return
    }
    const pd = panDrag.current
    if (!pd) return
    setView((v) => ({
      ...v,
      panX: pd.panX + (e.clientX - pd.px) / v.scale,
      panY: pd.panY + (e.clientY - pd.py) / v.scale,
    }))
  }

  const endDrag = (e: React.PointerEvent) => {
    const pd = patchDrag.current
    patchDrag.current = null
    if (pd) {
      // Where the pointer LANDED decides the destination — the same
      // drop-onto-the-target gesture AudioMulch uses, aimed at an object
      // rather than at a peer region, so it cannot be hit by accident.
      const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      const key = over?.closest('.plane-strip')?.getAttribute('data-key')
      const target = getMap().strips.find((x) => x.key === key)
      if (target) void patch(pd.fromChannel, target.channel, pd.send, { x: e.clientX, y: e.clientY })
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      return
    }

    if (panDrag.current) updatePlaneView(view) // commit once, on release
    panDrag.current = null
    stripDrag.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  /* ── zoom ────────────────────────────────────────────────────────────────
   * The point under the cursor stays fixed. That invariant is load-bearing for
   * trust: a zoom that slides the plane under the pointer makes the workspace
   * feel like it is fighting you.
   */
  const applyZoom = (factor: number, screenX: number, screenY: number) =>
    commit(zoomAbout(view, factor, screenX, screenY, MIN_SCALE, MAX_SCALE))

  const onWheel = (e: React.WheelEvent) => {
    const el = surfaceRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
  }

  const zoomAtCentre = (factor: number) => {
    const v = viewport()
    applyZoom(factor, v.width / 2, v.height / 2)
  }

  return (
    <div
      className="plane"
      ref={surfaceRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
    >
      <div
        className="plane-layer"
        style={{
          transform: `scale(${view.scale}) translate(${view.panX}px, ${view.panY}px)`,
        }}
      >
        {/* Cables first, so they paint BEHIND every strip. */}
        <Cables map={map} onRemove={(c) => unpatch(c)} />
        {strips.map((s) => {
          const route = inputFor(map, s)
          // This strip's own deck, and only it. A tape strip has none, so it
          // gets the idle deck and its (unused) scene fields stay inert.
          const deck = s.element.kind === 'grid' ? s.element.deck : -1
          const d = decks[deck] ?? null
          // THE TAKE, RESOLVED (P3-U4). The ladder's top rung ("audio
          // missing") and its take line could never render before: nothing
          // supplied them, so `hasMaterial` could not be falsified by a
          // missing file and a dead reference looked like a healthy strip.
          const ref = s.element.kind === 'tape' ? (s.element.takeRef ?? null) : null
          const resolved = ref != null && takeIndex ? (takeIndex.get(ref) ?? null) : null
          return (
            <Strip
              key={s.key}
              strip={s}
              link={link}
              selected={s.key === selectedKey}
              chips={chipsOf(map, s)}
              feedbackMs={feedbackInto(map, s)}
              unresolvedRef={ref != null && takeIndex && !resolved ? ref : null}
              takeName={resolved?.name ?? null}
              takeSeconds={resolved?.seconds ?? null}
              noOutput={s.element.kind !== 'none' && !hasOutput(map, s)}
              input={route ? { left: route.src.index, right: route.src.sub } : null}
              onPickInput={(left, right) => repointInput(s.channel, left, right)}
              gridScene={d?.scene ?? 'A'}
              gridQueued={d?.scheduledScene ?? null}
              masterBpm={map.transport.masterBpm}
              // Scene selection goes to the SESSION store, not the engine:
              // sl_deck_* has no scene entry point because a scene is a
              // projection of the document. Selecting re-projects and
              // republishes the world. Targeted at THIS strip's deck.
              //
              // (It used to trip a tempo-sync re-apply too — a publish reset
              // every deck's ratio, so the map re-asserted it afterwards. The
              // ratio is deck scope in the engine now and survives a publish,
              // so selecting a scene is just selecting a scene.)
              onSelectScene={(sc, immediate) =>
                deck >= 0 && selectScene(sc, { immediate, deck })
              }
              gridPlaying={d?.playing ?? false}
              // THE TRANSPORT DOMAIN (P3-1). A deck answers the same verbs a
              // tape does, from the same row — which is the whole of "deck
              // transport, controlled universally for all elements". Restart is
              // stop-then-play: a publish is phase-continuous by design (it is
              // what makes a scene switch seamless), so it cannot double as a
              // retrigger.
              onGridTransport={(action) => {
                if (deck < 0) return
                if (action === 'play') playDeck(deck)
                else if (action === 'stop') stopDeck(deck)
                else {
                  stopDeck(deck)
                  playDeck(deck)
                }
              }}
              sessions={sessions}
              onLoadSession={(id) => onLoadSession?.(s.key, id)}
              onDropElement={() => onDropElement?.(s.key)}
              // COMPOSE BESIDE THE MAP, in this window.
              //
              // ⚠️ It used to be `openPanelWindow`, which cannot work: the shell
              // DROPS the arg (MergedMain.cpp calls openPanelFn(panel) and
              // nothing sets `window.__slPanelArg`), and every panel window is a
              // separate WebView with its OWN companionEngine — so the composer
              // opened with no session in it and no way to be told which deck it
              // was for. On the desktop this was Swift's job (WebGridBinding),
              // and Swift is carved off.
              //
              // In-window keeps ONE store as the only publisher, which deletes
              // the cross-window document-relay problem rather than solving it.
              onCompose={() =>
                s.element.kind === 'grid' && onCompose?.(s.element.deck)
              }
            />
          )
        })}
      </div>

      {strips.length === 0 && (
        // The empty-plane message sits where the gesture goes, not as a banner
        // across the top, and it costs nothing after minute one because it
        // vanishes permanently once one strip exists.
        <p className="plane-empty mono dim">
          {/* BOTH KINDS OF MATERIAL, because this line is the only instruction
              on an empty plane and it named only one. "Press REC" gets you a
              TAPE; every grid control — the scene pads, the transport, the whole
              tempo surface — lives on a strip holding a SESSION, and nothing
              anywhere said how one gets there (right-click the strip's header).
              A hint that teaches half the app is how the other half stays
              undiscovered. */}
          nothing here yet — add a strip, then press REC to record into it, or
          right-click its header to load a session
        </p>
      )}

      <div className="plane-controls" data-no-drag>
        <button type="button" className="plane-add" onClick={onAddStrip} title="add a strip">
          + strip
        </button>
        <button type="button" title="zoom out" onClick={() => zoomAtCentre(1 / 1.2)}>
          −
        </button>
        <span className="value mono" title="zoom">
          {Math.round(view.scale * 100)}%
        </span>
        <button type="button" title="zoom in" onClick={() => zoomAtCentre(1.2)}>
          +
        </button>
        <button type="button" title="reset to 100%" onClick={() => commit({ scale: 1, panX: 0, panY: 0 })}>
          1×
        </button>
        <button type="button" title="frame every strip" onClick={fit}>
          fit
        </button>
        {/* Every action must be reachable without a shortcut — a right-click or
            key that is the ONLY path is how canvas apps become unlearnable
            (pd-plane-playground §6.7). */}
        <button type="button" title="routing ledger (⌘R)" onClick={onOpenMatrix}>
          ⌘R
        </button>
      </div>
    </div>
  )
}
