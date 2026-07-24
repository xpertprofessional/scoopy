#include "PackageStore.h"

namespace wizard::package {

static constexpr const char* kSessionEntry = "session.json";
static constexpr const char* kTakesPrefix = "Takes/";
/** JUCE's compression level 0 == STORED. */
static constexpr int kStored = 0;

juce::String entryNameFor(const juce::File& take, juce::StringArray& used) {
    const auto base = take.getFileNameWithoutExtension();
    const auto ext = take.getFileExtension(); // includes the dot, or empty
    juce::String candidate = base + ext;
    int n = 2;
    // Two takes named take.wav from different folders must BOTH survive; the
    // alternative is one silently overwriting the other inside the package.
    while (used.contains(candidate, /*ignoreCase*/ true)) {
        candidate = base + " (" + juce::String(n++) + ")" + ext;
    }
    used.add(candidate);
    return candidate;
}

SaveResult save(const juce::File& dest, const juce::String& sessionText,
                const juce::Array<Entry>& takes) {
    SaveResult r;

    // session.json has to reach the builder as a file; stage everything in one
    // scratch dir so a failure cleans up in a single call.
    const auto scratch = dest.getSiblingFile(dest.getFileName() + ".staging");
    scratch.deleteRecursively();
    if (!scratch.createDirectory()) {
        r.error = "could not create a staging folder next to the destination";
        return r;
    }

    juce::ZipFile::Builder builder;
    const auto sessionFile = scratch.getChildFile(kSessionEntry);
    {
        // NOT replaceWithText: it rewrites line endings to CRLF by default,
        // which would corrupt the document and destroy the byte-stable re-save
        // the golden-corpus fixture depends on. Write the bytes as given.
        juce::FileOutputStream out(sessionFile);
        const bool staged =
            out.openedOk() && out.writeText(sessionText, false, false, nullptr);
        out.flush();
        if (!staged || !out.getStatus().wasOk()) {
            scratch.deleteRecursively();
            r.error = "could not stage session.json";
            return r;
        }
    }
    builder.addFile(sessionFile, kStored, kSessionEntry);

    juce::StringArray used;
    for (const auto& take : takes) {
        if (!take.source.existsAsFile()) {
            // Write the package anyway: one missing take is no reason to deny
            // the user a package of everything else. Reported, never silent.
            r.missing.add(take.source.getFullPathName());
            continue;
        }
        const auto name = take.name.isNotEmpty() ? take.name : entryNameFor(take.source, used);
        if (take.name.isNotEmpty()) used.add(name);
        builder.addFile(take.source, kStored, kTakesPrefix + name);
    }

    // ATOMIC, for the same reason the autosave is: write beside the target and
    // rename, so an interrupted save never replaces a good package with a
    // truncated one.
    const auto tmp = scratch.getChildFile("package.tmp");
    bool ok = false;
    {
        juce::FileOutputStream out(tmp);
        if (out.openedOk()) {
            double progress = 0.0;
            ok = builder.writeToStream(out, &progress);
            out.flush();
            ok = ok && out.getStatus().wasOk();
        }
    }
    if (ok) {
        dest.deleteFile();
        ok = tmp.moveFileTo(dest);
    }
    scratch.deleteRecursively();

    r.ok = ok;
    if (!ok) r.error = "could not write the package";
    return r;
}

LoadResult load(const juce::File& src, const juce::File& takesDir) {
    LoadResult r;
    if (!src.existsAsFile()) {
        r.error = "that package no longer exists";
        return r;
    }

    juce::ZipFile zip(src);
    const int count = zip.getNumEntries();
    if (count == 0) {
        r.error = "that file is not a Wizard package (no readable entries)";
        return r;
    }

    // session.json first — without it there is no document, and extracting
    // audio for a session we cannot read would just litter the disk.
    const int sessionIndex = zip.getIndexOfFileName(kSessionEntry);
    if (sessionIndex < 0) {
        r.error = "that package has no session.json";
        return r;
    }
    if (auto stream = std::unique_ptr<juce::InputStream>(zip.createStreamForEntry(sessionIndex)))
        r.sessionText = stream->readEntireStreamAsString();
    if (r.sessionText.trim().isEmpty()) {
        r.error = "that package's session.json is empty";
        return r;
    }

    for (int i = 0; i < count; ++i) {
        const auto* entry = zip.getEntry(i);
        if (entry == nullptr || !entry->filename.startsWith(kTakesPrefix)) continue;
        const auto name = entry->filename.substring((int)juce::String(kTakesPrefix).length());
        // A zip entry name is untrusted input: anything that escapes the takes
        // folder is refused rather than sanitised, because a package that tries
        // is not one we want to half-open.
        if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) {
            r.error = "that package contains an unsafe entry name: " + entry->filename;
            return r;
        }
        takesDir.createDirectory();
        // Stream the entry out by hand rather than uncompressEntry, which
        // recreates the entry's full path (landing takes in <dir>/Takes/) and
        // decides destinations from untrusted names. Here the destination is
        // ours: a validated leaf name inside takesDir, and nowhere else.
        const auto out = takesDir.getChildFile(name);
        out.deleteFile();
        auto in = std::unique_ptr<juce::InputStream>(zip.createStreamForEntry(i));
        if (in == nullptr) {
            r.error = "could not read " + entry->filename + " from the package";
            return r;
        }
        {
            juce::FileOutputStream os(out);
            if (!os.openedOk() || os.writeFromInputStream(*in, -1) < 0) {
                r.error = "could not extract " + entry->filename;
                return r;
            }
            os.flush();
        }
        r.takes.add({out, name});
    }

    r.ok = true;
    return r;
}

} // namespace wizard::package
