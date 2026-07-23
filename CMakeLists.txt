cmake_minimum_required(VERSION 3.22)
project(Wizard VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# enable_testing() must run in the TOP-LEVEL build so ctest aggregates tests
# from every subdirectory; calling it only in a subdirectory yields
# "No tests were found" at the root (parlante lesson).
enable_testing()

add_subdirectory(engine)

# host/ (JUCE duplex IO, capture backends) and shell/ (WebView app) are added
# once JUCE is vendored in P0-05. The engine tier builds and tests standalone
# with zero third-party deps until then.
