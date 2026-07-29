# ─────────────────────────────────────────────────────────────────────────────────────────────
# P8-1 / XP-4 — the FIRST non-Xcode build of the ScoopyLoops engine.
#
# Until now the audio core could only be built by Xcode, which meant it could only ever run on a
# Mac: there was no way to compile it for the browser, for CI, or for anything else. This is that
# build. It is deliberately a *library*, not an app — the engine has no main(), no device, no UI.
#
# The core turned out to be one line away from portable. Its only two platform ties were:
#   • `#include <juce_dsp/juce_dsp.h>` — for a Phase 0 SMOKE TEST (an unused filter instance that
#     proved juce_dsp linked). The DSP never touched JUCE. Deleting it cannot change a sample.
#   • `mach_absolute_time()` — kept verbatim on Apple, portable fallback elsewhere.
# Everything else was already plain C++: no vDSP, no Accelerate, no threads, no file I/O, no SIMD
# intrinsics, no plugin host (that is `SCOOPY_PLUGIN_HOST=0`, a configuration the soak target has
# been proving for a long time).
#
#   cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build
#   emcmake cmake -B build-wasm && cmake --build build-wasm      # (P8-1b, needs emsdk)
#
# ⚠️ `-ffp-contract=off` is NOT a style choice (P8-3b). x86/ARM may fuse mul+add into an FMA;
# WASM (without relaxed-SIMD) will not. Leave contraction on and the two platforms take different
# numeric paths through every feedback loop, so a null-test between them can never be clean. And
# NEVER `-ffast-math`: that alone would make the platforms audibly diverge.
# ─────────────────────────────────────────────────────────────────────────────────────────────
cmake_minimum_required(VERSION 3.20)
project(scoopy_engine C CXX)   # C: the vendored pffft (ThirdParty/pffft) is C99

# Windows: the MSVC STL's <cmath> only defines M_PI (used across the DSP TUs) when asked.
# The STATIC runtime is not a style choice: the CI toolset (MSVC 14.5x) references STL exports
# newer than the runner's system MSVCP140.dll, so dynamically-linked gate tools die at load with
# STATUS_ENTRYPOINT_NOT_FOUND — silently (exit 127, ldd clean: the DLL exists, the symbol
# doesn't). Static linking removes the system-redist dependency for these standalone tools.
if(WIN32)
    add_compile_definitions(_USE_MATH_DEFINES)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# THE CORE IS IN-TREE NOW (P3-0 step 2, 2026-07-27) — it was a sibling of this
# directory under vendor/scoopy while hash-pinned. This tree is its writable
# home; scoopy's own tests read ScoopyLoops/* from the repo root and were the
# thing that said so out loud.
set(SRC ${CMAKE_SOURCE_DIR}/ScoopyLoops)

# The core + every DSP block. Each of these compiles with no platform headers at all — verified by
# this build existing. The HOST layer (NativeJuceDeviceHost, NativeMidiHost, NativeAudioEngineBridge,
# NativePluginHost) is deliberately ABSENT: it is meaningless in a browser and is deleted, not
# ported. `render()` is already an AudioWorklet callback in all but name.
add_library(scoopy_engine STATIC
    ${SRC}/NativeAudioEngineCore.cpp
    ${SRC}/NativeBusStretcher.cpp
    ${SRC}/NativeDigitalDelay.cpp
    ${SRC}/NativeMasterClipper.cpp
    ${SRC}/NativeMasterDrive.cpp
    ${SRC}/NativeMasterSaturation.cpp
    # NativeMidiClockOut / NativeMidiNoteOut are ABSENT: they are MIDI *hardware* output, they run
    # a scheduling thread on mach_wait_until, and a browser has neither. The core's two call sites
    # are guarded by SCOOPY_MIDI_HARDWARE, so nothing references them.
    ${SRC}/NativeToneFilter.cpp
    ${SRC}/NativeTrackClipper.cpp
    ${SRC}/NativeVoiceStretchPool.cpp
)

target_include_directories(scoopy_engine PUBLIC
    ${SRC}
    # Sources say `#include <Signalsmith/signalsmith-stretch.h>`, so the SEARCH ROOT is ThirdParty/.
    ${CMAKE_CURRENT_SOURCE_DIR}/../ThirdParty
    ${CMAKE_CURRENT_SOURCE_DIR}/../ThirdParty/Signalsmith
)

