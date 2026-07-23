/**
 * Hot-surface plumbing (docs/ARCHITECTURE.md): per-frame visuals — playhead
 * now; meters/LUFS later — draw in ONE requestAnimationFrame loop that reads
 * the latest HotFrame imperatively. Deliberately outside React/Zustand so
 * 60 fps drawing never re-renders a component tree.
 */
export type HotDrawer = (frame: Float64Array) => void
export type Scheduler = (cb: () => void) => void

let latest: Float64Array | null = null
const drawers = new Set<HotDrawer>()
let running = false
let schedule: Scheduler = (cb) => requestAnimationFrame(cb)

/** Test seam: swap the rAF scheduler. Returns the previous scheduler. */
export function setHotSurfaceScheduler(s: Scheduler): Scheduler {
  const prev = schedule
  schedule = s
  return prev
}

/** Called by the EngineLink hotframe subscription; drawers see it next frame. */
export function publishHotFrame(frame: Float64Array): void {
  latest = frame
}

export function latestHotFrame(): Float64Array | null {
  return latest
}

function pump(): void {
  if (drawers.size === 0) {
    running = false // loop parks itself when the last drawer unregisters
    return
  }
  const frame = latest
  if (frame) for (const d of drawers) d(frame)
  schedule(pump)
}

/**
 * Registers a per-frame drawer; the shared loop runs only while at least one
 * drawer is registered. Returns the unregister function.
 */
export function registerHotDrawer(d: HotDrawer): () => void {
  drawers.add(d)
  if (!running) {
    running = true
    schedule(pump)
  }
  return () => {
    drawers.delete(d)
  }
}
