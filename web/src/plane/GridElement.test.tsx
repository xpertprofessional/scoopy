/**
 * P3-U8 — the scene pads tell the truth.
 *
 * Two defects pinned here, both found on the real host (2026-07-29):
 *  1. the pads showed the raw STORAGE letters A–H while every other surface in
 *     the app shows scenes 1-based (`sceneDisplayLabel` — the strip was the
 *     only place in the product where a scene had a letter on its face);
 *  2. the pad count was pure geometry (`scenePadCount`), ignoring the session's
 *     `enabledSceneCount` — a 3-scene session showed 8 pads, 5 of them dead.
 *
 * House SSR pattern (Strip.test.tsx): static markup, no jsdom — what matters is
 * WHICH ELEMENTS EXIST and what their faces say.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { GridScenes } from './GridElement.tsx'
import { newGridElement, newStrip } from './stripOps.ts'
import type { SceneLetter } from '../audio/sceneProjection.ts'

const gridStrip = () => ({
  ...newStrip(0, { x: 0, y: 0 }),
  element: newGridElement(0, 'ses', 120),
})

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <GridScenes
      strip={gridStrip()}
      scene={'A' as SceneLetter}
      queued={null}
      onSelectScene={() => {}}
      {...props}
    />,
  )

const padFaces = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*class="strip-pad[^"]*"[^>]*>([^<]*)<\/button>/g)].map(
    (m) => m[1]!,
  )

describe('P3-U8 · scene pads', () => {
  it('labels pads 1-based, never the storage letter', () => {
    const html = render()
    // All eight (no enabledScenes prop = session not arrived, full fallback).
    expect(padFaces(html)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    // The letter survives as identity (titles key gestures to it via display
    // label too) but never as a face.
    expect(padFaces(html)).not.toContain('A')
  })

  it('renders only the session’s enabled scenes, plus the add slot', () => {
    const html = render({
      enabledScenes: ['A', 'B', 'C'] as SceneLetter[],
      onAddScene: () => {},
    })
    // 3 real pads and the add pad wearing the number it would become — the
    // app’s own add-slot convention (ScenePads / nextSceneLabel).
    expect(padFaces(html)).toEqual(['1', '2', '3', '+4'])
  })

  it('shows no add slot when all eight are enabled — the row is full of real pads', () => {
    const html = render({
      enabledScenes: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as SceneLetter[],
      onAddScene: () => {},
    })
    expect(padFaces(html)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(html).not.toContain('strip-pad-add')
  })

  it('renders the add slot disabled when the affordance is not wired', () => {
    const html = render({ enabledScenes: ['A', 'B'] as SceneLetter[] })
    expect(html).toContain('strip-pad-add')
    expect(html).toMatch(/strip-pad-add[^>]*disabled|disabled[^>]*strip-pad-add/)
  })

  it('keeps active/queued state keyed by the LETTER identity', () => {
    const html = render({
      enabledScenes: ['A', 'B', 'C'] as SceneLetter[],
      scene: 'B' as SceneLetter,
      queued: 'C' as SceneLetter,
    })
    // The face says 2; the class machinery matched on 'B'.
    expect(html).toMatch(/class="strip-pad active"[^>]*>2</)
    expect(html).toMatch(/class="strip-pad queued"[^>]*>3</)
  })
})
