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

juce_add_gui_app(Wizard
    PRODUCT_NAME "Wizard"
    COMPANY_NAME "Wizard"
    BUNDLE_ID com.wizard.wizard)

target_sources(Wizard PRIVATE src/Main.cpp)

# generated/ holds WZProtocol.h (codegen from web/protocol/schema.ts); include/
# holds the engine ABI. Main.cpp creates the engine directly (single explicit
# link), same as parlante's shell.
target_include_directories(Wizard PRIVATE generated ${CMAKE_SOURCE_DIR}/engine/include)

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
