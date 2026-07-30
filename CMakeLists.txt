cmake_minimum_required(VERSION 3.22)
project(Wizard VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Obj-C++ is a first-class language of this build (P6-1: the vendored
# NativePluginHost.mm compiles into WizardMerged as real Obj-C++). Enabled HERE,
# not in shell/ — enable_language() in a subdirectory loads the language's rule
# variables into that scope only, and every directory that links a JUCE module
# compiles that module's .mm sources, so a subdirectory enable breaks their
# generate step (CMAKE_OBJCXX_COMPILE_OBJECT not set).
if(APPLE)
    enable_language(OBJCXX)
endif()

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
# The hash-pinned scoopy core + its C ABI. Added BEFORE host/shell so the
# merged engine target is available to them as P1 plumbing proceeds.
add_subdirectory(vendor)
# SL ABI v3 over the vendored core. After vendor/ (it links scoopy_engine).
add_subdirectory(slengine)
add_subdirectory(host)
add_subdirectory(shell)
# `spike/` is GONE (H1). It answered "can a JUCE WebBrowserComponent host scoopy's
# real UI"; docs/merge/P1-SPIKE-JUCE-WEBVIEW.md carries the verdict (all four
# questions, 2026-07-24), which was its own stated deletion condition. Its Linux
# WebKitGTK coverage lives on in WizardMerged, which carries the same block.
