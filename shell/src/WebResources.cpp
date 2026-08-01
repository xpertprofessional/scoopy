#include "WebResources.h"

namespace wizard::webresources {

juce::String mimeForExtension(const juce::String& ext) {
    if (ext == "html") return "text/html";
    if (ext == "js" || ext == "mjs") return "text/javascript";
    if (ext == "css") return "text/css";
    if (ext == "json" || ext == "map") return "application/json";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "png") return "image/png";
    if (ext == "jpg" || ext == "jpeg") return "image/jpeg";
    if (ext == "woff2") return "font/woff2";
    if (ext == "wasm") return "application/wasm";
    return "application/octet-stream";
}

std::optional<juce::String> normaliseRequestPath(const juce::String& path) {
    const auto trimmed = path.upToFirstOccurrenceOf("?", false, false)
                             .upToFirstOccurrenceOf("#", false, false)
                             .trimCharactersAtStart("/");

    // Rebuild from segments rather than patching the string. `.` and empty
    // segments (`a//b`) are dropped; `..` is REFUSED rather than resolved.
    //
    // `load()` additionally proves containment against the real root
    // (getChildFile collapses ".."), but an archive has no filesystem to ask —
    // there the string check is the only guard, which is why it lives here and
    // not in either caller. Dropping `.` is not cosmetic either: index.html
    // references its assets as `./assets/x.js`, and while a browser resolves
    // that before asking us, anything else reading the page's hrefs directly
    // would otherwise miss every asset.
    juce::StringArray out;
    for (const auto& segment : juce::StringArray::fromTokens(trimmed, "/\\", {})) {
        if (segment == "..") return std::nullopt;
        if (segment.isEmpty() || segment == ".") continue;
        out.add(segment);
    }

    if (out.isEmpty()) return juce::String("index.html"); // "" and "/" → SPA entry
    return out.joinIntoString("/");
}

std::optional<Payload> load(const juce::File& root, const juce::String& path) {
    const auto normalised = normaliseRequestPath(path);
    if (!normalised.has_value()) return std::nullopt;
    const auto& relative = *normalised;

    const auto file = root.getChildFile(relative);

    // Containment check on the resolved path: getChildFile() collapses "..",
    // so a traversal attempt lands outside root and is rejected here rather
    // than silently serving an arbitrary file.
    if (!file.isAChildOf(root)) return std::nullopt;
    if (!file.existsAsFile()) return std::nullopt;

    Payload payload;
    if (!file.loadFileAsData(payload.data)) return std::nullopt;
    payload.mimeType = mimeForExtension(file.getFileExtension().substring(1).toLowerCase());
    return payload;
}

bool navigationAllowed(const juce::String& url, const juce::String& resourceRoot) {
    if (resourceRoot.isEmpty()) return false;
    if (url.startsWithIgnoreCase("about:blank")) return true;
    return url.startsWith(resourceRoot);
}

} // namespace wizard::webresources
