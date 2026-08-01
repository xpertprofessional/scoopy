# SL ABI v3 — the merged engine's C surface (docs/merge/SL-ABI-V3.md).
#
# Links the vendored scoopy CORE and deliberately NOT the vendored v2 C ABI
# (vendor/scoopy/engine's `sl_engine` target). v3 reuses v2's spellings with
# different signatures, so the two can never share a link line; keeping the v2
# target off this dependency chain also keeps its include directory off this
# target's search path, so "sl_engine.h" here unambiguously means v3.
#
# Target name is wz_sl_engine because the vendored v2 library already owns the
# CMake target name `sl_engine`. The C symbols are the ones that matter and
# those are v3's; the target name is just a build-system label.
# sl_tape.cpp is the §5 transplant of wizard's deck subsystem (a donor, not a
# survivor). It depends on nothing but libstdc++ — no core headers, no
# libsamplerate — which is why the port was a lift rather than an extraction.
add_library(wz_sl_engine STATIC
    src/sl_engine.cpp src/sl_tape.cpp src/sl_channel.cpp src/sl_watchdog.cpp)
target_include_directories(wz_sl_engine PUBLIC include)
# generated/ holds the derived track-param mapping (PRIVATE: an implementation
# detail, resolved by name across the ABI).
target_include_directories(wz_sl_engine PRIVATE generated)

# scoopy_engine is PUBLIC: the core's headers are an implementation detail of
# this tier, but the static lib must stay on consumers' link line.
target_link_libraries(wz_sl_engine PUBLIC scoopy_engine)

# The same correctness flag the core is built with. NOT an optimisation
# preference: with contraction on, x86/ARM may fuse mul+add into an FMA while
# WASM will not, and the platforms then take different numeric paths through
# every feedback loop — which makes a cross-platform null test impossible.
target_compile_options(wz_sl_engine PRIVATE -ffp-contract=off)

add_executable(sl_abi_v3_test tools/sl_abi_v3_test.cpp)
target_link_libraries(sl_abi_v3_test PRIVATE wz_sl_engine)
add_test(NAME sl_abi_v3_test COMMAND sl_abi_v3_test)

# The generated track-param mapping: proves it compiles and that values land in
# the field the NAME resolves to. The generator proves completeness; this proves
# the transcription is real. Includes the .inc directly (no library) — it is a
# fragment, not a translation unit.
add_executable(track_params_test tools/track_params_test.cpp)
target_include_directories(track_params_test PRIVATE generated)
target_link_libraries(track_params_test PRIVATE scoopy_engine)
target_compile_options(track_params_test PRIVATE -ffp-contract=off)
add_test(NAME track_params_test COMMAND track_params_test)

# The host-grid launch gate (D-SL-DECKPLUGIN-03). Its OWN binary rather than a
# section of sl_snapshot_test: it needs several independently-clocked engines,
# and that test's whole body shares one.
add_executable(sl_host_launch_test tools/sl_host_launch_test.cpp)
target_link_libraries(sl_host_launch_test PRIVATE wz_sl_engine)
target_include_directories(sl_host_launch_test PRIVATE generated)
add_test(NAME sl_host_launch_test COMMAND sl_host_launch_test)

# §6 session snapshots: name resolution across the ABI, the refused deck axis,
# and the thing that matters most — a committed world with a registered sample
# renders non-silence.
add_executable(sl_snapshot_test tools/sl_snapshot_test.cpp)
target_link_libraries(sl_snapshot_test PRIVATE wz_sl_engine)
# generated/ for the HotFrame slot enum: the deck-param tests observe a deck's
# tempo through its published playhead step rather than reading the param back.
target_include_directories(sl_snapshot_test PRIVATE generated)
add_test(NAME sl_snapshot_test COMMAND sl_snapshot_test)

# The generated HotFrame layout compiles and matches scoopy's schema indices.
add_executable(sl_hotframe_test tools/sl_hotframe_test.cpp)
target_include_directories(sl_hotframe_test PRIVATE generated)
add_test(NAME sl_hotframe_test COMMAND sl_hotframe_test)

# The HotFrame emitter: engine telemetry -> the frame at the schema's indices.
add_executable(sl_hotframe_emit_test tools/sl_hotframe_emit_test.cpp)
target_link_libraries(sl_hotframe_emit_test PRIVATE wz_sl_engine)
add_test(NAME sl_hotframe_emit_test COMMAND sl_hotframe_emit_test)

# §5 TAPE — the acceptance suite for the transplant. These are wizard's own deck
# fixtures re-pointed at sl_tape_*, which is deliberate: the donor's tests are
# what pin the semantics the transplant promised to carry, so a behaviour that
# survived the rename has to prove it against the same assertions it always did.
# sl_tape_mix_record_test is the one genuinely NEW fixture — it covers the
# record-source abstraction wizard had no equivalent for.
foreach(t
    sl_tape_test              # playback: load, loop wrap, one-shot, retrigger, stop
    sl_tape_transport_test    # seek + turntable scrub (Law: rate derived from the gap)
    sl_tape_handoff_test      # LAW C-3 — same-block record→loop handoff
    sl_tape_record_test       # capture, the 256 MB cap, the drain, LAW C-2 stamps
    sl_tape_overdub_test      # D-WZ-OVERDUB-01 SUM/REPLACE + refusals + drain regression
    sl_tape_varispeed_test    # identity bit-exactness at ±1, reverse, wrap
    sl_tape_stretch_test      # P3-2b-5: 2× timeline with pitch HELD (timeStretch)
    sl_tape_insert_test       # control-thread splice
    sl_tape_mix_record_test   # NEW: record the main mix, same-block, honest stamp
    sl_channel_test           # the uniform channel + the channel-bus record tap
    sl_route_test             # ordered routing, feedback edges, click-free re-patch
    sl_deckout_test           # P3.5-E3: a grid deck reaches a looper strip, audibly
    sl_watchdog_test          # guard G1: a runaway feedback loop stays bounded
    sl_perf_test              # P3.5-E10b: 3 decks stretched, inside a realtime budget
)
    add_executable(${t} tools/${t}.cpp)
    target_link_libraries(${t} PRIVATE wz_sl_engine)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

# sl_perf_test measures TIME, so give it room on a loaded machine — the other
# fixtures here assert on samples and finish in well under a second. It is still
# a ratio-against-realtime gate, never a wall-clock one (see the file header):
# the timeout only stops a pathological run from hanging ctest.
set_tests_properties(sl_perf_test PROPERTIES TIMEOUT 120)
