#pragma once

#include <juce_core/juce_core.h>

namespace wizard::paths {

/**
 * WHERE SCOOPY KEEPS THINGS, and the one-way migration off the wizard-era name
 * (D-SL-RENAME-01).
 *
 * ⚠️ THIS IS NOT A PREFERENCES PATH. The directory it returns holds the SHARED
 * SESSION LIBRARY — `<root>/Takes`, and `slFiles` derives `<root>/Library` from
 * it — which the app and BOTH plugins read, deliberately: *"sessions, samples
 * and takes belong to the PERSON, not to which face of scoopy they opened"*
 * (`PluginBackend.cpp`). ScoopyDeck's state chunk goes further and stores a
 * `sessionName` — a reference BY NAME into that library — so a DAW project
 * saved before the rename asks for a session by name after it.
 *
 * That is the whole risk of the rename, and it is silent and delayed: get it
 * wrong and `session ▾` lists nothing, in someone's set, weeks later.
 *
 * IT ALSO EXISTS BECAUSE THE PATH WAS WRITTEN TWICE. `MergedApp.cpp` and
 * `PluginBackend.cpp` each hardcoded `"WizardMerged/Takes"`. `PluginBackend`'s
 * own header records what happened the one time they disagreed — the plugin got
 * an empty world and the user reported "no load existing session". A rename that
 * left two copies would be that bug, pre-armed. One resolver, both callers.
 *
 * THE RULES, in the order they matter:
 *
 *   1. COPY, NEVER MOVE. The old directory is left exactly where it is. If any
 *      of this is wrong, nothing has been lost — the user's library is still at
 *      the old path and an older build still finds it.
 *   2. MERGE, NEVER OVERWRITE. The destination is SHARED (see `kDirName`) and
 *      pre-exists on most machines. Only missing entries are added; anything
 *      already there is left alone, because the destination's copy is the live
 *      one and this migration does not own it.
 *   3. ONCE, AND MARKED. A merge that ran on every launch would resurrect files
 *      deleted after the first one. The marker is what makes it idempotent in
 *      the way that matters.
 *   4. A PARTIAL MERGE RETRIES. If a file cannot be written the marker is not
 *      written either, so the next launch finishes the job. Safe precisely
 *      because the merge only ever adds — there is no half-built root, only
 *      files that have or have not arrived yet.
 */

/** The name the data directory has had since the wizard era. Still read. */
inline constexpr const char* kLegacyDirName = "WizardMerged";
/**
 * The line-wide root (user ruling, 2026-08-02): ONE directory for Studio, the
 * plugins, Pulsar's snapshot bank and — when D-SL-THEME-01 lands — `theme.json`.
 *
 * ⚠️ IT IS SHARED AND IT PRE-EXISTS. The original ScoopyLoops app writes here,
 * and Pulsar already keeps `Pulsar/snapshots.xml` here on machines that have
 * never run this app. That is why the migration MERGES and never overwrites:
 * this directory is not ours to clobber.
 */
inline constexpr const char* kDirName = "ScoopyLoops";

/** Written inside the root once the legacy merge is done (or found unnecessary).
    Without it, every launch would re-merge — and re-merging RESURRECTS anything
    deleted after the first one, because the legacy tree still has it. */
inline constexpr const char* kMigrationMarker = ".scoopy-library-merged";

/**
 * Resolve the data root under `appSupport`, migrating once if needed.
 *
 * `appSupport` is a parameter rather than a call to
 * `juce::File::getSpecialLocation` so this is testable against a temp directory:
 * a migration nobody can test on a throwaway tree is one that gets tested on a
 * user's library instead.
 *
 * @param outNote  optional: filled with a human-readable account of what
 *                 happened, for a log line. Empty when there was nothing to do.
 */
juce::File dataRoot(const juce::File& appSupport, juce::String* outNote = nullptr);

/** The real one, for the app and the plugins. */
juce::File dataRoot();

} // namespace wizard::paths
