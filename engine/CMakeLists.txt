cmake_minimum_required(VERSION 3.22)
project(wz_resampler LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# THIS DIRECTORY IS NOW THE VENDORED RESAMPLER, NOTHING ELSE (H2a,
# D-SL-ONEHOST-01).
#
# It used to hold `wz_engine` — wizard's audio engine and its ~21 tests, the
# donor half of the merge. The P3 flip made scoopy's core the survivor, and by
# 2026-07-30 the only thing keeping wizard's engine compiled was its own test
# suite: no app, no library, no ABI reached it.
#
# The directory survives because `samplerate` is defined INSIDE it, and
# `wz_decode` links it (host/src/Decoder.cpp) for the D-WZ-DECKSRC-01 load-time
# SINC_BEST conversion. That decoder is not dead code — it is what P8-5
# (`tapeLoadTake` becomes REAL) is built on. slengine/CMakeLists.txt:14 records
# that the scoopy port deliberately does NOT use libsamplerate, so nothing else
# in the tree supplies this target.
#
# The old strict-warning block (-Werror -ffp-contract=off -Wconversion) went
# with the engine: it existed so wizard's renders could be null-tested across
# macOS and Linux, and there is no longer a wizard render. Third-party C was
# never built under it anyway — that is why the add_subdirectory below has
# always come first.

# D-WZ-CORE-01: the ONLY third-party dep the portable core takes.
# EXCLUDE_FROM_ALL: built only because a consumer links it.
set(LIBSAMPLERATE_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LIBSAMPLERATE_INSTALL OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(ThirdParty/libsamplerate EXCLUDE_FROM_ALL)

# Smoke: proves the vendored libsamplerate builds, links, and resamples with
# SINC_BEST. Written to de-risk wizard's ASRC before it existed; it outlives
# that engine because `wz_decode` now depends on exactly this capability.
add_executable(libsamplerate_smoke tools/libsamplerate_smoke.cpp)
target_link_libraries(libsamplerate_smoke PRIVATE samplerate)
add_test(NAME libsamplerate_smoke COMMAND libsamplerate_smoke)
