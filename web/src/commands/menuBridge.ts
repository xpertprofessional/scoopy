/**
 * MB-3 — the registry's WIRE legs (see registry.ts for the model).
 *
 *   publish:  menuTree(state, sections) → `publishMenuTree` → Swift caches it
 *             (WebMenuRegistry) and — MB-4 — renders the NSMenu from it.
 *   select:   NSMenu item picked → `menuCommand {id}` event → runCommand here.
 *
 * The HOST page provides `state()` and declares the `sections` it can honestly
 * evaluate (a section is the unit of adoption — the compose grid does not know
 * `djMode`, so it does not publish DJ). Publishing happens on the host's cue
 * (`publish()`), on structural or label-relevant change only — never per frame.
 *
 * `runCommand` re-checks enablement at selection time, so a stale shell menu
 * cannot execute through us; an unknown id is refused the same way (a shell
 * from a newer tree must not crash an older page).
 */
import { EngineEvent } from "../../protocol/schema";
import type { EngineLink } from "../engineLink";
import {
  COMMANDS,
  MENU_SECTIONS,
  menuTree,
  runCommand,
  type CommandId,
  type CommandState,
  type MenuSection,
} from "./registry";

export interface MenuBridgeHost {
  state: () => CommandState;
  /** Sections this host can honestly evaluate. */
  sections?: readonly MenuSection[];
}

export interface MenuBridge {
  /** Re-evaluate and publish the tree (diffed — identical trees are skipped). */
  publish: () => void;
  detach: () => void;
}

const KNOWN_IDS = new Set<string>(COMMANDS.map((c) => c.id));

export function attachMenuBridge(link: EngineLink, host: MenuBridgeHost): MenuBridge {
  const sections = host.sections ?? MENU_SECTIONS;
  let lastPublished = "";

  const publish = () => {
    const tree = menuTree(host.state(), sections);
    const payload = JSON.stringify(tree);
    if (payload === lastPublished) return;
    lastPublished = payload;
    link.command("publishMenuTree", { sections: tree }).catch(() => {
      // A failed publish must not latch the diff — retry on the next cue.
      lastPublished = "";
    });
  };

  const offEvent = link.onEvent((evt) => {
    const parsed = EngineEvent.safeParse(evt);
    if (!parsed.success || parsed.data.type !== "menuCommand") return;
    const id = parsed.data.id;
    if (!KNOWN_IDS.has(id)) {
      console.warn(`[menu-bridge] unknown command id refused: ${id}`);
      return;
    }
    runCommand(id as CommandId, host.state());
    // State the command just changed (undo depth, isPlaying…) alters the tree.
    publish();
  });

  publish();
  return {
    publish,
    detach: () => offEvent(),
  };
}
