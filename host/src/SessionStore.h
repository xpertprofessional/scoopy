// Session file persistence (P7-06, sessions.md §4).
//
// Extracted from the shell so the ATOMICITY can actually be tested — the same
// reason WebResources lives outside Main.cpp. A half-written session is the one
// failure mode that would make autosave worse than not having it, so the write
// discipline deserves a fixture rather than trust.
//
// Contract:
//   write  = temp file -> flush -> rotate current to .bak -> rename into place
//   read   = primary, else .bak, and SAY which one was used
// A crash at any instant leaves either the previous session or the new one.
//
// "else .bak" covers a primary that is missing, empty, OR not a document —
// a corrupt file that merely exists must not shadow a good backup.
#pragma once

#include <juce_core/juce_core.h>

namespace wizard::session {

enum class Source { none, primary, backup };

struct LoadResult {
    juce::String text;
    Source source = Source::none;
};

class Store {
public:
    /** `dir` is created on demand. */
    explicit Store(juce::File dir) : dir_(std::move(dir)) {}

    /** Atomic write. Returns false without disturbing the existing session if
        anything fails — a failed save must never destroy the last good one. */
    bool write(const juce::String& text) const;

    /** Primary, else backup, else empty. Never throws. */
    LoadResult read() const;

    juce::File primary() const { return dir_.getChildFile("session.json"); }
    juce::File backup() const { return dir_.getChildFile("session.json.bak"); }
    juce::File temp() const { return dir_.getChildFile("session.json.tmp"); }

private:
    juce::File dir_;
};

} // namespace wizard::session
