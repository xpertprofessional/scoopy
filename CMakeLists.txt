cmake_minimum_required(VERSION 3.22)
project(Wizard VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# enable_testing() must run in the TOP-LEVEL build so ctest aggregates tests
# from every subdirectory; calling it only in a subdirectory yields
# "No tests were found" at the root (parlante lesson).
enable_testing()

add_subdirectory(ThirdParty/JUCE)

# JUCE's networking (juce_core → libcurl on Linux) is unused — the WebView
# serves local files only. Disable it for every JUCE-linking target so the
# static libs don't need libcurl (parlante's Linux link lesson: the app set
# JUCE_USE_CURL=0 but the libs didn't, which broke the Linux link; macOS
# provides curl implicitly and hid it).
add_compile_definitions(JUCE_USE_CURL=0)

add_subdirectory(engine)
add_subdirectory(shell)

# host/ (JUCE duplex IO, capture backends) is added in P0-11.
