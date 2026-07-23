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

std::optional<Payload> load(const juce::File& root, const juce::String& path) {
    auto relative = path.upToFirstOccurrenceOf("?", false, false)
                        .upToFirstOccurrenceOf("#", false, false)
                        .trimCharactersAtStart("/");
    if (relative.isEmpty()) relative = "index.html";

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

} // namespace wizard::webresources
