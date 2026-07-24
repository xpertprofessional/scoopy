// RecordService (P3-05): the bridge from the engine's lock-free per-deck drain
// rings to on-disk takes.
//
// One background thread pulls every recording deck's drain and feeds a
// wz_wav::Writer per deck. NOTHING here ever blocks the render thread: the
// engine writes into its ring and moves on; if this thread is late, the ring
// counts an overrun and the file loses those frames — the take is degraded, the
// mix is not. (docs/specs/recorder.md §4.)
//
// The service also drives wz_deck_record_service() so record-buffer chunks are
// allocated ahead of the render's write position on a NON-audio thread.
#pragma once

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct wz_engine;

namespace wizard::record {

struct TakeInfo {
    uint32_t deckId = 0;
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

    // `takesDir` is created if absent. Starts the drain thread.
    bool start(wz_engine* engine, const std::string& takesDir);
    void stop(); // finalizes any open take

    // Called (message thread) right after wz_deck_record_start: opens the take
    // file for `deck`. `sourceDesc` is the human label of what is being recorded.
    bool beginTake(uint32_t deck, uint32_t channels, double sampleRate,
                   uint64_t startEngineSample, const std::string& sourceDesc);
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
    wz_engine* engine_ = nullptr;
    std::string dir_;
    std::vector<std::unique_ptr<DeckSlot>> slots_;
    std::vector<TakeInfo> takes_;
    mutable std::mutex mutex_; // guards slots_ file handles + takes_
    std::thread thread_;
    std::atomic<bool> running_{false};
};

} // namespace wizard::record
