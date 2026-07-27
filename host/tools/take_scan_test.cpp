// Finding takes on disk, including the ones a crash left half-written.
//
// The end-to-end shape this completes: the host ENUMERATES (here), the document
// layer PARSES (scoopy's persist/takeLibrary.ts, strict zod) — so the sidecar
// format has exactly one definition rather than a C++ copy drifting from a TS
// copy.
#include "TakeScan.h"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
void write(const std::string& path, const std::string& text) {
    std::ofstream f(path, std::ios::binary);
    f << text;
}
} // namespace

int main() {
    const std::string dir = "/tmp/wizard_take_scan_test";
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);

    // A missing directory is the normal state of a fresh install, not a fault.
    CHECK(wizard::record::scanTakes(dir).empty());
    CHECK(wizard::record::scanTakes("/tmp/definitely_not_here_12345").empty());

    std::filesystem::create_directories(dir, ec);
    CHECK(!ec);

    // Two complete takes, written out of chronological order on purpose.
    write(dir + "/deck1_2000.wav", "RIFFfake");
    write(dir + "/deck1_2000.wav.json", "{\n  \"deckId\": 0,\n  \"frames\": 10\n}\n");
    write(dir + "/deck1_1000.wav", "RIFFfake");
    write(dir + "/deck1_1000.wav.json", "{\n  \"deckId\": 0,\n  \"frames\": 20\n}\n");
    // A take whose sidecar never got written — the crash case.
    write(dir + "/deck2_3000.wav", "RIFFfake");
    // A sidecar whose audio is gone: metadata for nothing, must NOT appear.
    write(dir + "/deck3_4000.wav.json", "{\n  \"deckId\": 2\n}\n");
    // An empty sidecar: present but useless, must read as unreadable rather
    // than as a schema failure downstream.
    write(dir + "/deck4_5000.wav", "RIFFfake");
    write(dir + "/deck4_5000.wav.json", "");
    // Something that is not a take at all.
    write(dir + "/notes.txt", "hello");

    const auto takes = wizard::record::scanTakes(dir);
    CHECK(takes.size() == 4); // three complete-ish + the sidecar-less one

    // --- CHRONOLOGICAL, because the naming makes lexicographic order the same
    CHECK(takes[0].wavPath.find("deck1_1000") != std::string::npos);
    CHECK(takes[1].wavPath.find("deck1_2000") != std::string::npos);
    CHECK(takes[2].wavPath.find("deck2_3000") != std::string::npos);
    CHECK(takes[3].wavPath.find("deck4_5000") != std::string::npos);

    // --- the sidecar text is returned RAW, for the document layer to parse
    CHECK(takes[0].sidecarReadable);
    CHECK(takes[0].sidecarPath == takes[0].wavPath + ".json");
    CHECK(takes[0].sidecarJson.find("\"frames\": 20") != std::string::npos);
    CHECK(takes[1].sidecarJson.find("\"frames\": 10") != std::string::npos);

    // --- A TAKE WITH NO SIDECAR IS STILL A TAKE ------------------------------
    // A crash between closing the wav and writing the json is exactly the take
    // a user most wants back. Dropping it here would hide it forever.
    CHECK(!takes[2].sidecarReadable);
    CHECK(takes[2].sidecarJson.empty());

    // --- an EMPTY sidecar reads as unreadable, not as bad metadata ----------
    CHECK(!takes[3].sidecarReadable);

    // --- a sidecar with no audio is not a take -----------------------------
    for (const auto& t : takes) CHECK(t.wavPath.find("deck3_4000") == std::string::npos);

    // --- stable across calls (a UI re-scans constantly) ---------------------
    const auto again = wizard::record::scanTakes(dir);
    CHECK(again.size() == takes.size());
    for (size_t i = 0; i < takes.size(); ++i) CHECK(again[i].wavPath == takes[i].wavPath);

    std::filesystem::remove_all(dir, ec);
    std::printf("take_scan_test OK\n");
    return 0;
}
