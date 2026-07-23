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

    // MIME table basics.
    CHECK(mimeForExtension("css") == "text/css");
    CHECK(mimeForExtension("wasm") == "application/wasm");
    CHECK(mimeForExtension("zzz") == "application/octet-stream");

    root.deleteRecursively();
    std::printf("web_resources_test OK\n");
    return 0;
}
