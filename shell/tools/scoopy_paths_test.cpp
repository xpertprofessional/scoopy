// The rename's migration (D-SL-RENAME-01). Headless, against a temp tree —
// because the alternative is testing it on somebody's real library.
//
// What is being defended: the data root holds the SHARED SESSION LIBRARY, and
// ScoopyDeck's saved DAW projects reference sessions in it BY NAME. A migration
// that loses it fails silently, later, in someone's set.
#include "ScoopyPaths.h"

#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

using namespace wizard::paths;

namespace {

/** A library that looks like a real one: a session under Library/sessions, a
    take, and a settings file — the three things a user would notice missing. */
void seedLibrary(const juce::File& root) {
    root.getChildFile("Library/sessions/Beach").createDirectory();
    root.getChildFile("Library/sessions/Beach/pattern.json").replaceWithText("{\"bpm\":120}");
    root.getChildFile("Takes").createDirectory();
    root.getChildFile("Takes/deck0_take.wav").replaceWithText("RIFF");
    root.getChildFile("settings.json").replaceWithText("{\"recordings.dir\":\"\"}");
}

bool libraryIntact(const juce::File& root) {
    return root.getChildFile("Library/sessions/Beach/pattern.json").loadFileAsString().contains(
               "120") &&
           root.getChildFile("Takes/deck0_take.wav").existsAsFile() &&
           root.getChildFile("settings.json").existsAsFile();
}

} // namespace

int main() {
    const auto tmp =
        juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("scoopy-paths-test");

    // ── 1. First run: no old library, no new one. Creates and returns the new.
    {
        tmp.deleteRecursively();
        tmp.createDirectory();
        const auto root = dataRoot(tmp);
        CHECK(root == tmp.getChildFile(kDirName));
        CHECK(root.isDirectory());
    }

    // ── 2. THE MIGRATION. An old library is COPIED, and the original stays.
    {
        tmp.deleteRecursively();
        tmp.createDirectory();
        const auto legacy = tmp.getChildFile(kLegacyDirName);
        seedLibrary(legacy);

        juce::String note;
        const auto root = dataRoot(tmp, &note);

        CHECK(root == tmp.getChildFile(kDirName));
        // The user's work arrived, whole.
        CHECK(libraryIntact(root));
        // …and the original is UNTOUCHED. This is the promise that makes the
        // rename safe to ship: if any of it is wrong, nothing was lost, and an
        // older build still finds its library where it left it.
        CHECK(libraryIntact(legacy));
        CHECK(note.isNotEmpty()); // it says so, rather than migrating silently
    }

    // ── 3. IDEMPOTENT. A second launch migrates nothing and disturbs nothing —
    //       including edits made AFTER the migration, which must not be
    //       overwritten by the stale copy still sitting at the old path.
    {
        tmp.deleteRecursively();
        tmp.createDirectory();
        seedLibrary(tmp.getChildFile(kLegacyDirName));
        const auto first = dataRoot(tmp);
        first.getChildFile("Library/sessions/Beach/pattern.json").replaceWithText("{\"bpm\":174}");

        juce::String note;
        const auto second = dataRoot(tmp, &note);
        CHECK(second == first);
        CHECK(second.getChildFile("Library/sessions/Beach/pattern.json")
                  .loadFileAsString()
                  .contains("174"));
        CHECK(note.isEmpty()); // nothing happened, so nothing is announced
    }

    // ── 4. THE PERMANENT FALLBACK. This is not a migration-season courtesy: if
    //       the new root is absent and an old library exists, the old one is
    //       used. Simulated by making the new path un-creatable — a FILE where
    //       the directory would go, which is what a failed copy leaves behind.
    {
        tmp.deleteRecursively();
        tmp.createDirectory();
        const auto legacy = tmp.getChildFile(kLegacyDirName);
        seedLibrary(legacy);
        tmp.getChildFile(kDirName).replaceWithText("not a directory");

        juce::String note;
        const auto root = dataRoot(tmp, &note);

        // Whatever it returns, it must be a root whose library is COMPLETE.
        // Running against a half-copied library is worse than an old name.
        CHECK(libraryIntact(root));
        CHECK(libraryIntact(legacy));
    }

    // ── 5. An EMPTY legacy directory is not a library. A dotfile-only folder
    //       (a stray .DS_Store) must not announce a migration that moved
    //       nothing — this is the case that would make the log line lie.
    {
        tmp.deleteRecursively();
        tmp.createDirectory();
        const auto legacy = tmp.getChildFile(kLegacyDirName);
        legacy.createDirectory();
        legacy.getChildFile(".DS_Store").replaceWithText("x");

        juce::String note;
        const auto root = dataRoot(tmp, &note);
        CHECK(root == tmp.getChildFile(kDirName));
        CHECK(note.isEmpty());
    }

    tmp.deleteRecursively();
    std::printf("scoopy_paths_test OK\n");
    return 0;
}
