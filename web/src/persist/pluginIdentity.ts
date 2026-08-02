/**
 * WHICH PLUGIN ON *THIS* MACHINE IS THE ONE THE SESSION MEANT (S6 · D-SL-PRESET-01).
 *
 * A session records `instrumentPluginIdentifier` — JUCE's
 * `createIdentifierString`, which encodes the FORMAT. Carry that session to
 * another machine, or install the VST3 where the AU used to be, and the exact
 * string stops matching while the plugin the musician meant is sitting right
 * there. `instrumentPluginRef` is the format-agnostic identity that survives
 * that, and this is the ladder that uses it.
 *
 * A DIRECT PORT of `BeatSequencer.resolveInstrumentIdentifier`
 * (`../scoopyloops/ScoopyLoops/BeatSequencer.swift:19809`), rung for rung. Not a
 * reinterpretation: the order is the whole content, and a different order is a
 * different answer on exactly the machines where it matters.
 *
 * ⚠️ IT NEVER MUTATES THE TRACK, which is the rule the donor states at the call
 * site and the one most likely to be "improved" away. The document keeps the
 * binding it was authored with, so carrying the session BACK to the machine that
 * made it resolves exactly again. Rewriting the stored identifier to whatever
 * resolved here would quietly rebind the session to this machine's plugin set
 * the first time it was opened somewhere else.
 *
 * ⚠️ AND A NIL ANSWER IS "INERT BUT PRESERVED", never "drop it". Nothing on this
 * machine can stand in, so the track does not sound — and the binding stays in
 * the file. A session that forgets is worse than one that cannot play.
 *
 * The permanent caveat, verbatim from `PortablePluginIdentityTests.swift`:
 * `instrumentPluginStateBase64` is deliberately NOT part of this contract.
 * Crossing formats keeps the BINDING and may lose the plugin's internal preset.
 * That is a cross-platform fact, not a bug to fix here.
 */

/** The format-agnostic identity, as `patternFile.ts` already persists it. */
export interface PortablePluginRef {
  manufacturer: string
  name: string
  version: string
  /** Per-format identifiers, filed under the format that produced them. */
  au?: string
  vst3?: string
  clap?: string
}

/** What a scan reports. `listPlugins`/`listInstruments` shape. */
export interface ScannedPlugin {
  identifier: string
  name: string
  manufacturer: string
}

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * The identifier to hand the engine for this track, or `null` when nothing here
 * can stand in for it.
 *
 * FOUR RUNGS, in the donor's order:
 *   1. no stored identifier at all → null. The track was never bound.
 *   2. the exact identifier is installed → use it. The common case, and the
 *      only one that guarantees the same binary.
 *   3. no portable ref → null. Pre-v32 sessions have nothing to search WITH,
 *      and guessing from a bare format-encoded string is how you load somebody
 *      else's plugin that happens to share a name.
 *   4. the ref's own per-format hints, then manufacturer+name in ANY format.
 *
 * VERSION IS DELIBERATELY NOT MATCHED. The donor omits it and that is a choice:
 * an updated plugin is still the plugin the musician meant, and refusing it
 * would make every vendor update silence a session.
 */
export function resolveInstrumentIdentifier(
  stored: string | null | undefined,
  ref: PortablePluginRef | null | undefined,
  available: readonly ScannedPlugin[],
): string | null {
  if (!stored) return null
  if (available.some((p) => p.identifier === stored)) return stored
  if (!ref) return null

  // The hints in the donor's order — au, vst3, clap. Order matters only when a
  // machine has more than one format of the same plugin installed, and then it
  // is a preference rather than a correctness question; keeping the donor's
  // means both apps pick the same one.
  for (const hint of [ref.au, ref.vst3, ref.clap]) {
    if (hint && available.some((p) => p.identifier === hint)) return hint
  }

  // Case-insensitive on BOTH fields, as the donor is: vendors are not
  // consistent about capitalisation between formats, and a case difference
  // here would look exactly like "the plugin is not installed".
  const sameName = available.find(
    (p) => sameText(p.manufacturer, ref.manufacturer) && sameText(p.name, ref.name),
  )
  return sameName?.identifier ?? null
}

/**
 * Build the portable identity for a plugin that is installed here, so a session
 * saved on this machine can be resolved on another.
 *
 * The id is filed under its OWN format's hint slot — that is what makes the
 * ladder's rung 4 work later, when this machine's format is the one missing.
 */
export function portableRefFor(
  plugin: ScannedPlugin,
  format: 'au' | 'vst3' | 'clap',
  version = '',
): PortablePluginRef {
  return {
    manufacturer: plugin.manufacturer,
    name: plugin.name,
    version,
    [format]: plugin.identifier,
  }
}