# ─────────────────────────────────────────────────────────────────────────────────────────────
# P6-1 — the AU/VST3 plugin host compiles IN (D-WZ-PDC-01 opened the gate).
#
# The flag is PUBLIC because it changes the core's class layout (the return/instrument slot
# members exist only when set), so every TU in a binary must agree on it. ON by default only
# where the host can exist: a native Apple build. A browser cannot host an AU (EMSCRIPTEN
# stays OFF and ships the complete no-op fallback, as before), and the .mm is Obj-C++
# (Windows/Linux CI stays OFF, exactly the configuration the soak target always proved).
#
# The LIBRARY stays JUCE-free either way. With the flag ON, the core calls into the
# NativePluginSlot/NativeInstrumentSlot surface, whose symbols come from one of TWO builds of
# the SAME ScoopyLoops/NativePluginHost.mm:
#   • the app target (shell/) compiles it as Obj-C++ with SCOOPY_PLUGIN_HOST=1 + JUCE — real.
#   • scoopy_plugin_host_stub (below) compiles its #else branch as plain C++ — every method a
#     no-op, byte-for-byte the audio behavior the flag-OFF build had (host-mode returns render
#     silence with no plugin loaded; the DSP gates were re-run to prove it).
# The stub rides scoopy_engine's PUBLIC link interface, so lazy archive semantics do the
# dispatch: the app's real object file defines the symbols first and the stub is never pulled;
# the headless gate tools have no real object, pull the stub, and link without JUCE.
# ─────────────────────────────────────────────────────────────────────────────────────────────
if(APPLE AND NOT EMSCRIPTEN)
    set(_scoopy_plugin_host_default ON)
else()
    set(_scoopy_plugin_host_default OFF)
endif()
option(SCOOPY_PLUGIN_HOST_ENABLED
    "Compile the core with the AU/VST3 plugin-host surface (Apple native only)"
    ${_scoopy_plugin_host_default})

if(SCOOPY_PLUGIN_HOST_ENABLED)
    set(_scoopy_plugin_host 1)
else()
    set(_scoopy_plugin_host 0)
endif()

target_compile_definitions(scoopy_engine PUBLIC
    SCOOPY_PLUGIN_HOST=${_scoopy_plugin_host}
    # No CoreMIDI. Same idea, same shape: the engine keeps calling `sendRaw` and the bytes go
    # nowhere. WebMIDI is Chromium-only and sending clock to hardware is not part of composing
    # away from the studio.
    SCOOPY_MIDI_HARDWARE=0
)

if(SCOOPY_PLUGIN_HOST_ENABLED)
    # The no-op fallback half of NativePluginHost.mm, compiled as plain C++ (the #else branch
    # has no Obj-C and no JUCE) with the flag forced OFF for this one TU. Deliberately NOT
    # linked against scoopy_engine — that would re-import the PUBLIC =1 define and select the
    # JUCE branch this target exists to avoid.
    add_library(scoopy_plugin_host_stub STATIC ${SRC}/NativePluginHost.mm)
    set_source_files_properties(${SRC}/NativePluginHost.mm PROPERTIES LANGUAGE CXX)
    target_compile_definitions(scoopy_plugin_host_stub PRIVATE SCOOPY_PLUGIN_HOST=0)
    target_include_directories(scoopy_plugin_host_stub PRIVATE ${SRC})
    target_link_libraries(scoopy_engine PUBLIC scoopy_plugin_host_stub)
endif()

# See the header: this is a CORRECTNESS flag for cross-platform null-testing, not an optimisation
# preference. `-ffast-math` is banned outright.
target_compile_options(scoopy_engine PRIVATE
    -ffp-contract=off
    -Wall
    -Wno-unused-parameter
)

