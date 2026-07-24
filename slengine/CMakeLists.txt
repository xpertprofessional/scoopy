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
add_library(wz_sl_engine STATIC src/sl_engine.cpp)
target_include_directories(wz_sl_engine PUBLIC include)

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
