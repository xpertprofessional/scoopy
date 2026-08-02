// The library merge (D-SL-RENAME-01). Headless, against a temp tree — because
// the alternative is testing it on somebody's real library.
//
// What is being defended: the data root holds the SHARED SESSION LIBRARY, and
// ScoopyDeck's saved DAW projects reference sessions in it BY NAME. A migration
// that loses one fails silently, later, in someone's set.
//
// ⚠️ THE DESTINATION IS SHARED AND PRE-EXISTING. `ScoopyLoops/` already holds the
// original app's data and Pulsar's snapshot bank on machines that have never run
// this app. So this is a MERGE that may only ever ADD — half these cases exist to
// prove it cannot clobber, cannot resurrect, and cannot half-finish.
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

/** A library that looks like a real one: a session, a take, and settings — the
    three things a user would notice missing. */
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
    const auto reset = [&] {
        tmp.deleteRecursively();
        tmp.createDirectory();
    };

    // ── 1. First run, nothing anywhere. Creates the root and stamps it.
    {
        reset();
        const auto root = dataRoot(tmp);
        CHECK(root == tmp.getChildFile(kDirName));
        CHECK(root.isDirectory());
        CHECK(root.getChildFile(kMigrationMarker).existsAsFile());
    }

    // ── 2. THE MERGE. A legacy library arrives, and the original is untouched.
    {
        reset();
        const auto legacy = tmp.getChildFile(kLegacyDirName);
        seedLibrary(legacy);

        juce::String note;
        const auto root = dataRoot(tmp, &note);

        CHECK(root == tmp.getChildFile(kDirName));
        CHECK(libraryIntact(root));
        // The promise that makes this safe to ship: if any of it is wrong,
        // nothing was lost and an older build still finds its library.
        CHECK(libraryIntact(legacy));
        CHECK(note.isNotEmpty()); // it says so, rather than merging silently
    }

    // ── 3. IT MUST NOT CLOBBER. The destination pre-exists and is not ours:
    //       the original app's data and Pulsar's bank live here. Anything
    //       already present wins; only what is MISSING is added.
    {
        reset();
        const auto legacy = tmp.getChildFile(kLegacyDirName);
        seedLibrary(legacy);

        const auto root = tmp.getChildFile(kDirName);
        root.getChildFile("Pulsar").createDirectory();
        root.getChildFile("Pulsar/snapshots.xml").replaceWithText("<SNAPSHOTS/>");
        // The SAME relative path as the legacy tree, with different content.
        root.getChildFile("Library/sessions/Beach").createDirectory();
        root.getChildFile("Library/sessions/Beach/pattern.json").replaceWithText("{\"bpm\":174}");

        dataRoot(tmp);

        // The live file survives; the legacy one did NOT overwrite it.
        CHECK(root.getChildFile("Library/sessions/Beach/pattern.json")
                  .loadFileAsString()
                  .contains("174"));
        // A neighbour's file is untouched…
        CHECK(root.getChildFile("Pulsar/snapshots.xml").loadFileAsString().contains("SNAPSHOTS"));
        // …and what was genuinely missing still arrived.
        CHECK(root.getChildFile("Takes/deck0_take.wav").existsAsFile());
    }

    // ── 4. IT MUST NOT RESURRECT. Delete a session after migrating; a second
    //       launch must not bring it back from the legacy tree, which still has
    //       it. This is what the marker is for, and without it the merge would
    //       quietly undo a deletion on every launch.
    {
        reset();
        seedLibrary(tmp.getChildFile(kLegacyDirName));
        const auto root = dataRoot(tmp);
        CHECK(root.getChildFile("Library/sessions/Beach").isDirectory());

        root.getChildFile("Library/sessions/Beach").deleteRecursively();

        juce::String note;
        CHECK(dataRoot(tmp, &note) == root);
        CHECK(!root.getChildFile("Library/sessions/Beach").exists()); // stays deleted
        CHECK(note.isEmpty());                                       // nothing happened
    }

    // ── 5. IDEMPOTENT for edits too: a change made AFTER the merge is not
    //       reverted by the stale copy still sitting at the legacy path.
    {
        reset();
        seedLibrary(tmp.getChildFile(kLegacyDirName));
        const auto root = dataRoot(tmp);
        root.getChildFile("Library/sessions/Beach/pattern.json").replaceWithText("{\"bpm\":174}");

        dataRoot(tmp);
        CHECK(root.getChildFile("Library/sessions/Beach/pattern.json")
                  .loadFileAsString()
                  .contains("174"));
    }

    // ── 6. An EMPTY legacy directory is not a library. A dotfile-only folder
    //       must not announce a merge that moved nothing — the case that would
    //       make the log line lie.
    {
        reset();
        const auto legacy = tmp.getChildFile(kLegacyDirName);
        legacy.createDirectory();
        legacy.getChildFile(".DS_Store").replaceWithText("x");

        juce::String note;
        const auto root = dataRoot(tmp, &note);
        CHECK(root == tmp.getChildFile(kDirName));
        CHECK(note.isEmpty());
    }

    // ── 7. A TYPE COLLISION IS A SKIP, NOT A FAILURE. If something else owns
    //       that name — here a DIRECTORY where `settings.json` would go — the
    //       merge leaves it. This is the non-clobber rule doing its job on the
    //       nastiest input, and it is why the destination being shared with
    //       another app is safe.
    {
        reset();
        seedLibrary(tmp.getChildFile(kLegacyDirName));
        const auto root = tmp.getChildFile(kDirName);
        root.getChildFile("settings.json").createDirectory(); // occupied, wrong type

        dataRoot(tmp);
        CHECK(root.getChildFile("settings.json").isDirectory());    // untouched
        CHECK(root.getChildFile("Takes/deck0_take.wav").existsAsFile()); // rest arrived
    }

    // ── 8. A PARTIAL MERGE RETRIES. A read-only destination directory makes a
    //       real write fail, so NO marker is stamped and the next launch
    //       finishes the job. Safe precisely because the merge only ever adds —
    //       there is no half-built root, only files that have or have not
    //       arrived yet.
    {
        reset();
        seedLibrary(tmp.getChildFile(kLegacyDirName));
        const auto root = tmp.getChildFile(kDirName);
        const auto takes = root.getChildFile("Takes");
        takes.createDirectory();
        takes.setReadOnly(true);

        juce::String note;
        dataRoot(tmp, &note);
        const bool blocked = !takes.getChildFile("deck0_take.wav").existsAsFile();
        takes.setReadOnly(false); // always restore, or the temp tree cannot be removed

        if (blocked) {
            // The write really was refused: no marker, and it says so.
            CHECK(!root.getChildFile(kMigrationMarker).existsAsFile());
            CHECK(note.isNotEmpty());
            // The retry completes and stamps it.
            dataRoot(tmp);
            CHECK(takes.getChildFile("deck0_take.wav").existsAsFile());
            CHECK(root.getChildFile(kMigrationMarker).existsAsFile());
        } else {
            // Some filesystems (and root) ignore the read-only bit. Skip rather
            // than assert a premise the platform did not honour — a test that
            // fails for the wrong reason teaches nothing.
            std::printf("  (skipped case 8: this filesystem ignored read-only)\n");
        }
    }

    tmp.deleteRecursively();
    std::printf("scoopy_paths_test OK\n");
    return 0;
}