if(EMSCRIPTEN)
    # Signalsmith's only Apple tie is its FFT backend, and it is ONE define
    # (SIGNALSMITH_USE_ACCELERATE, set for the Xcode target). Unsetting it selects Signalsmith's
    # OWN portable FFT — the algorithm and the quality are unchanged, only the speed.
    #
    # WASM stays on that scalar path FOR NOW: switching the worklet to pffft (vendored below,
    # XP-0c) is P8-3c and must be MEASURED in a real browser (the P3-02 perf-harness method),
    # not assumed.
    target_compile_options(scoopy_engine PRIVATE -msimd128)
endif()

# ─────────────────────────────────────────────────────────────────────────────────────────────
# XP-0c — the pffft FFT backend for non-Apple NATIVE targets (Windows/Linux).
#
# pffft IS vendored now (ThirdParty/pffft, single-precision subset — see its VERSION.md; the old
# warning that it wasn't has been retired). Without it, a Windows/Linux build would run
# Signalsmith's scalar FFT — a silent CPU regression, not a build error.
#
# Selection: Apple keeps its defaults (Xcode = Accelerate; this CMake build = Signalsmith's own
# FFT), EMSCRIPTEN stays scalar until P8-3c measures it. Everything else gets pffft.
# SCOOPY_FORCE_PFFFT exists so the mac build can A/B the pffft path through the DSP gates —
# that A/B (all gates green + null-test residual vs the default build) is exactly how this
# wiring was verified.
# ─────────────────────────────────────────────────────────────────────────────────────────────
option(SCOOPY_FORCE_PFFFT "Use the vendored pffft FFT backend even on Apple/WASM (A/B gating)" OFF)
if((NOT APPLE AND NOT EMSCRIPTEN) OR SCOOPY_FORCE_PFFFT)
    target_sources(scoopy_engine PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/../ThirdParty/pffft/pffft.c
        ${CMAKE_CURRENT_SOURCE_DIR}/../ThirdParty/pffft/pffft_common.c
    )
    # The Signalsmith wrapper includes "pffft/pffft.h", which resolves via the ThirdParty/
    # include dir already on the target; pffft.c's own quoted includes resolve file-relative.
    target_compile_definitions(scoopy_engine PUBLIC SIGNALSMITH_USE_PFFFT=1)
    # pffft builds INTO this static lib. Without PFFFT_STATIC_DEFINE, pffft.h on Windows
    # decorates the API __declspec(dllimport) and the implementation TU fails to compile.
    target_compile_definitions(scoopy_engine PUBLIC PFFFT_STATIC_DEFINE)
    # marton78's fork gates NEON behind an explicit opt-in (pf_neon_float.h line 39) — without
    # this, arm64 silently builds the SCALAR path and the whole point of vendoring is lost.
    # SSE1 self-selects from arch macros, and this define still checks them, so x86 is unaffected.
    target_compile_definitions(scoopy_engine PRIVATE PFFFT_ENABLE_NEON=1)
endif()

# ─────────────────────────────────────────────────────────────────────────────────────────────
# P8-3b — the NULL TEST target. Renders a fixed, deliberately hostile scene offline and dumps raw
# float32. Run it on macOS and in WASM, subtract the two (tools/null_test.py), and the residual is
# the honest answer to "does the browser sound the same".
#
# Not built for WASM as a native executable — there `emcc` emits a .js/.wasm pair run under node.
# ─────────────────────────────────────────────────────────────────────────────────────────────
add_executable(scoopy_render_null tools/render_null.cpp)
target_link_libraries(scoopy_render_null PRIVATE scoopy_engine)

# ─────────────────────────────────────────────────────────────────────────────────────────────
# P8-3 — the DENORMAL gate. Deliberately a SEPARATE target from the null test, because the null
# test cannot express this defect: it measures peak residual (−80 dB), and a subnormal lives below
# −760 dBFS. See tools/denormal_test.cpp for why that comparison was blind, and blind three ways.
#
# It links `scoopy_engine` and nothing else — so, exactly like WASM, it runs with NO FTZ. That is
# the point: this native binary is a faithful proxy for the browser's numeric environment.
# ─────────────────────────────────────────────────────────────────────────────────────────────
add_executable(scoopy_denormal_test tools/denormal_test.cpp)
target_link_libraries(scoopy_denormal_test PRIVATE scoopy_engine)

