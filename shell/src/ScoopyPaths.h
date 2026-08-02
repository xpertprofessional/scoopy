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
 *   2. THE FALLBACK IS PERMANENT, not a migration-season courtesy. If the new
 *      root is absent and the old one exists, the old one is USED. A migration
 *      that fails must degrade to "still works", never to "empty".
 *   3. NEVER PARTIAL. A copy that fails part-way returns the OLD root, so the
 *      app runs against the complete library rather than a half-copied one.
 *      Half a library is worse than the old name.
 */

/** The name the data directory has had since the wizard era. Still read. */
inline constexpr const char* kLegacyDirName = "WizardMerged";
/** The name it has now — line-wide, and shared with `theme.json` (D-SL-THEME-01). */
inline constexpr const char* kDirName = "Scoopy";

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
