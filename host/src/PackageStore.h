// `.wizard` package read/write (P7-04, sessions.md §2).
//
// A STORED (uncompressed) zip holding `session.json` + `Takes/`. STORED because
// the payload is already-compressed audio, so deflate buys nothing but CPU.
//
// The package is what a user SHARES; the autosave is what saves them. The
// difference that matters is portability: session.json references takes by
// ABSOLUTE path, which is meaningless on someone else's machine, so the package
// carries the take files themselves and load hands back where they landed.
//
// Samples (the user's own library) are deliberately NOT embedded — copying
// someone's sample library into our package is not ours to do (spec §1).
#pragma once

#include <juce_core/juce_core.h>

namespace wizard::package {

/** One take carried inside the package. */
struct Entry {
    juce::File source;   ///< where it lives now (write) / where it landed (read)
    juce::String name;   ///< its name inside Takes/, unique within the package
};

struct SaveResult {
    bool ok = false;
    juce::String error;
    /** Takes that could not be read — the package is still written WITHOUT
        them rather than failing outright, because a package missing one take is
        far more useful than no package at all. Reported, never silent. */
    juce::StringArray missing;
};

struct LoadResult {
    bool ok = false;
    juce::String error;
    juce::String sessionText;
    /** Extracted takes, in package order. Empty `name` never occurs. */
    juce::Array<Entry> takes;
};

/** Write `sessionText` + `takes` to `dest`, atomically (temp + rename), so an
    interrupted save never leaves a half-package where a good one was. */
SaveResult save(const juce::File& dest, const juce::String& sessionText,
                const juce::Array<Entry>& takes);

/** Read a package, extracting its takes into `takesDir` (created on demand).
    Existing files there are overwritten: the package is the authority for its
    own contents. */
LoadResult load(const juce::File& src, const juce::File& takesDir);

/** The name a take gets inside the package: its filename, de-duplicated against
    `used` so two takes called `take.wav` from different folders both survive.
    Exposed for testing — collision handling is where this kind of code rots. */
juce::String entryNameFor(const juce::File& take, juce::StringArray& used);

} // namespace wizard::package
