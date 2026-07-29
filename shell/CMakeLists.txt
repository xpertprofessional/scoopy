# The shell contains ONLY: EngineLink transport, window/menu chrome, file
# dialogs, lifecycle. Anything else here is a bug (docs/ARCHITECTURE.md §1).

# URL→file mapping is shared by the app and its test so the served bytes and
# the containment rules are verified without needing a GUI or a display.
add_library(wz_webresources STATIC src/WebResources.cpp)
target_include_directories(wz_webresources PUBLIC src)
target_link_libraries(wz_webresources
    PUBLIC juce::juce_core
    PRIVATE juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(web_resources_test tools/web_resources_test.cpp)
target_link_libraries(web_resources_test PRIVATE wz_webresources)
add_test(NAME web_resources_test COMMAND web_resources_test)

# Command JSON-RPC dispatch, shared by the app and its headless test. wz_engine
# is PRIVATE (CommandDispatch.h only forward-declares it): consumers that create
# engines link wz_engine directly, keeping it on the final link line once.
add_library(wz_command STATIC src/CommandDispatch.cpp)
target_include_directories(wz_command PUBLIC src generated)
target_link_libraries(wz_command
    PUBLIC juce::juce_core
    PRIVATE wz_engine juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# The test creates engines directly, but wz_command already propagates the
# static wz_engine onto the link line (PRIVATE deps of a static lib can't be
# hidden), so linking it again would just warn about a duplicate library.
# scoopy's slCommand dispatch (boot handshake: capabilities + settings +
# view-state), GUI-free so it is tested headlessly like wz_command. No engine
# yet — the PatternFile->v3 play path is a later increment.
# File-backed SettingsStore for the live window; GUI-free so its persistence
# and atomic-write discipline are tested headlessly (SessionStore precedent).
add_library(wz_sl_settings STATIC src/SlSettingsStore.cpp)
target_include_directories(wz_sl_settings PUBLIC src)
target_link_libraries(wz_sl_settings
    PUBLIC juce::juce_core
    PRIVATE juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(sl_settings_store_test tools/sl_settings_store_test.cpp)
target_link_libraries(sl_settings_store_test PRIVATE wz_sl_settings)
add_test(NAME sl_settings_store_test COMMAND sl_settings_store_test)

add_library(wz_sl_command STATIC src/SlDispatch.cpp)
target_include_directories(wz_sl_command PUBLIC src)
# wz_sl_world (applyWorld) for the worldPublish play path; it pulls the v3 engine.
# wz_record for the plane's slRecord/slTakes: recording is half engine and half
# FILE (the drain thread, the take directory, the crash-safe writer), and the
# file half is the host's. Reached through HostServices, so a host without a
# recorder still links and refuses those two commands honestly.
# wz_sl_engine is PRIVATE: the plane commands call the C ABI directly, but
# SlDispatch.h only forward-declares sl_engine, so nothing downstream needs it.
target_link_libraries(wz_sl_command
    PUBLIC juce::juce_core wz_record
    PRIVATE wz_sl_world wz_sl_engine wz_audio_io
            juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(sl_dispatch_test tools/sl_dispatch_test.cpp)
target_link_libraries(sl_dispatch_test PRIVATE wz_sl_command wz_sl_world wz_sl_engine)
add_test(NAME sl_dispatch_test COMMAND sl_dispatch_test)

# THE PLANE MAKES A SOUND. Drives the exact command sequence the plane's UI
# issues, through the real dispatcher, into a real engine, and asserts on the
# rendered samples — the check that "tests pass" was standing in for.
add_executable(plane_audio_test tools/plane_audio_test.cpp)
target_link_libraries(plane_audio_test PRIVATE wz_sl_command wz_sl_world wz_sl_engine wz_record)
add_test(NAME plane_audio_test COMMAND plane_audio_test)

# The Option-B play path (native half): a name-keyed World -> v3 snapshot. Links
# the v3 engine; GUI-free so it is tested headlessly (a World payload -> audio).
add_library(wz_sl_world STATIC src/SlWorldApply.cpp)
target_include_directories(wz_sl_world PUBLIC src)
target_include_directories(wz_sl_world PRIVATE ${CMAKE_SOURCE_DIR}/slengine/generated)
target_link_libraries(wz_sl_world
    PUBLIC juce::juce_core
    PRIVATE wz_sl_engine juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(sl_world_apply_test tools/sl_world_apply_test.cpp)
target_link_libraries(sl_world_apply_test PRIVATE wz_sl_world wz_sl_engine)
add_test(NAME sl_world_apply_test COMMAND sl_world_apply_test)

add_executable(command_dispatch_test tools/command_dispatch_test.cpp)
target_include_directories(command_dispatch_test PRIVATE generated ${CMAKE_SOURCE_DIR}/engine/include)
target_link_libraries(command_dispatch_test PRIVATE wz_command)
add_test(NAME command_dispatch_test COMMAND command_dispatch_test)

# THE `Wizard` APP TARGET IS GONE (P3-0 step 2, 2026-07-27).
#
# It served `webdist/` built from wizard's own `web/` — a SECOND plane
# implementation, 49 files, superseded concept for concept by the merged plane
# (MeterCanvas -> StripMeter, DeckWaveform -> TapeWave, DevicePicker ->
# devices.ts). That plane was never ported: pd-strip-anatomy critiqued wizard's
# Strip.tsx with fourteen numbered defects and the merged one was built fresh.
#
# Keeping both meant two `web` trees and two apps that both looked like "the
# app", which is most of the folder confusion this collapse exists to end. The
# code is in git if it is ever wanted back.

# ─────────────────────────────────────────────────────────────────────────────
# The MERGED SHELL — scoopy's real UI on the SL ABI v3 engine (P1 live window).
# Additive alongside Wizard until the P3 flip. Everything behind the transport
# is unit-tested; this target is the GUI assembly, verified by running it.
# ─────────────────────────────────────────────────────────────────────────────
juce_add_gui_app(WizardMerged
    PRODUCT_NAME "WizardMerged"
    COMPANY_NAME "Wizard"
    BUNDLE_ID com.wizard.merged
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "ScoopyLoops mixes and records audio; microphone access makes your inputs available.")

target_sources(WizardMerged PRIVATE src/MergedMain.cpp)
target_include_directories(WizardMerged PRIVATE ${CMAKE_SOURCE_DIR}/slengine/include ${CMAKE_SOURCE_DIR}/host/src)

target_compile_definitions(WizardMerged PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:WizardMerged,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:WizardMerged,JUCE_VERSION>"
    # The vendored, hash-pinned scoopy webdist — the merged repo hosts scoopy
    # self-contained (no sibling checkout at runtime).
    # BUILT IN-TREE from `web/` (P3-0 step 2). It was `vendor/scoopy/webdist` — a
    # vendored BUILD of another repo's UI — and that indirection cost a session:
    # a day's work was invisible because nothing rebuilt or re-vendored it. One
    # tree, one build, nothing to forget.
    MERGED_WEBDIST_DIR="${CMAKE_SOURCE_DIR}/webdist")

target_link_libraries(WizardMerged PRIVATE
    wz_sl_engine    # the v3 engine
    wz_sl_command   # SlDispatch: boot handshake + worldPublish play path
    wz_sl_world     # applyWorld (pulled in via wz_sl_command, named for clarity)
    wz_sl_settings  # FileSettingsStore
    wz_webresources # resource serving + navigation policy
    wz_audio_io     # duplex device -> SlRenderSink -> sl_render_io
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# P6-1 — the REAL plugin host (scoopyloops' own NativePluginHost.mm) compiles into the app
# target, exactly as the shipping app does it: the core (built flag=1 via scoopy_engine's
# PUBLIC define) calls the slot surface, and THIS object file supplies the JUCE-backed
# implementation — so the no-op stub on scoopy_engine's link interface is never pulled here.
# juce_audio_processors brings the AU + VST3 format code; the two JUCE_PLUGINHOST defines
# turn those formats on for every module TU this target compiles.
if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_sources(WizardMerged PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops/NativePluginHost.mm)
    set_target_properties(WizardMerged PROPERTIES
        OBJCXX_STANDARD 20
        OBJCXX_STANDARD_REQUIRED ON)
    target_include_directories(WizardMerged PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(WizardMerged PRIVATE
        JUCE_PLUGINHOST_AU=1
        JUCE_PLUGINHOST_VST3=1)
    # CoreAudioKit explicitly: JUCE's module metadata only auto-links the frameworks its
    # DEFAULT config needs, and the AU-host code (AUGenericView) is behind our define.
    target_link_libraries(WizardMerged PRIVATE
        juce::juce_audio_processors
        "-framework CoreAudioKit")
endif()

if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
    pkg_check_modules(WEBKIT2GTK REQUIRED webkit2gtk-4.1)
    target_include_directories(WizardMerged PRIVATE ${GTK3_INCLUDE_DIRS} ${WEBKIT2GTK_INCLUDE_DIRS})
    target_link_libraries(WizardMerged PRIVATE ${GTK3_LIBRARIES} ${WEBKIT2GTK_LIBRARIES})
endif()
