#include "ScoopyPaths.h"

namespace wizard::paths {

namespace {

/** Is there anything in here worth carrying across? An empty legacy directory
    (or one holding only a stray .DS_Store) is not a library, and treating it as
    one would announce a migration that moved nothing. */
bool hasContent(const juce::File& dir) {
    if (!dir.isDirectory()) return false;
    for (const auto& e : juce::RangedDirectoryIterator(dir, false, "*",
                                                       juce::File::findFilesAndDirectories)) {
        if (e.getFile().getFileName().startsWithChar('.')) continue;
        return true;
    }
    return false;
}

/**
 * Copy `from` into `to`, ADDING ONLY WHAT IS MISSING. Never overwrites.
 *
 * ⚠️ THIS IS A MERGE, NOT A COPY, AND THAT IS THE WHOLE DESIGN. The destination
 * is shared: `ScoopyLoops/` already holds the original app's data and Pulsar's
 * snapshot bank, and it exists on machines that have never run this app at all.
 * A `copyDirectoryTo` into a live directory would put this migration in the
 * business of overwriting files it has never seen and does not own.
 *
 * Returns false if any single file could not be written, so the caller can
 * report a partial result rather than claim success.
 */
bool mergeMissing(const juce::File& from, const juce::File& to) {
    bool ok = true;
    for (const auto& e :
         juce::RangedDirectoryIterator(from, false, "*", juce::File::findFilesAndDirectories)) {
        const auto src = e.getFile();
        const auto dst = to.getChildFile(src.getFileName());
        if (src.isDirectory()) {
            if (!dst.exists() && !dst.createDirectory()) { ok = false; continue; }
            if (dst.isDirectory() && !mergeMissing(src, dst)) ok = false;
        } else if (!dst.exists()) {
            if (!src.copyFileTo(dst)) ok = false;
        }
        // `dst` already exists → LEAVE IT. The destination's copy is the live
        // one; the legacy tree is a snapshot of an older name.
    }
    return ok;
}

} // namespace

juce::File dataRoot(const juce::File& appSupport, juce::String* outNote) {
    const auto root = appSupport.getChildFile(kDirName);
    const auto legacy = appSupport.getChildFile(kLegacyDirName);
    const auto marker = root.getChildFile(kMigrationMarker);

    // DONE ALREADY. The marker is what makes this safe to run on every launch:
    // without it, a merge would RESURRECT anything the user deleted after
    // migrating, because the legacy tree still has it and the destination no
    // longer does. A deleted session coming back is its own kind of data bug.
    if (marker.existsAsFile()) return root;

    root.createDirectory();

    if (!hasContent(legacy)) {
        // Nothing to carry — a clean install, or a machine that only ever ran
        // the original app. Stamp it so this never scans again.
        marker.replaceWithText("no legacy library was present\n");
        return root;
    }

    if (mergeMissing(legacy, root)) {
        marker.replaceWithText(juce::String("merged from ") + kLegacyDirName + "\n");
        if (outNote != nullptr)
            *outNote = juce::String("merged the library ") + kLegacyDirName + " -> " + kDirName +
                       " (the original is untouched at " + legacy.getFullPathName() + ")";
        return root;
    }

    // A FILE DID NOT ARRIVE. No marker is written, so the next launch tries
    // again — and because the merge only ever ADDS, retrying is safe and
    // finishes the job rather than duplicating it. Whatever did copy stays:
    // unlike a whole-tree copy there is no half-built root to clean up, since
    // every file that landed is a real file in its final place.
    if (outNote != nullptr)
        *outNote = juce::String("could not fully merge ") + kLegacyDirName + " into " + kDirName +
                   " — will retry next launch (nothing was lost or overwritten)";
    return root;
}

juce::File dataRoot() {
    juce::String note;
    const auto root =
        dataRoot(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory), &note);
    // Said once, on the launch that does it. A migration that happens silently
    // is one nobody can confirm afterwards.
    if (note.isNotEmpty()) juce::Logger::writeToLog("scoopy: " + note);
    return root;
}

} // namespace wizard::paths
