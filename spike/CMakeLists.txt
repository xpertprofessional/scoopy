# P1 SPIKE target — TEMPORARY, deleted once docs/merge/P1-SPIKE-JUCE-WEBVIEW.md
# carries its verdict. It answers "can a JUCE WebBrowserComponent host scoopy's
# real UI" by hosting scoopy's COMMITTED webdist against a stub dispatcher.
#
# OFF by default is wrong here and ON by default is right: the spike's Linux
# answer is worth as much as its macOS one, and CI builds what the tree defines.
# Building it costs nothing (one TU) and proves the WebKitGTK path compiles.
option(WIZARD_BUILD_SPIKE "Build the P1 JUCE-WebView spike app" ON)
if(NOT WIZARD_BUILD_SPIKE)
    return()
endif()

juce_add_gui_app(ScoopySpike
    PRODUCT_NAME "ScoopySpike"
    COMPANY_NAME "Wizard"
    BUNDLE_ID com.wizard.scoopyspike)

target_sources(ScoopySpike PRIVATE src/SpikeMain.cpp)

# The spike reuses the shell's URL→file mapping (containment rules already
# tested by web_resources_test) rather than growing a second, untested one.
target_link_libraries(ScoopySpike PRIVATE
    wz_webresources
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# scoopy's committed bundle, read from the sibling repo in place. NOT vendored:
# webdist is a build artifact of scoopy's web app, and pinning one into this
# repo is a P1-plumbing decision the spike exists to inform, not to pre-empt.
target_compile_definitions(ScoopySpike PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:ScoopySpike,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:ScoopySpike,JUCE_VERSION>"
    SCOOPY_WEBDIST_DIR="${CMAKE_SOURCE_DIR}/../scoopy/webdist")

# Same JUCE 8 gap the shell works around: juce_gui_extra declares no
# linuxPackages, so nothing supplies the GTK/WebKit headers its Linux
# WebBrowserComponent includes.
if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
    pkg_check_modules(WEBKIT2GTK REQUIRED webkit2gtk-4.1)
    target_include_directories(ScoopySpike PRIVATE
        ${GTK3_INCLUDE_DIRS} ${WEBKIT2GTK_INCLUDE_DIRS})
    target_link_libraries(ScoopySpike PRIVATE
        ${GTK3_LIBRARIES} ${WEBKIT2GTK_LIBRARIES})
endif()