if(EMSCRIPTEN)
    # The same appetite scoopy_render_null has, and for the same reason — the engine wants a big
    # stack, and WASM's default (64 KB) blows up as `memory access out of bounds` rather than as
    # anything that names a stack. This target has no file output, so it needs no NODERAWFS.
    #
    # Running the gate HERE, not just natively, is the point: WASM is the platform with no FTZ, so
    # it is the one whose tails were actually unprotected.
    target_link_options(scoopy_denormal_test PRIVATE
        -sALLOW_MEMORY_GROWTH=1
        -sSTACK_SIZE=16777216
    )
endif()

# ─────────────────────────────────────────────────────────────────────────────────────────────
# C0 — the DSP CHARACTERISATION gates. Neither the null test nor the denormal test can grade a
# deliberate sound change: the null test measures "did it change" (a clipper is SUPPOSED to), and
# the denormal test measures a CPU defect. These two measure QUALITY — magnitude response and
# modulation transient for the filter, alias-vs-harmonic energy for the clipper.
#
# They link `scoopy_engine` and instantiate the DSP structs directly — no core, no snapshot, no
# device. That is what makes them fast enough to run on every commit.
# ─────────────────────────────────────────────────────────────────────────────────────────────
add_executable(scoopy_filter_test tools/filter_test.cpp)
target_link_libraries(scoopy_filter_test PRIVATE scoopy_engine)

add_executable(scoopy_clipper_test tools/clipper_test.cpp)
target_link_libraries(scoopy_clipper_test PRIVATE scoopy_engine)

# C6 — the HEADROOM gate. Unlike the two above it drives the real core's summing bus, because the
# thing it measures (what happens to a mix that is genuinely too loud) exists nowhere else: the null
# test's scene peaks at 0.084 and the clipper harness never runs the core at all.
add_executable(scoopy_headroom_test tools/headroom_test.cpp)
target_link_libraries(scoopy_headroom_test PRIVATE scoopy_engine)

# Choke-deferral gate — drives the real sequencer with two tracks in one choke group and reads the
# sum to prove the onset-aware cross-track choke. Links the core only (no device); fast per-commit.
add_executable(scoopy_choke_defer_test tools/choke_defer_test.cpp)
target_link_libraries(scoopy_choke_defer_test PRIVATE scoopy_engine)

# Scene-switch timing gate — drives the REALTIME render() path (the parked-world install machinery
# renderOffline bypasses) to prove the sample-exact boundary install, the scene glide, and the
# clean cut. Links the core only (no device); fast per-commit.
add_executable(scoopy_scene_switch_test tools/scene_switch_test.cpp)
target_link_libraries(scoopy_scene_switch_test PRIVATE scoopy_engine)

# Rate-morph timing gate — drives the realtime trigger loop to prove the multiply glide: OFF is
# the instant stateless switch, a ramp bends inter-onset intervals and ringing-voice pitch
# smoothly, and every morph lands back on the canonical (stateless) grid. Core only; per-commit.
add_executable(scoopy_rate_morph_test tools/rate_morph_test.cpp)
target_link_libraries(scoopy_rate_morph_test PRIVATE scoopy_engine)

# Mute-immediacy gate — proves the mixer-true mute split: mixMuted kills RINGING audio in ~4 ms
# (main + pre-fader send) and unmutes mid-cell, while `muted` (the stop/pause lane) still only
# gates future triggers. Realtime render() path; links the core only; fast per-commit.
add_executable(scoopy_mute_immediacy_test tools/mute_immediacy_test.cpp)
target_link_libraries(scoopy_mute_immediacy_test PRIVATE scoopy_engine)

# Track-mix-level (SIG-3) gate — proves the per-track activity meter behind the track-row LED:
# the level rises while a track sounds, reads 0 for a mixMuted track, and decays to silence
# (~-60 dB in 300 ms) after the audio ends. Realtime render() path; links the core only.
add_executable(scoopy_track_mix_level_test tools/track_mix_level_test.cpp)
target_link_libraries(scoopy_track_mix_level_test PRIVATE scoopy_engine)

