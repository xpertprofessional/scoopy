// The plugin's webdist, carried INSIDE the binary.
//
// The app can serve `webdist/` from the source tree because it only ever runs
// where that tree exists. A plugin is copied to ~/Library/Audio/Plug-Ins and
// opened on machines that have never seen this repo, so the same trick would
// render a blank editor with no error — the failure mode this project keeps
// paying for. The bundle therefore ships in the binary.
//
// WHY A ZIP AND NOT juce_add_binary_data OVER THE LOOSE FILES.
// Vite content-hashes every asset (`index-Br5AdKi1.js`), so the generated
// BinaryData symbol names CHANGE ON EVERY WEB REBUILD, and the C++ that named
// them would need regenerating in lockstep. Worse, BinaryData keeps only the
// basename, so `assets/x.js` and `x.js` would collide silently. One archive
// gives a stable symbol regardless of content hashes, preserves the real
// relative paths, and compresses the bundle on the way in.
#pragma once

#include "WebResources.h"

#include <juce_core/juce_core.h>

#include <memory>
#include <optional>

namespace wizard::plugin {

/** Serves the embedded webdist archive. One per process is plenty — the
    archive is immutable — but it is an object rather than a global so a test
    can build one over its own zip. */
class EmbeddedWeb {
public:
    EmbeddedWeb();

    /** Same contract as wizard::webresources::load, reading the archive
        instead of a directory: nullopt when the path escapes or names no
        entry. Shares normaliseRequestPath, so the containment rule has one
        implementation. */
    std::optional<wizard::webresources::Payload> load(const juce::String& path) const;

    /** False when the archive is missing or unreadable — the editor then says
        so loudly instead of showing a blank page. */
    bool isValid() const { return zip != nullptr && zip->getNumEntries() > 0; }

    /** The process-wide instance the editor's resource provider uses. */
    static EmbeddedWeb& shared();

private:
    std::unique_ptr<juce::InputStream> stream;
    std::unique_ptr<juce::ZipFile> zip;
};

} // namespace wizard::plugin
