// Finding the takes on disk — the other half of the take library.
//
// `RecordService::takes()` only knows what THIS process recorded. Reopening a
// session tomorrow has to find the takes from yesterday, which is what makes
// STRIP-MODEL's "the full take stays in the take library, reloadable into a
// tape later" true across a restart rather than only within one run.
//
// THIS DELIBERATELY DOES NOT PARSE THE SIDECAR. It returns the raw JSON text
// and lets the document layer parse it, because that layer already owns the
// schema (scoopy's `persist/takeLibrary.ts`, strict zod). Writing a second
// parser in C++ would mean two definitions of the same format drifting apart —
// and the sidecar is already a hand-mirrored boundary, so adding a third copy
// is the last thing it needs. Enumeration is the host's job; interpretation is
// the document's.
#pragma once

#include <string>
#include <vector>

namespace wizard::record {

struct TakeFile {
    std::string wavPath;     // the audio
    std::string sidecarPath; // wavPath + ".json"
    std::string sidecarJson; // raw text; empty when unreadable
    /** False when the .wav has no readable sidecar. Such a take is STILL
        returned: audio without metadata is still audio, and a take whose
        sidecar was lost — a crash between closing the wav and writing the
        json — is exactly the one a user most wants to recover. Dropping it
        here would hide it forever. */
    bool sidecarReadable = false;
};

/** Every take in `dir`, in a DETERMINISTIC order.
    Sorted by filename, which is chronological by construction: the naming is
    `deck<N>_<epochMs>.wav`, so lexicographic order IS recording order (pinned
    by recorder_drain_test). A missing or unreadable directory yields an empty
    list rather than an error — no takes yet is the normal state of a new
    install, not a fault. */
std::vector<TakeFile> scanTakes(const std::string& dir);

} // namespace wizard::record
