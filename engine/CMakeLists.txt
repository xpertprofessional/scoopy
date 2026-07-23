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
    src/wz_engine.cpp)
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

# Smoke: proves the vendored libsamplerate builds, links, and resamples with
# SINC_BEST before the ASRC/varispeed path (P2) is built on it.
add_executable(libsamplerate_smoke tools/libsamplerate_smoke.cpp)
target_link_libraries(libsamplerate_smoke PRIVATE samplerate)
add_test(NAME libsamplerate_smoke COMMAND libsamplerate_smoke)
