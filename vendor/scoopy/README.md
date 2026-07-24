# vendor/scoopy — hash-pinned copy of scoopy's portable core

**Do not edit anything under this directory.** The ONLY writable home of the
engine core is `apps/scoopy` (dual-home law, until the P3 flip). Every path
here is pinned by `../../engine.lock.json`; CI runs `npm run engine:check`
(web/), so a local edit fails the build as `drift`.

To pick up core changes made in `apps/scoopy`:

    cd web && npm run engine:sync    # recopies + repins at scoopy HEAD

Contents (the set is the transitive include closure of scoopy's
`engine/CMakeLists.txt` portable build, verified by depfile walk + a
standalone build of this copy — all ten DSP/ABI gate binaries green):

- `ScoopyLoops/Native*.{hpp,cpp}` — the portable core + DSP blocks (host
  layer deliberately absent, exactly as scoopy's engine build defines it)
- `engine/` — the C-ABI tier: `sl_engine.h/.cpp`, gate tools, CMake recipe
- `ThirdParty/Signalsmith`, `ThirdParty/pffft` — the core's only deps here
  (libsamplerate is vendored separately via shared.lock.json)

The relative layout mirrors scoopy's repo on purpose: `engine/CMakeLists.txt`
builds this copy verbatim (`-S vendor/scoopy/engine`).
