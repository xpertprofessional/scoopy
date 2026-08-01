// THE UI IS IN THE BINARY — and its path handling is the containment check.
//
// Two claims, both of which fail SILENTLY in a DAW if they break:
//
//   §1 the archive is populated and serves the real entry point. An empty or
//      mis-globbed zip gives a blank editor with no error anywhere; the CMake
//      glob that fills it re-runs on content-hash changes, which is exactly
//      the kind of thing that rots without a gate watching.
//   §2 traversal is refused. `normaliseRequestPath` is now shared by the
//      directory server and this archive server, so the rule is tested once —
//      but the ARCHIVE path has no filesystem to backstop it (`load()` still
//      has isAChildOf), which makes the string check load-bearing here.
#include "EmbeddedWeb.h"

#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

int main() {
    // No ScopedJuceInitialiser here, and that is the point: this test links
    // juce_core only. An archive lookup that needed a message loop would be an
    // archive lookup that could not run on the audio-free gate path.
    const auto& web = wizard::plugin::EmbeddedWeb::shared();

    // ── §1 POPULATED, AND IT IS THE REAL BUNDLE ─────────────────────────────
    CHECK(web.isValid());

    // "" and "/" are both the SPA entry point, same as the directory server.
    for (const char* entry : {"", "/", "/index.html", "index.html"}) {
        const auto page = web.load(entry);
        CHECK(page.has_value());
        CHECK(page->mimeType == "text/html");
        const juce::String html(static_cast<const char*>(page->data.getData()),
                                page->data.getSize());
        // Not merely non-empty: it must be scoopy's shell, and it must pull a
        // script — an index.html that referenced assets we failed to embed
        // would still "load" and still show nothing.
        CHECK(html.contains("<script"));
    }

    // A query string and a fragment must not defeat the lookup — the WebView
    // appends them and the directory server already strips them.
    CHECK(web.load("/index.html?v=2").has_value());
    CHECK(web.load("/index.html#top").has_value());

    // ── The ASSETS index.html names must actually be in the archive ─────────
    //
    // Vite content-hashes these, so they cannot be hardcoded here; parse them
    // out of the served HTML instead. That also makes this a real end-to-end
    // check of the glob: a sourcemap-only exclusion bug or a missed extension
    // shows up as a script the page references and the archive lacks.
    {
        const auto page = web.load("/index.html");
        CHECK(page.has_value());
        const juce::String html(static_cast<const char*>(page->data.getData()),
                                page->data.getSize());
        int found = 0;
        for (const auto* attr : {"src=\"", "href=\""}) {
            int pos = 0;
            for (;;) {
                const int at = html.indexOf(pos, attr);
                if (at < 0) break;
                const int start = at + (int) juce::String(attr).length();
                const int end = html.indexOfChar(start, '"');
                if (end < 0) break;
                pos = end;
                const auto ref = html.substring(start, end);
                // Only same-origin bundle assets; skip data: URIs and CDNs.
                if (!ref.startsWith("/") && !ref.startsWith("./")) continue;
                if (ref.endsWith(".js") || ref.endsWith(".css")) {
                    if (!web.load(ref).has_value())
                        std::fprintf(stderr, "  missing from archive: %s\n", ref.toRawUTF8());
                    CHECK(web.load(ref).has_value());
                    ++found;
                }
            }
        }
        CHECK(found > 0); // a page referencing no bundle asset is not our UI
    }

    // ── §2 CONTAINMENT ──────────────────────────────────────────────────────
    CHECK(!web.load("/../../etc/passwd").has_value());
    CHECK(!web.load("../CMakeLists.txt").has_value());
    CHECK(!web.load("/assets/../../secrets").has_value());
    CHECK(!web.load("..\\..\\windows\\system32").has_value()); // backslashes too

    // Absent entries are nullopt, not an empty payload that renders as a blank
    // page — the caller must be able to tell "no such file" from "empty file".
    CHECK(!web.load("/nope.js").has_value());

    // Sourcemaps are deliberately NOT shipped (4.3 of the bundle's 6.8 MB).
    CHECK(!web.load("/assets/index.js.map").has_value());

    std::printf("embedded_web_test OK\n");
    return 0;
}
