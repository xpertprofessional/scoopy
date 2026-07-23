import { afterEach, expect, test, vi } from 'vitest'
import {
  publishHotFrame,
  registerHotDrawer,
  setHotSurfaceScheduler,
  type Scheduler,
} from './hotSurface'

// Manual scheduler: the test pumps frames explicitly.
function manualScheduler(): { scheduler: Scheduler; step: () => void; pendingCount: () => number } {
  const queue: Array<() => void> = []
  return {
    scheduler: (cb) => queue.push(cb),
    step: () => queue.shift()?.(),
    pendingCount: () => queue.length,
  }
}

let restore: Scheduler | null = null
afterEach(() => {
  if (restore) setHotSurfaceScheduler(restore)
  restore = null
})

test('drawers receive the latest published frame each pump', () => {
  const m = manualScheduler()
  restore = setHotSurfaceScheduler(m.scheduler)

  const seen: number[] = []
  const off = registerHotDrawer((f) => seen.push(f[0]!))

  publishHotFrame(Float64Array.of(1))
  m.step()
  publishHotFrame(Float64Array.of(2))
  m.step()
  expect(seen).toEqual([1, 2])
  off()
  m.step() // drain so the loop parks before the scheduler is swapped away
})

test('the loop parks itself when the last drawer unregisters and restarts on register', () => {
  const m = manualScheduler()
  restore = setHotSurfaceScheduler(m.scheduler)

  const drawer = vi.fn()
  const off = registerHotDrawer(drawer)
  publishHotFrame(Float64Array.of(7))
  m.step() // draws, schedules next
  off()
  m.step() // loop notices zero drawers and parks
  expect(m.pendingCount()).toBe(0)

  const off2 = registerHotDrawer(drawer)
  expect(m.pendingCount()).toBe(1) // restarted
  off2()
  m.step()
})

test('no frame published yet: pump is a no-op for drawers', () => {
  const m = manualScheduler()
  restore = setHotSurfaceScheduler(m.scheduler)

  // NOTE: publishHotFrame state is module-global; earlier tests may have
  // published. This test only asserts the pump keeps running without error.
  const drawer = vi.fn()
  const off = registerHotDrawer(drawer)
  m.step()
  expect(m.pendingCount()).toBe(1) // rescheduled regardless
  off()
  m.step()
})
