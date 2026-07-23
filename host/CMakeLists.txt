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
