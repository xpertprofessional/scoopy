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
