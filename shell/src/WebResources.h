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

/** Normalise a WebView request path to a bundle-relative path: strip the query
    and fragment, strip leading slashes, and map "" to index.html (SPA entry).

    Returns nullopt when the path attempts to ESCAPE the bundle — any `..`
    segment is refused outright rather than resolved.

    Extracted at the plugin work (D-SL-DECKPLUGIN-01) so there is exactly ONE
    implementation of the security-relevant half. `load()` serves a directory
    and the plugin serves an embedded archive; a second host quietly growing
    its own path parser is how a containment check gets bypassed. */
std::optional<juce::String> normaliseRequestPath(const juce::String& path);

/** Resolves a WebView request path against the bundle root.
    Returns nullopt when the path escapes the root or names no file.
    "/" and "" both resolve to index.html (SPA entry point). */
std::optional<Payload> load(const juce::File& root, const juce::String& path);

/** Navigation policy: may the WebView load `url`?

    An ALLOWLIST — the app itself and nothing else. Without this, dropping a
    file on the window NAVIGATES the browser to that file, silently replacing
    the running app and losing every bit of UI state (found by the P1 spike's
    human pass, docs/archive/P1-SPIKE-JUCE-WEBVIEW.md §Q3). `preventDefault()` in
    the page does NOT stop it — the decision is made above the DOM, so it has to
    be made here.

    A denylist of `file://` would be the tempting shape and the wrong one: the
    shell should ever navigate to exactly one place, and enumerating what to
    forbid is how guards like this get bypassed.

    `about:blank` is WebKit's own scratch page during setup, not a navigation
    away from the app. An empty root means nothing is the app yet, so nothing
    is allowed. */
bool navigationAllowed(const juce::String& url, const juce::String& resourceRoot);

} // namespace wizard::webresources
