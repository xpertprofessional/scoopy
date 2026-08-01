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

# `wz_command` (CommandDispatch) is GONE (H1). It was wizard's JSON-RPC
# dispatcher, and its only consumer was the `Wizard` app deleted at P3-0 step 2;
# `wizard::sl::dispatch` (SlDispatch.cpp, below) is the surviving one.

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

# A PLUGIN IS AUDIBLE ON A RETURN (P6-3). The wet half plane_audio_test cannot
# prove: it links the REAL NativePluginHost.mm (the app's own object — its
# symbols outrank the stub on scoopy_engine's link interface), loads Apple's
# AUDelay in-process, and asserts a delay tail on MAIN after the input stops.
# Apple-only by nature; exits 77 (SKIP) where the AU is absent.
if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    add_executable(plugin_audible_test
        tools/plugin_audible_test.cpp
        ${CMAKE_SOURCE_DIR}/ScoopyLoops/NativePluginHost.mm)
    set_target_properties(plugin_audible_test PROPERTIES
        OBJCXX_STANDARD 20
        OBJCXX_STANDARD_REQUIRED ON)
    target_include_directories(plugin_audible_test PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(plugin_audible_test PRIVATE
        JUCE_PLUGINHOST_AU=1
        JUCE_PLUGINHOST_VST3=1
        # runDispatchLoopUntil — how a console harness pumps the async plugin
        # lifecycle. Modal loops are banned in the APP, not in a test main().
        JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(plugin_audible_test PRIVATE
        wz_sl_command wz_sl_world wz_sl_engine
        juce::juce_audio_processors
        "-framework CoreAudioKit"
        juce::juce_recommended_config_flags)
    add_test(NAME plugin_audible_test COMMAND plugin_audible_test)
    set_tests_properties(plugin_audible_test PROPERTIES SKIP_RETURN_CODE 77)

    # P6-5a: the same real-AU harness, proving MEMORY rather than sound — what a
    # map must write down (identifier + opaque state) and that feeding it back
    # reconstitutes the same plugin with the same settings. A separate binary from
    # plugin_audible_test on purpose: one failure must still say which claim broke.
    add_executable(plugin_state_test
        tools/plugin_state_test.cpp
        ${CMAKE_SOURCE_DIR}/ScoopyLoops/NativePluginHost.mm)
    set_target_properties(plugin_state_test PROPERTIES
        OBJCXX_STANDARD 20
        OBJCXX_STANDARD_REQUIRED ON)
    target_include_directories(plugin_state_test PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(plugin_state_test PRIVATE
        JUCE_PLUGINHOST_AU=1
        JUCE_PLUGINHOST_VST3=1
        JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(plugin_state_test PRIVATE
        wz_sl_command wz_sl_world wz_sl_engine
        juce::juce_audio_processors
        "-framework CoreAudioKit"
        juce::juce_recommended_config_flags)
    add_test(NAME plugin_state_test COMMAND plugin_state_test)
    set_tests_properties(plugin_state_test PROPERTIES SKIP_RETURN_CODE 77)
endif()

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
#
# ITS SOURCE IS GONE TOO (H1, D-SL-ONEHOST-01). Deleting the target left
# `src/Main.cpp` on disk — 654 lines that no target compiled but that still read
# like a live shell, which is the same confusion one layer down. A file nothing
# builds is not documentation; git is.

# ─────────────────────────────────────────────────────────────────────────────
# THE MERGED SHELL — scoopy's real UI on the SL ABI v3 engine. The ONLY host.
#
# THE ASSEMBLY IS A LIBRARY (H3). It used to be the app's single translation
# unit, which meant the only way to run it was to launch the app by hand — the
# reason every phase here ends on an `awaiting-user` gate. `wz_merged_app` holds
# the whole shell; two entry points link it:
#
#   WizardMerged  src/MergedMain.cpp        the app
#   MergedWalk    tools/merged_walk.cpp     the same app, driven by a script (H5)
#
# One source of truth, two ways in. A walk against a COPY of the shell would
# prove nothing about the shell that ships.
#
# ⚠️ `NativePluginHost.mm` IS DELIBERATELY NOT IN THIS LIBRARY — it is listed per
# EXECUTABLE below. Its symbols must outrank the no-op stub on scoopy_engine's
# link interface, and an archive member is pulled only if a symbol is still
# undefined; inside a static lib it can lose that race and every plugin feature
# goes quiet with a green build. `plugin_audible_test`/`plugin_state_test`
# already compile it directly for exactly this reason.
# ─────────────────────────────────────────────────────────────────────────────
add_library(wz_merged_app STATIC src/MergedApp.cpp)
target_include_directories(wz_merged_app PUBLIC src
    ${CMAKE_SOURCE_DIR}/slengine/include ${CMAKE_SOURCE_DIR}/host/src)

target_compile_definitions(wz_merged_app PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    # The webdist is PUBLIC because both entry points serve the same bundle;
    # two entry points disagreeing about which UI they host is precisely the
    # class of thing this arrangement exists to make impossible.
    # BUILT IN-TREE from `web/` (P3-0 step 2). It was `vendor/scoopy/webdist` — a
    # vendored BUILD of another repo's UI — and that indirection cost a session:
    # a day's work was invisible because nothing rebuilt or re-vendored it.
    MERGED_WEBDIST_DIR="${CMAKE_SOURCE_DIR}/webdist")

target_link_libraries(wz_merged_app
    PUBLIC juce::juce_gui_extra
           wz_sl_engine    # the v3 engine
           wz_sl_command   # SlDispatch: boot handshake + worldPublish play path
           wz_sl_settings  # FileSettingsStore
           wz_webresources # resource serving + navigation policy
           wz_audio_io     # duplex device -> SlRenderSink -> sl_render_io
    PRIVATE juce::juce_recommended_config_flags
            juce::juce_recommended_warning_flags)

if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    # The DEFINES and the include path, so MergedApp.{h,cpp} compile the
    # scanner member in — but not the .mm itself. See the ⚠️ above.
    target_include_directories(wz_merged_app PUBLIC ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(wz_merged_app PUBLIC
        JUCE_PLUGINHOST_AU=1
        JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(wz_merged_app PUBLIC juce::juce_audio_processors)
endif()

juce_add_gui_app(WizardMerged
    PRODUCT_NAME "WizardMerged"
    COMPANY_NAME "Wizard"
    BUNDLE_ID com.wizard.merged
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "ScoopyLoops mixes and records audio; microphone access makes your inputs available.")

target_sources(WizardMerged PRIVATE src/MergedMain.cpp)

target_compile_definitions(WizardMerged PRIVATE
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:WizardMerged,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:WizardMerged,JUCE_VERSION>")

# Everything else — the engine, the dispatcher, the webdist, the WebView flags —
# arrives PUBLIC through the shell library. The app target's own list is now
# only what is genuinely app-specific: its name and version.
target_link_libraries(WizardMerged PRIVATE
    wz_merged_app
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# P6-1 — the REAL plugin host (scoopyloops' own NativePluginHost.mm) compiles into the app
# target, exactly as the shipping app does it: the core (built flag=1 via scoopy_engine's
# PUBLIC define) calls the slot surface, and THIS object file supplies the JUCE-backed
# implementation — so the no-op stub on scoopy_engine's link interface is never pulled here.
# It stays on the EXECUTABLE and out of wz_merged_app (see the ⚠️ above the library):
# in an archive it can lose the symbol race to that stub, silently.
if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_sources(WizardMerged PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops/NativePluginHost.mm)
    set_target_properties(WizardMerged PROPERTIES
        OBJCXX_STANDARD 20
        OBJCXX_STANDARD_REQUIRED ON)
    # CoreAudioKit explicitly: JUCE's module metadata only auto-links the frameworks its
    # DEFAULT config needs, and the AU-host code (AUGenericView) is behind our define.
    target_link_libraries(WizardMerged PRIVATE "-framework CoreAudioKit")
endif()

# ─────────────────────────────────────────────────────────────────────────────
# MergedWalk (H5) — THE SAME APP, driven by a script instead of a person.
#
# It links `wz_merged_app`, so it boots the real shell: real WKWebView, real
# resource provider, real dispatcher, real engine, a real `window.__JUCE__`.
# That last one is the point — every browser walk in web/tools/ answers through
# `browserLink.ts` and is structurally blind to the native half.
#
# A GUI binary, so it needs a window server: SKIP (77) where there is none.
# ⚠️ NativePluginHost.mm listed here for the same reason as the app — never in
# the library.
# ─────────────────────────────────────────────────────────────────────────────
juce_add_gui_app(MergedWalk
    PRODUCT_NAME "MergedWalk"
    COMPANY_NAME "Wizard"
    BUNDLE_ID com.wizard.mergedwalk)

target_sources(MergedWalk PRIVATE tools/merged_walk.cpp)
target_compile_definitions(MergedWalk PRIVATE
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:MergedWalk,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:MergedWalk,JUCE_VERSION>")
target_link_libraries(MergedWalk PRIVATE
    wz_merged_app
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_sources(MergedWalk PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops/NativePluginHost.mm)
    set_target_properties(MergedWalk PROPERTIES
        OBJCXX_STANDARD 20
        OBJCXX_STANDARD_REQUIRED ON)
    target_link_libraries(MergedWalk PRIVATE "-framework CoreAudioKit")
endif()

# OPT-IN, and off by default on purpose. This binary opens real windows and
# opens the real audio DEVICE, so folding it into the routine `ctest` run would
# steal focus and the sound card out from under whoever is working. A gate that
# interrupts you is a gate you start skipping.
#
#   cmake -B build -DWIZARD_TEST_REALHOST=ON && ctest --test-dir build -L realhost
#
# or just run it, which is the same thing without ctest in the way:
#
#   cmake --build build --target MergedWalk
#   ./build/shell/MergedWalk_artefacts/MergedWalk.app/Contents/MacOS/MergedWalk
#
# ⚠️ It is built either way — an opt-in gate that stops COMPILING is how a walk
# quietly rots. Only its ctest registration is conditional.
option(WIZARD_TEST_REALHOST "Register the real-host walk (MergedWalk) with ctest" OFF)
if(WIZARD_TEST_REALHOST)
    # TWO registrations, ONE binary (S1). Every check but the panel-identity one
    # is face-agnostic, so a second walk source would drift from this one for no
    # coverage. `SL_WALK_FACE` picks the face and the walk asserts it arrived.
    #
    # `studio` first and unsuffixed: it is what the app opens when nobody says
    # (D-SL-STUDIO-01), and a gate whose default is not the product's default
    # proves the wrong thing. The plane is FROZEN, not abandoned — freezing a
    # surface must not mean it stops being tested, or "still compiles" quietly
    # becomes the only claim anyone can make about it.
    # ⚠️ `$<TARGET_FILE:...>`, NOT a hand-written artefacts path, and this is a
    # FIX rather than a style preference. JUCE writes to
    # `MergedWalk_artefacts/<CONFIG>/MergedWalk.app/…`; the path spelled here
    # before omitted the config directory, so it named a file that a single-config
    # build had left behind and that NOTHING relinks. Measured 2026-08-02: the
    # registered command was a binary three days older than the source, and the
    # walk passed 6/6 against it while the change under test was absent. That is
    # this repo's recurring failure — a green gate proving a stale artifact — and
    # it is the same shape `plugin:check` exists to catch one layer up.
    foreach(face studio plane)
        add_test(NAME merged_walk_${face} COMMAND $<TARGET_FILE:MergedWalk>)
        set_tests_properties(merged_walk_${face} PROPERTIES
            ENVIRONMENT "SL_WALK_FACE=${face}"
            SKIP_RETURN_CODE 77
            LABELS "realhost"
            # SERIAL: each run opens real windows and the real audio device, so
            # two at once fight over both.
            RUN_SERIAL TRUE
            TIMEOUT 90)
    endforeach()
endif()

# ScoopyDeck — the plugin entry point (D-SL-DECKPLUGIN-01). LAST, because it
# links the libraries defined above and its own CMakeLists names them.
add_subdirectory(plugin)

# Same JUCE 8 gap for every WebView target: juce_gui_extra declares no
# linuxPackages, so nothing supplies the GTK/WebKit headers its Linux
# WebBrowserComponent includes. On the LIBRARY so both entry points inherit it.
if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
    pkg_check_modules(WEBKIT2GTK REQUIRED webkit2gtk-4.1)
    target_include_directories(wz_merged_app PUBLIC ${GTK3_INCLUDE_DIRS} ${WEBKIT2GTK_INCLUDE_DIRS})
    target_link_libraries(wz_merged_app PUBLIC ${GTK3_LIBRARIES} ${WEBKIT2GTK_LIBRARIES})
endif()
