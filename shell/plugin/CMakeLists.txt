# ─────────────────────────────────────────────────────────────────────────────
# ScoopyDeck — the PLUGIN entry point (D-SL-DECKPLUGIN-01).
#
# The third way into the same shell libraries, beside WizardMerged (the app) and
# MergedWalk (the scripted app). It is NOT a second shell: it links the same
# dispatcher, the same webdist, the same engine tier. What it replaces is only
# the outermost layer — juce::JUCEApplication + AudioIO become
# juce::AudioProcessor + the DAW's callback.
#
# ⚠️ `NativePluginHost.mm` IS DELIBERATELY ABSENT HERE, and that is a RULING,
# not an omission (D-SL-DECKPLUGIN-01: no plugin-in-plugin, ever). The app and
# MergedWalk each list it because their symbols must outrank the no-op stub;
# this target wants the STUB to win. So the pattern inverts: list nothing, and
# `scoopy_plugin_host_stub` — already on scoopy_engine's PUBLIC link interface —
# answers every slot call with silence. `pluginHosting` then reads false through
# the ordinary capability path, because PluginBackend never sets a scanner.
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# THE EMBEDDED WEB BUNDLE (see src/EmbeddedWeb.h for why it is an archive).
#
# A plugin is copied out of this tree and opened on machines that have never
# seen it, so serving `webdist/` from ${CMAKE_SOURCE_DIR} — which is what the
# app does, correctly, for itself — would give a blank editor and no error.
#
# CONFIGURE_DEPENDS because vite content-hashes every asset: a web rebuild
# renames the files, and without it CMake would keep zipping the file list it
# globbed on the day the build tree was created. Sourcemaps (4.3 of the 6.8 MB)
# and .DS_Store are excluded; `.buildhash` is a gate artefact nothing fetches.
#
# ⚠️ ONE ARCHIVE, EVERY PLUGIN — the names here are deliberately product-neutral.
# There is a single web bundle in this repo and a face is chosen at runtime by
# the `window.__slPanel` the editor injects, so ScoopyDeck and ScoopyTape embed
# BYTE-IDENTICAL zips. Giving each its own binary-data target would double the
# archive in the build and in every artefact for no difference in content. It
# was named ScoopyDeckWebDist while the deck was the only plugin; that name is
# what made `EmbeddedWeb.cpp` look product-specific when it never was.
# ─────────────────────────────────────────────────────────────────────────────
file(GLOB_RECURSE SCOOPY_PLUGIN_WEB_FILES CONFIGURE_DEPENDS
    RELATIVE ${CMAKE_SOURCE_DIR}/webdist
    ${CMAKE_SOURCE_DIR}/webdist/*.html
    ${CMAKE_SOURCE_DIR}/webdist/*.css
    ${CMAKE_SOURCE_DIR}/webdist/*.js
    # Everything else `mimeForExtension` knows how to serve. The glob was
    # html/css/js only, so the first font or image the web tier emitted would
    # silently not be embedded and 404 in the plugin — with the page otherwise
    # loading, which is the hardest kind of missing.
    ${CMAKE_SOURCE_DIR}/webdist/*.svg
    ${CMAKE_SOURCE_DIR}/webdist/*.png
    ${CMAKE_SOURCE_DIR}/webdist/*.jpg
    ${CMAKE_SOURCE_DIR}/webdist/*.jpeg
    ${CMAKE_SOURCE_DIR}/webdist/*.woff2
    ${CMAKE_SOURCE_DIR}/webdist/*.wasm
    ${CMAKE_SOURCE_DIR}/webdist/*.json)
list(FILTER SCOOPY_PLUGIN_WEB_FILES EXCLUDE REGEX "\\.map$")

if(NOT SCOOPY_PLUGIN_WEB_FILES)
    message(FATAL_ERROR
        "Scoopy plugins: webdist/ has no bundle to embed. Build it first: "
        "cd web && npm run bundle")
endif()

# TWO lists of the same files: `tar` needs them RELATIVE (they become the entry
# names the WebView asks for, so `assets/x.js` must not become an absolute
# path), while DEPENDS needs them ABSOLUTE or make resolves them against this
# directory and demands a `shell/plugin/index.html` that does not exist.
set(SCOOPY_PLUGIN_WEB_FILES_ABS "")
foreach(_f IN LISTS SCOOPY_PLUGIN_WEB_FILES)
    list(APPEND SCOOPY_PLUGIN_WEB_FILES_ABS ${CMAKE_SOURCE_DIR}/webdist/${_f})
endforeach()

set(SCOOPY_PLUGIN_WEB_ZIP ${CMAKE_CURRENT_BINARY_DIR}/webdist_zip)
add_custom_command(
    OUTPUT ${SCOOPY_PLUGIN_WEB_ZIP}
    COMMAND ${CMAKE_COMMAND} -E tar cf ${SCOOPY_PLUGIN_WEB_ZIP} --format=zip -- ${SCOOPY_PLUGIN_WEB_FILES}
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/webdist
    DEPENDS ${SCOOPY_PLUGIN_WEB_FILES_ABS}
    COMMENT "Scoopy plugins: packing the web bundle for embedding"
    VERBATIM)
add_custom_target(ScoopyPluginWebZip DEPENDS ${SCOOPY_PLUGIN_WEB_ZIP})

# The extension-less name is deliberate: juce_add_binary_data derives the
# symbol from the filename, so `webdist_zip` is what EmbeddedWeb.cpp asks for.
juce_add_binary_data(ScoopyPluginWebDist
    HEADER_NAME ScoopyPluginWebDist.h
    NAMESPACE ScoopyPluginWebDist
    SOURCES ${SCOOPY_PLUGIN_WEB_ZIP})
add_dependencies(ScoopyPluginWebDist ScoopyPluginWebZip)
# Static libs linked into a shared plugin bundle need PIC.
set_target_properties(ScoopyPluginWebDist PROPERTIES POSITION_INDEPENDENT_CODE ON)

juce_add_plugin(ScoopyDeck
    PRODUCT_NAME "Scoopy Deck"
    COMPANY_NAME "ScoopyLoops"
    BUNDLE_ID com.scoopyloops.scoopydeck
    PLUGIN_MANUFACTURER_CODE Scpy
    PLUGIN_CODE ScDk
    FORMATS AU VST3 Standalone
    # A source, not a processor: it makes sound with no input. The stereo input
    # bus exists for beat-synced RECORDING (the deviceInput of a host that has
    # no device), which is why it is optional rather than main.
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    # Declared in v0 though MIDI out does not land until v2: adding an output
    # port later changes the plugin's ID in some hosts, which silently breaks
    # every saved project that used it.
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE   # the deck's transport is keyboard-driven
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Scoopy Deck records audio routed to its input."
    COPY_PLUGIN_AFTER_BUILD TRUE)

target_sources(ScoopyDeck PRIVATE
    src/ScoopyPluginProcessor.cpp
    src/ScoopyPluginEditor.cpp
    src/PluginBackend.cpp
    src/EmbeddedWeb.cpp
    src/PeerRegistry.cpp
    src/HostSync.cpp
    src/LaneMap.cpp)

target_include_directories(ScoopyDeck PRIVATE
    src
    ${CMAKE_SOURCE_DIR}/shell/src        # MergedApp.h (kScoopySchemaVersion), SlDispatch, WebResources
    ${CMAKE_SOURCE_DIR}/host/src         # RecordService, SlTakeDrainSource
    ${CMAKE_SOURCE_DIR}/slengine/include
    ${CMAKE_SOURCE_DIR}/slengine/generated)

target_compile_definitions(ScoopyDeck PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)
# ⚠️ No MERGED_WEBDIST_DIR here, deliberately: this target must not be ABLE to
# read the source tree, or a dev machine would keep passing while an installed
# copy served nothing. The bundle arrives through ScoopyPluginWebDist.

target_link_libraries(ScoopyDeck PRIVATE
    ScoopyPluginWebDist # the UI, carried inside the binary
    wz_sl_engine     # the v3 engine
    wz_sl_command    # SlDispatch: the same command surface the app answers
    wz_sl_world      # applyWorld, for transport-follow's world re-apply
    wz_sl_settings   # FileSettingsStore (under ScoopyDeck/, not WizardMerged/)
    wz_record        # takes + the drain thread
    wz_webresources  # resource serving + navigation policy
    juce::juce_audio_utils
    juce::juce_gui_extra
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# MergedApp.h declares Backend's scanner member behind SCOOPY_PLUGIN_HOST, which
# scoopy_engine sets PUBLIC=1 on Apple. We include that header for ONE constant
# (kScoopySchemaVersion — deliberately shared rather than copied, so schema:check
# keeps covering this host), so the declaration must resolve. The header is
# JUCE-free and no .mm is compiled: see the ⚠️ at the top of this file.
if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_include_directories(ScoopyDeck PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(ScoopyDeck PRIVATE
        JUCE_PLUGINHOST_AU=1
        JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(ScoopyDeck PRIVATE juce::juce_audio_processors)
endif()

# ─────────────────────────────────────────────────────────────────────────────
# ScoopyTape — the looper strip, as an INSERT EFFECT.
# docs/merge/TAPEPLUGIN-KICKOFF.md §1. Decision A1: a second product, not a
# second face of ScoopyDeck, because the deck is IS_SYNTH with a five-bus map
# and changing a shipped plugin's buses changes its ID — which silently breaks
# every saved project that used it.
#
# It shares the spine (EmbeddedWeb · HostSync · PluginBackend) and differs where
# an effect differs from an instrument. Note what is ABSENT from its sources:
# `LaneMap.cpp`. That file exists to permute 26 engine lanes onto five buses;
# this target renders `bus_count = 2` — main L/R, the narrowest sl_render_io
# call (sl_engine.h §2) — so there is nothing to map.
# ─────────────────────────────────────────────────────────────────────────────
juce_add_plugin(ScoopyTape
    PRODUCT_NAME "Scoopy Tape"
    COMPANY_NAME "ScoopyLoops"
    BUNDLE_ID com.scoopyloops.scoopytape
    PLUGIN_MANUFACTURER_CODE Scpy
    # CLAIMED FROM THE LINE-WIDE REGISTRY, not invented here. The codes are
    # mnemonics of the THING — `SpFx` Spectral FX · `Trmb` Trombone · `Puls`
    # Pulsar — so an Sc-prefixed `ScTp` was off-style as well as unclaimed.
    # ⚠️ THE REGISTRY ITSELF LIVES IN A REPO THIS PROJECT MAY NOT WRITE TO
    # (`../scoopyloops/docs/plugins/PLUGIN-DESIGN-SYSTEM.md` §7, which says
    # "claim the next here"). The entry is therefore OWED — see
    # docs/merge/TAPEPLUGIN-KICKOFF.md, which carries it as an open item so the
    # claim is recorded somewhere a later session will actually look.
    PLUGIN_CODE Tape
    FORMATS AU VST3 Standalone
    # The line convention for an effect. ScoopyDeck predates this file being
    # read and declares no categories at all; that is its gap, not a precedent.
    VST3_CATEGORIES Fx
    # A PROCESSOR, not a source: it has nothing to loop until audio arrives.
    # This is the line that makes the DAW list it under effects and give it a
    # real main input rather than an instrument's optional sidechain.
    IS_SYNTH FALSE
    # Declared now though nothing reads it yet — adding a port later changes the
    # plugin's ID in some hosts, exactly as ScoopyDeck's inert MIDI-out was
    # declared in v0. Mapping notes/CC to record/overdub/snapshot select is a
    # named later quality, so the port has to exist from the first ship.
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    # ⚠️ aumf (MusicEffect), NOT aufx (Effect) — an effect that ACCEPTS MIDI.
    # auval says so itself with kAudioUnitType_Effect declared alongside a MIDI
    # in port: "WARNING: AU implements MusicDeviceMIDIEvent but is of type
    # 'aufx' (it should be 'aumf')". The AU type is part of the plugin's
    # IDENTITY, so correcting it after a ship would break saved projects — the
    # very thing declaring the MIDI port early exists to prevent. Half-
    # committing to MIDI would have cost exactly what not committing would.
    # The gate line is therefore `auval -v aumf ScTp Scpy`.
    AU_MAIN_TYPE kAudioUnitType_MusicEffect
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "Scoopy Tape records audio routed to its input."
    COPY_PLUGIN_AFTER_BUILD TRUE)

target_sources(ScoopyTape PRIVATE
    src/ScoopyTapeProcessor.cpp
    src/ScoopyTapeEditor.cpp
    src/PluginBackend.cpp
    src/EmbeddedWeb.cpp
    src/PeerRegistry.cpp
    src/HostSync.cpp)

target_include_directories(ScoopyTape PRIVATE
    src
    ${CMAKE_SOURCE_DIR}/shell/src
    ${CMAKE_SOURCE_DIR}/host/src
    ${CMAKE_SOURCE_DIR}/slengine/include
    ${CMAKE_SOURCE_DIR}/slengine/generated)

target_compile_definitions(ScoopyTape PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0)
# No MERGED_WEBDIST_DIR, same ruling as the deck: this target must not be ABLE
# to read the source tree. The bundle arrives through ScoopyPluginWebDist.

target_link_libraries(ScoopyTape PRIVATE
    ScoopyPluginWebDist
    wz_sl_engine
    wz_sl_command
    wz_sl_world
    wz_sl_settings   # FileSettingsStore, under ScoopyTape/ — see PluginBackend
    wz_record        # takes + the drain thread, shared library with the app
    wz_webresources
    juce::juce_audio_utils
    juce::juce_gui_extra
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_include_directories(ScoopyTape PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(ScoopyTape PRIVATE
        JUCE_PLUGINHOST_AU=1
        JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(ScoopyTape PRIVATE juce::juce_audio_processors)
endif()

# ─────────────────────────────────────────────────────────────────────────────
# THE GATE: the processor, headless, with no DAW and no window server.
#
# It compiles the same sources the plugin does (never a copy) and drives them
# through prepareToPlay/processBlock with a fake AudioPlayHead. Three claims no
# green build proves: that it makes SOUND, that it FOLLOWS the host's tempo, and
# that TWO instances in one process do not share hidden state — the last being
# the one real unknown about the vendored core in a DAW.
# ─────────────────────────────────────────────────────────────────────────────
add_executable(plugin_processor_test
    tools/plugin_processor_test.cpp
    src/ScoopyPluginProcessor.cpp
    src/ScoopyPluginEditor.cpp
    src/PluginBackend.cpp
    src/EmbeddedWeb.cpp
    src/PeerRegistry.cpp
    src/HostSync.cpp
    src/LaneMap.cpp)

target_include_directories(plugin_processor_test PRIVATE
    src
    ${CMAKE_SOURCE_DIR}/shell/src
    ${CMAKE_SOURCE_DIR}/host/src
    ${CMAKE_SOURCE_DIR}/slengine/include
    # The GENERATED HotFrame lane enum, so the playhead gate can name a lane
    # rather than hard-code its index — the indices are generated precisely
    # because hand-counting them drifts (see sl_hotframe.inc's header).
    ${CMAKE_SOURCE_DIR}/slengine/generated)

target_compile_definitions(plugin_processor_test PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_STANDALONE_APPLICATION=1)

target_link_libraries(plugin_processor_test PRIVATE
    ScoopyPluginWebDist
    wz_sl_engine wz_sl_command wz_sl_world wz_sl_settings wz_record wz_webresources
    juce::juce_audio_utils
    juce::juce_gui_extra
    juce::juce_recommended_config_flags)

if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_include_directories(plugin_processor_test PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(plugin_processor_test PRIVATE
        JUCE_PLUGINHOST_AU=1 JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(plugin_processor_test PRIVATE juce::juce_audio_processors)
endif()

add_test(NAME plugin_processor_test COMMAND plugin_processor_test)

# THE UI IS ACTUALLY IN THE BINARY. Proves the archive is populated and that
# its path handling refuses traversal — the half of the resource provider that
# is security-relevant, and the half a blank editor would not tell you about.
# GUI-free: no WebView, no window server.
add_executable(embedded_web_test tools/embedded_web_test.cpp src/EmbeddedWeb.cpp)
target_include_directories(embedded_web_test PRIVATE src ${CMAKE_SOURCE_DIR}/shell/src)
target_link_libraries(embedded_web_test PRIVATE
    ScoopyPluginWebDist wz_webresources juce::juce_recommended_config_flags)
add_test(NAME embedded_web_test COMMAND embedded_web_test)

# THE INSERT DOES NOT EAT THE TRACK. ScoopyTape's counterpart to
# plugin_processor_test: an effect's first duty is passing its input through,
# and every way of failing that is silent in a session.
add_executable(tape_plugin_processor_test
    tools/tape_plugin_processor_test.cpp
    src/ScoopyTapeProcessor.cpp
    src/ScoopyTapeEditor.cpp
    src/PluginBackend.cpp
    src/EmbeddedWeb.cpp
    src/PeerRegistry.cpp
    src/HostSync.cpp)

target_include_directories(tape_plugin_processor_test PRIVATE
    src
    ${CMAKE_SOURCE_DIR}/shell/src
    ${CMAKE_SOURCE_DIR}/host/src
    ${CMAKE_SOURCE_DIR}/slengine/include
    ${CMAKE_SOURCE_DIR}/slengine/generated)

target_compile_definitions(tape_plugin_processor_test PRIVATE
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_STANDALONE_APPLICATION=1)

target_link_libraries(tape_plugin_processor_test PRIVATE
    ScoopyPluginWebDist
    wz_sl_engine wz_sl_command wz_sl_world wz_sl_settings wz_record wz_webresources
    juce::juce_audio_utils
    juce::juce_gui_extra
    juce::juce_recommended_config_flags)

if(APPLE AND SCOOPY_PLUGIN_HOST_ENABLED)
    target_include_directories(tape_plugin_processor_test PRIVATE ${CMAKE_SOURCE_DIR}/ScoopyLoops)
    target_compile_definitions(tape_plugin_processor_test PRIVATE
        JUCE_PLUGINHOST_AU=1 JUCE_PLUGINHOST_VST3=1)
    target_link_libraries(tape_plugin_processor_test PRIVATE juce::juce_audio_processors)
endif()

add_test(NAME tape_plugin_processor_test COMMAND tape_plugin_processor_test)

# Same JUCE 8 gap as the shell's WebView targets: juce_gui_extra declares no
# linuxPackages, so nothing supplies the GTK/WebKit headers it includes.
if(UNIX AND NOT APPLE)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
    pkg_check_modules(WEBKIT2GTK REQUIRED webkit2gtk-4.1)
    foreach(_t ScoopyDeck plugin_processor_test ScoopyTape tape_plugin_processor_test)
        target_include_directories(${_t} PRIVATE ${GTK3_INCLUDE_DIRS} ${WEBKIT2GTK_INCLUDE_DIRS})
        target_link_libraries(${_t} PRIVATE ${GTK3_LIBRARIES} ${WEBKIT2GTK_LIBRARIES})
    endforeach()
endif()
