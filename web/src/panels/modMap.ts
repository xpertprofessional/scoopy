import type { ModSlotState } from "../../protocol/schema.ts";
import type { MenuItem } from "../design/ContextMenu.tsx";

/**
 * "Map to Modifier" — the right-click half of modulation routing (CM-4), an
 * exact mirror of native `lfoMappingMenuItems` (ContentView:3679).
 *
 * This is the DISCOVERABLE/precise path: name a control, pick a channel. The
 * FAST path (arm a channel, then click a control) is MOD-7's arm-to-map. Native
 * ships both and so do we — they are different moments, not two homes for one
 * control: this menu names the CHANNEL from the control, arm-to-map names the
 * CONTROL from the channel.
 *
 * Both ride the same ops (`mapMod` / `unmapMod`), so they cannot drift.
 */

/** `Track.LfoModifierTarget` (Track.swift:708), as `String(describing:)` sends it. */
export type ModTarget =
  | "pitch"
  | "filter"
  | "volume"
  | "pan"
  | "sampleStart"
  | "sampleEnd"
  | "gain"
  | "freeRate";

/**
 * sampleStart/sampleEnd route on M1/M2 ONLY — M3/M4 have no flat depth field
 * for them, and native `mapModifier` REFUSES there (it beeps). Offering M3/M4
 * would be a menu item that looks live and silently does nothing.
 */
export function channelsFor(target: ModTarget): number[] {
  return target === "sampleStart" || target === "sampleEnd" ? [0, 1] : [0, 1, 2, 3];
}

/** Channels this track's `target` is currently routed to. */
export function mappedChannels(target: ModTarget, slots: ModSlotState[]): number[] {
  return channelsFor(target).filter((ch) =>
    slots.some((s) => s.channelIndex === ch && s.target === target),
  );
}

/**
 * The mod section of a box's right-click menu. Native renders a "Map to
 * Modifier" SUBMENU of M1…M4 toggles (✓ = mapped) plus flat "Unmap from M{n}"
 * entries; the web flattens submenus into labelled sections (the established
 * idiom), and the checked toggle IS the unmap — so the redundant flat entries
 * are dropped rather than duplicated.
 *
 * There is deliberately NO optimistic echo: `mapModifier` can REFUSE (per-track
 * cap of 6, or start/end on M3/M4). The slot list re-arrives from Swift, so a
 * refused map simply never appears — the UI never shows a routing that isn't real.
 */
export function buildModMapItems(
  target: ModTarget,
  trackIndex: number,
  slots: ModSlotState[],
  send: (params: Record<string, unknown>) => void,
): MenuItem[] {
  const mapped = mappedChannels(target, slots);
  const items: MenuItem[] = [{ kind: "info", label: "Map to Modifier" }];
  for (const ch of channelsFor(target)) {
    const isMapped = mapped.includes(ch);
    items.push({
      kind: "item",
      label: `M${ch + 1}`,
      checked: isMapped,
      onSelect: () =>
        send({
          op: isMapped ? "unmapMod" : "mapMod",
          trackIndex,
          index: ch,
          mode: target,
        }),
    });
  }
  return items;
}
