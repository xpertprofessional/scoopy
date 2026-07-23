// Resource-provider payload lookup for the shell's WebView.
//
// Kept separate from Main.cpp so it is testable without a GUI: the URL→file
// mapping is security-relevant (a page requesting "../../secrets" must not
// escape the bundle root) and must behave identically on macOS and Linux.
#pragma once

#include <juce_core/juce_core.h>

#include <optional>

namespace wizard::webresources {

struct Payload {
    juce::MemoryBlock data;
    juce::String mimeType;
};

juce::String mimeForExtension(const juce::String& extensionWithoutDot);

/** Resolves a WebView request path against the bundle root.
    Returns nullopt when the path escapes the root or names no file.
    "/" and "" both resolve to index.html (SPA entry point). */
std::optional<Payload> load(const juce::File& root, const juce::String& path);

} // namespace wizard::webresources
