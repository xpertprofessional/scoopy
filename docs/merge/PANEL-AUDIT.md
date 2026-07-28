# Panel audit — every scoopy surface, its job, and its door (P3-4-1)

*Measured 2026-07-28 against `App.tsx`'s 19 routes and `MergedMain.cpp`'s
window layer. "Nothing lost" (P3-ROADMAP P3-4) means every panel is either
REACHABLE, its job REHOMED somewhere reachable, or PARKED with the reason
written down — never silently absent.*

Reachable today: **3 of 19** (plane · companion, which embeds filebrowser and
grid · grid again via the in-window Composer). `openPanelWindow` takes any
panel name (MergedMain.cpp:256) — most doors are one string away. The shell
never injects `__slPanelArg`, which FxSlotPanel and InstrumentPanel read; the
door build (P3-4-2) fixes that alongside the menu.

| panel | job | door |
|---|---|---|
| plane | THE app — the merged main surface | ✅ is the main window |
| companion | session library, import/export; embeds filebrowser + grid | ✅ `sessions ⇱` |
| grid | the composer (sequencer editing) | ✅ per-strip `COMPOSE ⇱` + bar `compose` (in-window) |
| filebrowser | the sample library browser | ✅ embedded in companion; no separate door needed now |
| **fxslot** | **the return-FX editor — the CONFIG path P3-3-1 is blocked on** | MECHANICAL, FIRST: menu entry per return slot + `__slPanelArg` injection. Unblocks the returns flip |
| transport | scoopy's master transport (beat-repeat, launch quantize, tempo ramp, keyboard, LCM bar) | MECHANICAL interim: menu entry. Its verbs FOLD into the plane's master per P3-M-1; the panel stays reachable until the fold is complete |
| spectral | the deck-bus creative layer (texture/warp/gesture — the Signalsmith surface) | MECHANICAL: menu entry. Where it LIVES long-term (a strip affordance?) is D-4/D-5 taste; a door loses nothing meanwhile |
| paintmode | grid paint/edit-mode settings | MECHANICAL: menu entry (composer-adjacent) |
| midi | MIDI mapping | MECHANICAL: menu entry |
| perf | performance/spectrum diagnostics | MECHANICAL: menu entry |
| capture | scoopy's capture/takes view | MECHANICAL: menu entry. Overlap with wizard's take system is real — which jobs REHOME onto strips/takes is D-5; the door loses nothing meanwhile |
| general | settings | MECHANICAL: menu, `settings` group |
| audio | audio device settings | MECHANICAL: menu, `settings` group. ⚠️ overlaps the merged host's own device picker — reconciling the two is a D-5 note, not a blocker |
| appearance | themes/looks | MECHANICAL: menu, `settings` group |
| template | new-session templates | MECHANICAL: menu, `settings` group |
| import | import settings | MECHANICAL: menu, `settings` group |
| deckmixer | the DJ mixer surface | MECHANICAL door now; whether it SURVIVES beside the plane (which is the new mixer) is **D-5** |
| djmode | the DJ performance view | MECHANICAL door now; the plane is the new DJ view — survival is **D-5** |
| instrument | per-track plugin picker | **PARKED, with the reason**: `pluginHosting: false` — the merged host runs no plugins until P6. A door to a panel whose every action fails is worse than none. Un-parks with P6 |

## The door build (P3-4-2)

One **panels menu** on the plane bar (`≡`, a `ds-menu` like the strip's ⋯):
every MECHANICAL row above, settings rows grouped under one `settings ▸`
flyout. Plus the `__slPanelArg` injection in `MergedMain.cpp` so fxslot (and
one day instrument) open ADDRESSED. Panel windows already exist
(`openPanelWindow`); the menu is the missing string.

D-5 (MORNING-DECISIONS-2) collects the taste calls this table names:
deckmixer/djmode survival, capture-job rehoming, audio-panel reconciliation,
spectral's long-term home.
