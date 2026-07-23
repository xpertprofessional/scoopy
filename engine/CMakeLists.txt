cmake_minimum_required(VERSION 3.22)
project(wz_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Vendored libsamplerate (D-WZ-CORE-01: the ONLY third-party dep the portable
# core takes — for ASRC/varispeed). Added BEFORE our strict -Werror/-Wconversion
# flags below so third-party C is not built under them. EXCLUDE_FROM_ALL: built
# only because a wz_engine consumer links it.
set(LIBSAMPLERATE_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LIBSAMPLERATE_INSTALL OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
add_subdirectory(ThirdParty/libsamplerate EXCLUDE_FROM_ALL)

# Cross-platform determinism: FP contraction off so macOS/Linux renders can be
# null-tested against each other (docs/ARCHITECTURE.md §9 gates). -Wshadow /
# -Wconversion / -Wsign-conversion caught real bugs in the sibling engines.
if(MSVC)
    add_compile_options(/W4 /WX /fp:precise)
else()
    add_compile_options(-Wall -Wextra -Werror -ffp-contract=off
                        -Wshadow -Wconversion -Wsign-conversion
                        # C++20 designated initializers with default member
                        # initializers false-positive -Wmissing-field-initializers
                        # (from -Wextra) on GCC; Clang doesn't. Silence the noise.
                        -Wno-missing-field-initializers)
    if(CMAKE_CXX_COMPILER_ID MATCHES "Clang")
        add_compile_options(-Wreturn-type-c-linkage)
    endif()
endif()

add_library(wz_engine STATIC
    src/wz_engine.cpp
    src/fader.cpp
    src/asrc.cpp)
target_include_directories(wz_engine PUBLIC include)
# libsamplerate is an implementation detail of the engine (ASRC/varispeed);
# PRIVATE so its header doesn't leak through the C ABI, but the static lib still
# propagates onto consumers' link line. No P0 TU uses it yet — the link is
# proven by libsamplerate_smoke below so the vendored copy is known-good before
# ASRC (P2) is built on it.
target_link_libraries(wz_engine PRIVATE samplerate)

enable_testing()

add_executable(null_smoke tools/null_smoke.cpp)
target_link_libraries(null_smoke PRIVATE wz_engine)
add_test(NAME null_smoke COMMAND null_smoke)

add_executable(world_test tools/world_test.cpp)
target_link_libraries(world_test PRIVATE wz_engine)
add_test(NAME world_test COMMAND world_test)

# P1-05 summing fixtures. PRIVATE src include: the fader golden-table pin reads
# the engine-internal fader.h directly (parlante's declick_test precedent).
add_executable(summing_test tools/summing_test.cpp)
target_include_directories(summing_test PRIVATE src)
target_link_libraries(summing_test PRIVATE wz_engine)
add_test(NAME summing_test COMMAND summing_test)

add_executable(deck_test tools/deck_test.cpp)
target_link_libraries(deck_test PRIVATE wz_engine)
add_test(NAME deck_test COMMAND deck_test)

add_executable(ring_test tools/ring_test.cpp)
target_link_libraries(ring_test PRIVATE wz_engine)
add_test(NAME ring_test COMMAND ring_test)

# The ASRC drift soak reads the engine-internal asrc.h + libsamplerate directly.
add_executable(asrc_drift_test tools/asrc_drift_test.cpp)
target_include_directories(asrc_drift_test PRIVATE src)
target_link_libraries(asrc_drift_test PRIVATE wz_engine samplerate)
add_test(NAME asrc_drift_test COMMAND asrc_drift_test)

add_executable(deck_handoff_test tools/deck_handoff_test.cpp)
target_link_libraries(deck_handoff_test PRIVATE wz_engine)
add_test(NAME deck_handoff_test COMMAND deck_handoff_test)

add_executable(deck_stamp_test tools/deck_stamp_test.cpp)
target_link_libraries(deck_stamp_test PRIVATE wz_engine)
add_test(NAME deck_stamp_test COMMAND deck_stamp_test)

add_executable(source_strip_test tools/source_strip_test.cpp)
target_link_libraries(source_strip_test PRIVATE wz_engine)
add_test(NAME source_strip_test COMMAND source_strip_test)

# Smoke: proves the vendored libsamplerate builds, links, and resamples with
# SINC_BEST before the ASRC/varispeed path (P2) is built on it.
add_executable(libsamplerate_smoke tools/libsamplerate_smoke.cpp)
target_link_libraries(libsamplerate_smoke PRIVATE samplerate)
add_test(NAME libsamplerate_smoke COMMAND libsamplerate_smoke)
