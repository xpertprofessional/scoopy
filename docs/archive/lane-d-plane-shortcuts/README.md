# lane/d — the plane's shortcut list, parked

**Archived 2026-08-02 (S0 of the Scoopy Studio pivot), before `scoopy-lane-d`'s worktree
was removed.** This was *uncommitted* work in that worktree: `git worktree remove` would
have destroyed it with no trace, and the branch `lane/d` is 0 commits ahead of
`host-hygiene`, so nothing else holds it.

History, never a spec — `docs/archive/` always is. Nothing here is the design for S11.

## What it was

`P7-K4` — the shortcut list gets a door. A port of the shipping app's
`ScoopyLoops/ShortcutListView.swift` + `ShortcutsWindowController.swift`
(Help ▸ Keyboard Shortcuts…), rendering `web/src/commands/keymap.ts` as a panel on
**the plane**. The plane is frozen by `D-SL-STUDIO-01`, so the door it built is a door
onto a surface that no longer receives work.

## Contents

| File | What |
|---|---|
| `Shortcuts.tsx` | the panel, verbatim (258 lines) |
| `shortcuts.test.ts` | its test, verbatim (120 lines) |
| `tracked-changes.patch` | the three tracked edits: `commands/keymap.test.ts`, `plane/PlanePanel.tsx` (the door), `plane/plane.css` (107 lines of styling) |

The two `.tsx`/`.ts` files are stored as **files, not as patch hunks**, deliberately —
see below.

## ⚠️ `Shortcuts.tsx` contains a raw NUL byte

One `\x00` at **byte 6142, line 129**, inside a template literal used as a key separator:

```ts
id: `${section.title}\x00${e.keys}`,
```

It is a real byte in the source, not an escape. Consequences:

- **git treats the file as binary**, so `git diff` emits
  `Binary files /dev/null and b/…/Shortcuts.tsx differ` and carries **none** of the
  content. That is why this directory stores the file rather than a patch — a plain
  text patch of this work is silently empty for its largest file.
- It is the exact trap `CLAUDE.md` records as a *known non-bug elsewhere*:
  `SAMPLE_DRAG_TEXT_TAG` in `panels/FileBrowserPanel.tsx` uses `\u0001` sentinels and the
  rule there is **"keep them escaped, never as raw bytes."** This file broke that rule.

**If any of this is ever revived, escape it first** (`\u0000`, or better, pick a separator
that is not a control character at all).

## What survives this, and where it goes instead

The keymap itself — `web/src/commands/keymap.ts`, which declares every chord with a
`KeyContext` — is untouched by all of the above and is live at HEAD. It is the input to
**S11** of the Studio plan, where the dispatcher gets built over
`global · compose · grid · browserFocus · noteKeyboard` and the `dj` context is dropped.
A shortcut list rendered from that keymap belongs on the Studio face, not the plane.