if(EMSCRIPTEN)
    # NODERAWFS lets the same main() write its dump straight to disk under node, so the harness is
    # ONE program on both platforms rather than two that could drift apart.
    target_link_options(scoopy_render_null PRIVATE
        -sNODERAWFS=1
        -sALLOW_MEMORY_GROWTH=1      # whole samples land as std::vector<float>
        # ⚠️ The engine needs a BIG stack — WASM's default (64 KB) and even 1 MB overflow. macOS
        # gives 8 MB by default and the overflow was therefore invisible there. This is a real
        # portability constraint on the AudioWorklet, not a bug: measure it, do not guess it.
        -sSTACK_SIZE=16777216
    )
endif()

# ─────────────────────────────────────────────────────────────────────────────────────────────
# XP-5 / P8-2 — the C ABI, and the WASM module the AudioWorklet loads.
#
# Phase 7 recorded "there is no C ABI today", and there wasn't: every caller was Swift reaching
# into C++ through an Objective-C++ bridge, which works exactly once — on a Mac. `sl_engine.h` is
# the boundary the engine actually needed, and Emscripten exports it straight to JS, so the
# worklet calls the SAME functions any future host would.
# ─────────────────────────────────────────────────────────────────────────────────────────────
add_library(sl_engine STATIC src/sl_engine.cpp)
target_include_directories(sl_engine PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(sl_engine PUBLIC scoopy_engine)
target_compile_options(sl_engine PRIVATE -ffp-contract=off)

if(EMSCRIPTEN)
    add_executable(scoopy_engine_wasm src/sl_engine.cpp)
    target_link_libraries(scoopy_engine_wasm PRIVATE scoopy_engine)
    target_include_directories(scoopy_engine_wasm PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
    set_target_properties(scoopy_engine_wasm PROPERTIES OUTPUT_NAME "scoopy-engine")
    target_link_options(scoopy_engine_wasm PRIVATE
        # MODULARIZE + ES6 so an AudioWorklet can `import` it. A worklet has no `window`, no
        # `fetch` and no `document` — the classic Emscripten glue assumes all three.
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createScoopyEngine
        -sENVIRONMENT=web,worker,node
        # The engine has no main(); it is a library.
        --no-entry
        -sEXPORTED_FUNCTIONS=_sl_engine_create,_sl_engine_destroy,_sl_engine_configure,_sl_engine_start,_sl_engine_stop,_sl_engine_register_sample,_sl_snapshot_begin,_sl_snapshot_track_begin,_sl_snapshot_track_set,_sl_snapshot_track_set_array,_sl_snapshot_track_end,_sl_param_id,_sl_array_param_id,_sl_snapshot_commit,_sl_render,_sl_engine_set_main_gain,_sl_engine_abi_version,_malloc,_free
        -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,HEAPF64,ccall,cwrap
        -sALLOW_MEMORY_GROWTH=1
        # See scoopy_render_null: the engine wants a big stack. macOS gives 8 MB by default, so the
        # appetite was invisible there — in a worklet it must be asked for.
        -sSTACK_SIZE=16777216
        # A worklet cannot fetch a sidecar .wasm; embed it so the module is ONE file to load.
        -sSINGLE_FILE=1
    )
endif()

# ─────────────────────────────────────────────────────────────────────────────────────────────
# P8-10(a) — the ABI FIDELITY gate. Neither the null test nor the browser gate can see this: the
# null test never touches the C ABI, and the browser gate compares two things that are BOTH behind
# it. This renders one scene twice with one renderer — full snapshot vs the twelve fields the ABI
# can express — so any residual is the ABI's field loss and nothing else.
# ─────────────────────────────────────────────────────────────────────────────────────────────
add_executable(scoopy_abi_fidelity_test tools/abi_fidelity_test.cpp)
# Links sl_engine, not just the core: this test drives the REAL C ABI (the boundary under test), so
# re-implementing it here would only prove that the same code can be written twice.
target_link_libraries(scoopy_abi_fidelity_test PRIVATE sl_engine scoopy_engine)
if(EMSCRIPTEN)
    # Same appetite as the worklet build (see scoopy_engine_wasm above): the engine wants a big
    # stack, and the emscripten default (~64 KB) dies as "memory access out of bounds" before the
    # first render — which is a harness failure, not a fidelity failure.
    target_link_options(scoopy_abi_fidelity_test PRIVATE -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=16777216)
endif()
