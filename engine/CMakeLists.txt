cmake_minimum_required(VERSION 3.22)
project(wz_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

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

enable_testing()

add_executable(null_smoke tools/null_smoke.cpp)
target_link_libraries(null_smoke PRIVATE wz_engine)
add_test(NAME null_smoke COMMAND null_smoke)
