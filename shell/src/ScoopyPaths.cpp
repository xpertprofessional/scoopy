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

} // namespace

juce::File dataRoot(const juce::File& appSupport, juce::String* outNote) {
    const auto fresh = appSupport.getChildFile(kDirName);
    const auto legacy = appSupport.getChildFile(kLegacyDirName);

    // Already migrated, or a clean install that never had the old name. The
    // common path, and it touches nothing.
    if (fresh.isDirectory()) return fresh;

    // No old library either: first run. Create and go.
    if (!hasContent(legacy)) {
        fresh.createDirectory();
        return fresh;
    }

    // THE MIGRATION. Copy — the old directory survives this untouched, so a
    // wrong answer here costs nothing and an older build still finds its
    // library exactly where it left it.
    if (legacy.copyDirectoryTo(fresh)) {
        if (outNote != nullptr)
            *outNote = juce::String("migrated the library ") + kLegacyDirName + " -> " + kDirName +
                       " (the original is untouched at " + legacy.getFullPathName() + ")";
        return fresh;
    }

    // THE COPY FAILED — disk full, permissions, a file open elsewhere. Run
    // against the OLD root rather than a half-copied new one: a partial library
    // is a session list with holes in it, which reads as data loss and is much
    // worse than an old directory name. Remove the debris so the next launch
    // retries cleanly instead of finding a "migrated" root that is missing half
    // the user's work.
    fresh.deleteRecursively();
    if (outNote != nullptr)
        *outNote = juce::String("could not migrate to ") + kDirName + " — still using " +
                   kLegacyDirName + " (nothing was lost)";
    return legacy;
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
