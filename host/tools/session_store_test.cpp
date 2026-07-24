// P7-06: the session write must be ATOMIC, and the read must never start empty
// when a usable session exists somewhere.
//
// This is the fixture the extraction was for. Autosave that can leave a
// truncated file is worse than no autosave — the user would lose a session they
// believed was saved, silently.
#include "SessionStore.h"

#include <cstdio>
#include <string>

using namespace wizard::session;

static int failures = 0;
static void check(bool cond, const std::string& what) {
    if (!cond) {
        std::printf("FAIL: %s\n", what.c_str());
        ++failures;
    }
}

static juce::String doc(const juce::String& marker) {
    return "{\n  \"schemaVersion\": 12,\n  \"marker\": \"" + marker + "\"\n}\n";
}

int main() {
    juce::File dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("wz_session_store_test");
    dir.deleteRecursively();
    Store store(dir);

    // --- a first save on a virgin machine ------------------------------------
    check(store.read().source == Source::none, "nothing saved yet is 'none', not an error");
    check(store.write(doc("one")), "first write succeeds and creates the directory");
    {
        auto r = store.read();
        check(r.source == Source::primary, "reads back from the primary");
        check(r.text.contains("one"), "reads back what was written");
        check(!store.backup().existsAsFile(), "no backup yet: there was nothing to rotate");
        check(!store.temp().existsAsFile(), "the temp file never survives a successful write");
    }

    // --- the second save rotates the first ------------------------------------
    check(store.write(doc("two")), "second write succeeds");
    check(store.read().text.contains("two"), "the newest session is what loads");
    check(store.backup().loadFileAsString().contains("one"),
          "the PREVIOUS session is preserved as the backup");

    // --- a corrupt primary must not shadow a good backup ----------------------
    store.primary().replaceWithText("{ truncated half-writ");
    {
        auto r = store.read();
        check(r.source == Source::backup, "a corrupt primary falls back to the backup");
        check(r.text.contains("one"), "and the backup's CONTENT is what comes back");
    }

    // --- an EMPTY primary is the classic crash artifact ------------------------
    store.primary().replaceWithText("");
    check(store.read().source == Source::backup, "a zero-byte primary falls back too");

    // --- both unusable: report the primary so the user learns WHY -------------
    store.backup().replaceWithText("also broken {");
    store.primary().replaceWithText("{ broken");
    {
        auto r = store.read();
        check(r.source == Source::primary, "with nothing usable, hand back the primary");
        check(r.text.contains("broken"),
              "so the UI can explain the corruption instead of showing a blank app");
    }

    // --- truly nothing on disk -------------------------------------------------
    store.primary().deleteFile();
    store.backup().deleteFile();
    check(store.read().source == Source::none, "a genuinely empty dir is a first launch");

    // --- ATOMICITY: a stale temp file is never mistaken for a session ---------
    // This is what a crash mid-write actually leaves behind.
    check(store.write(doc("good")), "write a known-good session");
    store.temp().replaceWithText("{ \"schemaVersion\": 12, \"marker\": \"HALF");
    {
        auto r = store.read();
        check(r.source == Source::primary && r.text.contains("good"),
              "a leftover .tmp from a crashed write is INVISIBLE to the reader");
    }
    check(store.write(doc("three")), "the next write overwrites the stale temp cleanly");
    check(store.read().text.contains("three"), "and lands the new session");
    check(!store.temp().existsAsFile(), "leaving no temp behind");

    // --- a failed write must not destroy the good session ---------------------
    // Make the temp path un-writable by turning it into a NON-EMPTY directory:
    // it cannot be deleted and cannot be opened as a stream, so the write fails
    // at the earliest point. (An *empty* directory would simply be removed —
    // deleteFile clears those — and the write would correctly succeed.)
    store.temp().deleteFile();
    store.temp().createDirectory();
    store.temp().getChildFile("occupied").replaceWithText("x");
    const bool wrote = store.write(doc("should not land"));
    check(!wrote, "a write that cannot open its temp file reports failure");
    check(store.read().text.contains("three"),
          "and the PREVIOUS session is still intact — a failed save destroys nothing");
    store.temp().deleteRecursively();

    dir.deleteRecursively();
    if (failures == 0) std::printf("session_store_test OK\n");
    return failures == 0 ? 0 : 1;
}
