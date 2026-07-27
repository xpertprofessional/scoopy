#include "TakeScan.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <sstream>

namespace wizard::record {

std::vector<TakeFile> scanTakes(const std::string& dir) {
    std::vector<TakeFile> out;
    std::error_code ec;
    // A missing directory is not an error — it is what a fresh install looks
    // like. Using the non-throwing overload keeps that path quiet.
    if (!std::filesystem::is_directory(dir, ec) || ec) return out;

    // Enumerate the AUDIO, not the sidecars: the .wav is the take. A sidecar
    // without its wav is metadata for audio that no longer exists and would
    // resolve to nothing; a wav without its sidecar is a recoverable take.
    for (const auto& entry : std::filesystem::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec) || ec) continue;
        const auto& p = entry.path();
        if (p.extension() != ".wav") continue;

        TakeFile t;
        t.wavPath = p.string();
        t.sidecarPath = t.wavPath + ".json";
        std::ifstream f(t.sidecarPath, std::ios::binary);
        if (f) {
            std::ostringstream ss;
            ss << f.rdbuf();
            t.sidecarJson = ss.str();
            // An empty file is not a readable sidecar: it would parse to
            // nothing and look like a schema failure rather than a lost file.
            t.sidecarReadable = !t.sidecarJson.empty();
        }
        out.push_back(std::move(t));
    }

    // Deterministic, and chronological for free: `deck<N>_<epochMs>.wav` sorts
    // lexicographically into recording order.
    std::sort(out.begin(), out.end(),
              [](const TakeFile& a, const TakeFile& b) { return a.wavPath < b.wavPath; });
    return out;
}

} // namespace wizard::record
