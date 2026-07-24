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
add_executable(command_dispatch_test tools/command_dispatch_test.cpp)
target_include_directories(command_dispatch_test PRIVATE generated ${CMAKE_SOURCE_DIR}/engine/include)
target_link_libraries(command_dispatch_test PRIVATE wz_command)
add_test(NAME command_dispatch_test COMMAND command_dispatch_test)

juce_add_gui_app(Wizard
    PRODUCT_NAME "Wizard"
    COMPANY_NAME "Wizard"
    BUNDLE_ID com.wizard.wizard
    # Without this, macOS TCC silently starves the duplex input side: the
    # device opens but input buffers arrive as zeros (P1-G1 field finding).
    # This injects NSMicrophoneUsageDescription and JUCE's permission request.
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Wizard mixes and records audio inputs; microphone access makes your hardware inputs available as channel strips.")

target_sources(Wizard PRIVATE src/Main.cpp)

# generated/ holds WZProtocol.h (codegen from web/protocol/schema.ts); include/
# holds the engine ABI. Main.cpp creates the engine directly (single explicit
# link), same as parlante's shell.
target_include_directories(Wizard PRIVATE generated ${CMAKE_SOURCE_DIR}/engine/include ${CMAKE_SOURCE_DIR}/host/src)

target_compile_definitions(Wizard PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:Wizard,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:Wizard,JUCE_VERSION>"
    # Dev builds serve the committed bundle straight from the repo; release
    # packaging (P8) switches this to a bundled copy.
    WIZARD_WEBDIST_DIR="${CMAKE_SOURCE_DIR}/webdist")

target_link_libraries(Wizard PRIVATE
    wz_engine # Main.cpp calls the engine directly
    wz_webresources
    wz_command # Main.cpp's wzCommand native fn dispatches through this
    wz_audio_io # host/ duplex device layer: drives wz_engine_render
    wz_decode   # deckLoadFile: decode + SINC_BEST resample (D-WZ-DECKSRC-01)
    wz_record   # P3: drain thread -> crash-safe take files
    wz_session  # P7: atomic session file read/write
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# JUCE 8's juce_gui_extra declares no `linuxPackages`, so nothing supplies the
# GTK/WebKit headers its Linux WebBrowserComponent includes (<gtk/gtk.h>).
# Provide them via pkg-config — macOS gets its webview from the OS.
if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
    pkg_check_modules(WEBKIT2GTK REQUIRED webkit2gtk-4.1)
    target_include_directories(Wizard PRIVATE
        ${GTK3_INCLUDE_DIRS} ${WEBKIT2GTK_INCLUDE_DIRS})
    target_link_libraries(Wizard PRIVATE
        ${GTK3_LIBRARIES} ${WEBKIT2GTK_LIBRARIES})
endif()
