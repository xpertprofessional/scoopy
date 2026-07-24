# Device I/O is a HOST concern (docs/ARCHITECTURE.md §1 shell law: the shell may
# hold only transport/chrome/dialogs). JUCE device code lives here. Capture
# backends (macOS taps, Linux PipeWire) and the WAV writer join this tier in
# P2/P3.
add_library(wz_audio_io STATIC src/AudioIO.cpp)
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

# RecordService (P3-05): drain thread engine -> WavWriter. Links wz_engine for
# the drain ABI; no JUCE (this tier stays portable).
add_library(wz_record STATIC src/RecordService.cpp)
target_include_directories(wz_record PUBLIC src)
target_link_libraries(wz_record PUBLIC wz_wav PRIVATE wz_engine)

add_executable(recorder_drain_test tools/recorder_drain_test.cpp)
target_link_libraries(recorder_drain_test PRIVATE wz_record wz_engine)
add_test(NAME recorder_drain_test COMMAND recorder_drain_test)

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
