# Device I/O is a HOST concern (docs/ARCHITECTURE.md §1 shell law: the shell may
# hold only transport/chrome/dialogs). JUCE device code lives here. Capture
# backends (macOS taps, Linux PipeWire) and the WAV writer join this tier in
# P2/P3.
add_library(wz_audio_io STATIC src/AudioIO.cpp src/RenderSink.cpp)
target_include_directories(wz_audio_io PUBLIC src)
target_link_libraries(wz_audio_io
    PUBLIC juce::juce_audio_devices   # AudioIO.h uses JUCE types in its interface
    PRIVATE wz_engine                 # header only forward-declares wz_engine
            juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

# Host file decode for deck loading (JUCE backend + vendored libsamplerate for
# the D-WZ-DECKSRC-01 load-time SINC_BEST conversion). Backend-neutral surface.
add_library(wz_decode STATIC src/Decoder.cpp)
target_include_directories(wz_decode PUBLIC src)
target_link_libraries(wz_decode
    PUBLIC juce::juce_core            # Decoder.h uses juce::File/String in its interface
    PRIVATE juce::juce_audio_formats samplerate
            juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(decode_test tools/decode_test.cpp)
target_link_libraries(decode_test PRIVATE wz_decode wz_engine juce::juce_audio_formats)
add_test(NAME decode_test COMMAND decode_test)

# P1-11: the progress + cancellation contract the async shell wiring relies on.
add_executable(decode_progress_test tools/decode_progress_test.cpp)
target_link_libraries(decode_progress_test PRIVATE wz_decode juce::juce_audio_formats)
add_test(NAME decode_progress_test COMMAND decode_progress_test)

# Capture layer (P2): the wz_capture.h backends. The deterministic fake backend
# is the fixture substrate for source rings + ASRC; mac/pipewire backends join
# this lib in P2-05/07 behind the same ABI. Dependency-free (no JUCE, no
# platform APIs) so it links into headless test tools.
add_library(wz_capture STATIC src/CaptureFake.cpp)
target_include_directories(wz_capture PUBLIC include)

add_executable(capture_fake_test tools/capture_fake_test.cpp)
target_link_libraries(capture_fake_test PRIVATE wz_capture)
add_test(NAME capture_fake_test COMMAND capture_fake_test)

# Crash-safe take writer (D-WZ-CORE-02): dependency-free portable C++ — no JUCE,
# no platform headers — so a future WASM/companion build reuses it verbatim.
add_library(wz_wav STATIC src/WavWriter.cpp)
target_include_directories(wz_wav PUBLIC src)

add_executable(wav_killtest tools/wav_killtest.cpp)
target_link_libraries(wav_killtest PRIVATE wz_wav)
add_test(NAME wav_killtest COMMAND wav_killtest)

# RecordService (P3-05): drain thread engine -> WavWriter. No JUCE (this tier
# stays portable) and, since the merge, NO ENGINE either: the engine sits behind
# TakeDrainSource, so this one implementation serves wizard's decks and the
# merged engine's tapes, and a host drags only the engine it constructs.
add_library(wz_record STATIC src/RecordService.cpp src/TakeScan.cpp)
target_include_directories(wz_record PUBLIC src)
target_link_libraries(wz_record PUBLIC wz_wav)

# The wizard-engine binding of that seam, end to end (deck -> drain -> WAV).
# Finding takes from PREVIOUS sessions — what makes "reloadable into a tape
# later" survive a restart. Enumeration only; the document layer parses.
add_executable(take_scan_test tools/take_scan_test.cpp)
target_link_libraries(take_scan_test PRIVATE wz_record)
add_test(NAME take_scan_test COMMAND take_scan_test)

add_executable(recorder_drain_test tools/recorder_drain_test.cpp)
target_link_libraries(recorder_drain_test PRIVATE wz_record wz_engine)
add_test(NAME recorder_drain_test COMMAND recorder_drain_test)

# The MERGED-engine binding of the same seam, and the fixture that pins the
# LAW C-2 STAMP CHAIN end to end: two staggered tape takes, with the delta read
# back out of the bext TimeReference in the FILES. The engine's stamp is proven
# by sl_tape_record_test and the writer by wav_killtest; this covers the hop
# between them, which is exactly where the value has been dropped before.
add_executable(sl_take_drain_test tools/sl_take_drain_test.cpp)
target_link_libraries(sl_take_drain_test PRIVATE wz_record wz_sl_engine)
add_test(NAME sl_take_drain_test COMMAND sl_take_drain_test)

# Session file persistence (P7-06). Extracted from the shell so the ATOMICITY of
# the write is testable headlessly — a half-written session is the one failure
# that would make autosave worse than not having it.
add_library(wz_session STATIC src/SessionStore.cpp)
target_include_directories(wz_session PUBLIC src)
target_link_libraries(wz_session
    PUBLIC juce::juce_core
    PRIVATE juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(session_store_test tools/session_store_test.cpp)
target_link_libraries(session_store_test PRIVATE wz_session)
add_test(NAME session_store_test COMMAND session_store_test)

# `.wizard` package (P7-04): STORED zip of session.json + Takes/. Separate from
# wz_session because the package is what a user SHARES, while the autosave is
# what saves them — different lifetimes, different failure modes.
add_library(wz_package STATIC src/PackageStore.cpp)
target_include_directories(wz_package PUBLIC src)
target_link_libraries(wz_package
    PUBLIC juce::juce_core
    PRIVATE juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

add_executable(package_store_test tools/package_store_test.cpp)
target_link_libraries(package_store_test PRIVATE wz_package)
add_test(NAME package_store_test COMMAND package_store_test)

# The device callback's arithmetic (chunking, offsetting, ceilings) plus proof
# that SL ABI v3 renders through the same seam wizard's engine does. Links both
# engines because it drives both sinks — the ONE place that is legitimate.
add_executable(render_sink_test tools/render_sink_test.cpp)
target_link_libraries(render_sink_test PRIVATE wz_audio_io wz_engine wz_sl_engine)
add_test(NAME render_sink_test COMMAND render_sink_test)
