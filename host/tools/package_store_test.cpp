// P7-04: the `.wizard` package must survive a round trip, refuse what it cannot
// honestly open, and never let a zip entry write outside the takes folder.
#include "PackageStore.h"

#include <cstdio>
#include <string>

using namespace wizard::package;

static int failures = 0;
static void check(bool cond, const std::string& what) {
    if (!cond) {
        std::printf("FAIL: %s\n", what.c_str());
        ++failures;
    }
}

int main() {
    const auto root = juce::File::getSpecialLocation(juce::File::tempDirectory)
                          .getChildFile("wz_package_test");
    root.deleteRecursively();
    root.createDirectory();

    const auto session = juce::String("{\n  \"schemaVersion\": 13,\n  \"marker\": \"pkg\"\n}\n");

    // Two takes with the SAME filename, from different folders — the collision
    // case that silently loses data if the naming is naive.
    const auto a = root.getChildFile("srcA");
    const auto b = root.getChildFile("srcB");
    a.createDirectory();
    b.createDirectory();
    const auto takeA = a.getChildFile("take.wav");
    const auto takeB = b.getChildFile("take.wav");
    takeA.replaceWithText("AAAA");
    takeB.replaceWithText("BBBB");

    juce::StringArray used;
    const auto nameA = entryNameFor(takeA, used);
    const auto nameB = entryNameFor(takeB, used);
    check(nameA == "take.wav", "the first take keeps its own name");
    check(nameB != nameA, "a colliding take is renamed, never dropped");
    check(nameB.endsWith(".wav"), "and keeps its extension so it stays loadable");

    // --- round trip -----------------------------------------------------------
    const auto pkg = root.getChildFile("demo.wizard");
    juce::Array<Entry> takes;
    takes.add({takeA, nameA});
    takes.add({takeB, nameB});
    {
        const auto s = save(pkg, session, takes);
        check(s.ok, "save succeeds");
        check(s.missing.isEmpty(), "nothing reported missing when every take exists");
        check(pkg.existsAsFile(), "the package lands at the destination");
        check(!pkg.getSiblingFile(pkg.getFileName() + ".staging").exists(),
              "the staging folder never survives a save");
    }

    const auto extracted = root.getChildFile("extracted");
    {
        const auto l = load(pkg, extracted);
        check(l.ok, "load succeeds");
        check(l.sessionText == session, "session.json survives byte-for-byte");
        check(l.takes.size() == 2, "both takes come back");
        // Content, not just names: the whole point is the audio travels.
        const auto one = extracted.getChildFile(nameA).loadFileAsString();
        const auto two = extracted.getChildFile(nameB).loadFileAsString();
        check(one == "AAAA" && two == "BBBB",
              "each take's CONTENT is intact and not swapped by the rename");
    }

    // --- a missing take degrades, it does not deny the user a package ---------
    {
        const auto gone = root.getChildFile("deleted.wav");
        juce::Array<Entry> withGhost;
        withGhost.add({takeA, nameA});
        withGhost.add({gone, "deleted.wav"});
        const auto pkg2 = root.getChildFile("partial.wizard");
        const auto s = save(pkg2, session, withGhost);
        check(s.ok, "a package still saves when one take has vanished");
        check(s.missing.size() == 1, "and says exactly which take it could not include");
        const auto l = load(pkg2, root.getChildFile("extracted2"));
        check(l.ok && l.takes.size() == 1, "the surviving take is still there");
    }

    // --- refusals -------------------------------------------------------------
    {
        const auto notAPackage = root.getChildFile("random.wizard");
        notAPackage.replaceWithText("this is not a zip at all");
        const auto l = load(notAPackage, root.getChildFile("nope"));
        check(!l.ok && l.error.isNotEmpty(), "a non-package is refused with a reason");
    }
    {
        const auto missing = root.getChildFile("does-not-exist.wizard");
        check(!load(missing, root.getChildFile("nope2")).ok, "a missing package is refused");
    }
    {
        // A zip with takes but NO session.json is not a Wizard package.
        const auto headless = root.getChildFile("headless.wizard");
        juce::ZipFile::Builder builder;
        builder.addFile(takeA, 0, "Takes/take.wav");
        juce::FileOutputStream out(headless);
        double p = 0.0;
        builder.writeToStream(out, &p);
        out.flush();
        const auto dir = root.getChildFile("nope3");
        const auto l = load(headless, dir);
        check(!l.ok, "a zip without session.json is refused");
        check(!dir.exists(), "and NOTHING is extracted — no littering for a package we reject");
    }
    {
        // Zip-slip: an entry that tries to escape the takes folder.
        const auto evil = root.getChildFile("evil.wizard");
        const auto sessionFile = root.getChildFile("session.json");
        sessionFile.replaceWithText(session);
        juce::ZipFile::Builder builder;
        builder.addFile(sessionFile, 0, "session.json");
        builder.addFile(takeA, 0, "Takes/../../escaped.wav");
        juce::FileOutputStream out(evil);
        double p = 0.0;
        builder.writeToStream(out, &p);
        out.flush();
        const auto dir = root.getChildFile("safe");
        const auto l = load(evil, dir);
        check(!l.ok, "an entry escaping Takes/ is REFUSED, not sanitised");
        check(!root.getChildFile("escaped.wav").exists() &&
                  !root.getParentDirectory().getChildFile("escaped.wav").exists(),
              "and nothing is written outside the takes folder");
    }

    root.deleteRecursively();
    if (failures == 0) std::printf("package_store_test OK\n");
    return failures == 0 ? 0 : 1;
}
