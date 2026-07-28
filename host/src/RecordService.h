// RecordService (P3-05): the bridge from an engine's lock-free per-slot drain
// rings to on-disk takes.
//
// One background thread pulls every recording slot's drain and feeds a
// wz_wav::Writer per slot. NOTHING here ever blocks the render thread: the
// engine writes into its ring and moves on; if this thread is late, the ring
// counts an overrun and the file loses those frames — the take is degraded, the
// mix is not. (docs/specs/recorder.md §4.)
//
// The service also drives the source's serviceAllocation() so record-buffer
// chunks are allocated ahead of the render's write position on a NON-audio
// thread.
//
// ENGINE-AGNOSTIC (merge): the engine is behind TakeDrainSource, so this tier
// links neither engine and serves wizard's decks and the merged engine's tapes
// with one implementation. A take is a take — the crash-safe writer, the
// sidecar, the naming and the Law C-2 stamp handling do not depend on which
// engine captured the audio.
#pragma once

#include "TakeDrainSource.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace wizard::record {

struct TakeInfo {
    uint32_t deckId = 0;       // the source's slot index (wizard deck / merged tape)
    std::string path;          // the .wav (sidecar is path + ".json")
    uint64_t startEngineSample = 0;
    uint64_t frames = 0;
    double sampleRate = 0.0;
    uint32_t channels = 0;
    std::string sourceDesc;
};

class Service {
public:
    Service();  // out-of-line: DeckSlot is incomplete here (pimpl'd vector)
    ~Service();
    Service(const Service&) = delete;
    Service& operator=(const Service&) = delete;

    /** `takesDir` is created if absent. Starts the drain thread.
        `source` must outlive the service (it is held by reference, exactly as
        AudioIO holds a RenderSink). */
    bool start(TakeDrainSource& source, const std::string& takesDir);
    void stop(); // finalizes any open take

    // Called (message thread) right after wz_deck_record_start: opens the take
    // file for `deck`. `sourceDesc` is the human label of what is being recorded.
    // `bpmAtStart` (P3-2b-1): the master tempo when capture began, 0 = unknown —
    // written into the sidecar so a recorded loop can state its own bpm later.
    bool beginTake(uint32_t deck, uint32_t channels, double sampleRate,
                   uint64_t startEngineSample, const std::string& sourceDesc,
                   double bpmAtStart = 0.0);
    // Called right after wz_deck_record_stop: drains the tail, closes the file,
    // writes the sidecar, and appends to the take list.
    /** `startEngineSample` is the engine's true start for this take, known only
        once recording has actually begun (wz_deck_record_stop returns it). It is
        applied here to the file's bext TimeReference, the sidecar and the
        TakeInfo — all three carried 0 before, so align compared zeros. */
    bool endTake(uint32_t deck, uint64_t startEngineSample);

    std::vector<TakeInfo> takes() const;
    /** Forget a take (by path). Does NOT touch the filesystem — the shell moves
        the files to the Trash, so a mis-click is recoverable. Returns false if
        the path isn't in the list or its deck is still recording into it. */
    bool forgetTake(const std::string& path);
    /** Frames the file writer lost because the drain fell behind (per deck). */
    uint64_t droppedFrames(uint32_t deck) const;

    // PROVISIONAL naming (morning decision #2): Takes/deck<N>_<epoch-ms>.wav —
    // self-describing and time-sortable without needing a calendar formatter.
    static std::string takeFileName(uint32_t deck, uint64_t epochMs);

private:
    void threadMain();
    void drainDeck(uint32_t deck, bool finalDrain);

    struct DeckSlot;
    TakeDrainSource* source_ = nullptr;
    std::string dir_;
    std::vector<std::unique_ptr<DeckSlot>> slots_;
    std::vector<TakeInfo> takes_;
    mutable std::mutex mutex_; // guards slots_ file handles + takes_
    std::thread thread_;
    std::atomic<bool> running_{false};
};

} // namespace wizard::record
