// Verifies the WebView resource-provider mapping without needing a GUI,
// a display, or screen-capture permission.
#include "WebResources.h"

#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

int main() {
    using namespace wizard::webresources;

    const auto root = juce::File::getSpecialLocation(juce::File::tempDirectory)
                          .getChildFile("wizard_webres_test");
    root.deleteRecursively();
    CHECK(root.createDirectory().wasOk());

    CHECK(root.getChildFile("index.html").replaceWithText("<!doctype html><title>W</title>"));
    CHECK(root.getChildFile("assets").createDirectory().wasOk());
    CHECK(root.getChildFile("assets/app.js").replaceWithText("export const x = 1"));

    // Root and empty path both serve the SPA entry point.
    for (const auto* p : {"/", ""}) {
        const auto r = load(root, p);
        CHECK(r.has_value());
        CHECK(r->mimeType == "text/html");
        CHECK(r->data.getSize() > 0);
    }

    // Nested asset with correct MIME.
    const auto js = load(root, "/assets/app.js");
    CHECK(js.has_value());
    CHECK(js->mimeType == "text/javascript");

    // Query strings and fragments are stripped before file lookup.
    CHECK(load(root, "/assets/app.js?v=abc").has_value());
    CHECK(load(root, "/assets/app.js#top").has_value());

    // Missing files are a clean miss, not a crash.
    CHECK(!load(root, "/nope.js").has_value());

    // Path traversal must not escape the bundle root.
    const auto outside = root.getParentDirectory().getChildFile("wizard_outside_secret.txt");
    CHECK(outside.replaceWithText("secret"));
    CHECK(!load(root, "/../wizard_outside_secret.txt").has_value());
    CHECK(!load(root, "../wizard_outside_secret.txt").has_value());
    CHECK(!load(root, "/assets/../../wizard_outside_secret.txt").has_value());
    outside.deleteFile();

    // ── normaliseRequestPath, the half now SHARED with the plugin ────────────
    //
    // Extracted at D-SL-DECKPLUGIN-01 because the plugin serves an embedded
    // archive and has no filesystem to backstop the containment check — there
    // this string result IS the guard, so it is pinned directly rather than
    // only through load()'s isAChildOf.
    CHECK(normaliseRequestPath("") == juce::String("index.html"));
    CHECK(normaliseRequestPath("/") == juce::String("index.html"));
    CHECK(normaliseRequestPath("/index.html?v=1#x") == juce::String("index.html"));
    CHECK(normaliseRequestPath("/assets/app.js") == juce::String("assets/app.js"));
    // `.` segments dropped and doubled slashes collapsed: index.html writes its
    // own asset hrefs as `./assets/x.js`.
    CHECK(normaliseRequestPath("./assets/app.js") == juce::String("assets/app.js"));
    CHECK(normaliseRequestPath("/assets//app.js") == juce::String("assets/app.js"));
    // `..` is REFUSED, never resolved — including via backslashes.
    CHECK(!normaliseRequestPath("../secret").has_value());
    CHECK(!normaliseRequestPath("/assets/../../secret").has_value());
    CHECK(!normaliseRequestPath("..\\..\\secret").has_value());

    // MIME table basics.
    CHECK(mimeForExtension("css") == "text/css");
    CHECK(mimeForExtension("wasm") == "application/wasm");
    CHECK(mimeForExtension("zzz") == "application/octet-stream");

    // Navigation policy (P1 spike §Q3): a dropped file must not be able to
    // navigate the WebView away from the app, taking the UI state with it.
    {
        const juce::String appRoot{"juce://juce.backend/"};

        // The app itself, and the deep links within it, load.
        CHECK(navigationAllowed(appRoot, appRoot));
        CHECK(navigationAllowed(appRoot + "index.html", appRoot));
        CHECK(navigationAllowed(appRoot + "assets/index-abc.js", appRoot));
        // WebKit's own setup page is not a navigation away from the app.
        CHECK(navigationAllowed("about:blank", appRoot));

        // The drop case: a file:// URL is exactly what a dropped audio file
        // navigates to, and it is the whole reason this policy exists.
        CHECK(!navigationAllowed("file:///Users/someone/Music/HERMAN.wav", appRoot));
        CHECK(!navigationAllowed("https://example.com/", appRoot));
        CHECK(!navigationAllowed("http://localhost:3000/", appRoot));
        CHECK(!navigationAllowed("javascript:alert(1)", appRoot));
        CHECK(!navigationAllowed("", appRoot));

        // A near-miss host must not pass on a prefix that stops short of the
        // authority — the check is a prefix of the FULL root, separator included.
        CHECK(!navigationAllowed("juce://juce.backend.evil.com/", appRoot));

        // No root means nothing is the app yet, so nothing is allowed —
        // fail closed, never open.
        CHECK(!navigationAllowed(appRoot, ""));
        CHECK(!navigationAllowed("about:blank", ""));
    }

    root.deleteRecursively();
    std::printf("web_resources_test OK\n");
    return 0;
}
