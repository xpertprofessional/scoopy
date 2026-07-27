#include "RecordService.h"

#include "WavWriter.h"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <vector>

namespace wizard::record {

namespace {
// Drain cadence. Short enough that the engine's drain ring (256 k frames) never
// fills in practice, long enough that the thread is nearly always asleep.
constexpr auto kDrainInterval = std::chrono::milliseconds(20);
constexpr uint32_t kDrainChunkFrames = 8192;
} // namespace

struct Service::DeckSlot {
    wav::Writer writer;
    bool open = false;
    uint64_t startEngineSample = 0;
    uint32_t channels = 0;
    double sampleRate = 0.0;
    std::string path;
    std::string sourceDesc;
    uint64_t framesWritten = 0;
    uint64_t droppedFrames = 0;
    std::vector<float> scratch;
};

Service::Service() = default;
Service::~Service() { stop(); }

std::string Service::takeFileName(uint32_t deck, uint64_t epochMs) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "deck%u_%llu.wav", deck + 1u,
                  static_cast<unsigned long long>(epochMs));
    return buf;
}

bool Service::start(TakeDrainSource& source, const std::string& takesDir) {
    if (running_.load()) return false;
    std::error_code ec;
    std::filesystem::create_directories(takesDir, ec);
    if (ec) return false;
    source_ = &source;
    dir_ = takesDir;
    slots_.clear();
    // One writer per slot the engine actually has — wizard's 8 decks, the merged
    // engine's tapes. Asking beats assuming: the two counts need not agree.
    const uint32_t n = source.slotCount();
    for (uint32_t d = 0; d < n; ++d) slots_.push_back(std::make_unique<DeckSlot>());
    running_.store(true);
    thread_ = std::thread([this] { threadMain(); });
    return true;
}

void Service::stop() {
    if (!running_.exchange(false)) return;
    if (thread_.joinable()) thread_.join();
    // Finalize anything still open (a stop during recording keeps the take).
    std::lock_guard<std::mutex> lock(mutex_);
    for (uint32_t d = 0; d < slots_.size(); ++d)
        if (slots_[d]->open) {
            slots_[d]->writer.close();
            slots_[d]->open = false;
        }
}

void Service::threadMain() {
    while (running_.load()) {
        // Keep record-buffer chunks allocated ahead of the render's write
        // position — allocation belongs on THIS thread, never the audio one.
        source_->serviceAllocation();
        for (uint32_t d = 0; d < slots_.size(); ++d) drainDeck(d, false);
        std::this_thread::sleep_for(kDrainInterval);
    }
}

void Service::drainDeck(uint32_t deck, bool finalDrain) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto& slot = *slots_[deck];
    if (!slot.open) return;
    if (slot.scratch.size() < static_cast<size_t>(kDrainChunkFrames) * slot.channels)
        slot.scratch.assign(static_cast<size_t>(kDrainChunkFrames) * slot.channels, 0.0f);

    // Pull until the ring is empty (a final drain loops until it truly is).
    for (;;) {
        uint64_t stamp = 0;
        const uint32_t got = source_->drain(deck, slot.scratch.data(),
                                            kDrainChunkFrames, &stamp);
        if (got == 0) break;
        if (!slot.writer.write(slot.scratch.data(), got)) {
            // An IO failure must not stall the engine: count and keep draining.
            slot.droppedFrames += got;
        } else {
            slot.framesWritten += got;
        }
        if (!finalDrain) break; // one chunk per tick in steady state
    }
}

bool Service::beginTake(uint32_t deck, uint32_t channels, double sampleRate,
                        uint64_t startEngineSample, const std::string& sourceDesc) {
    if (deck >= slots_.size() || channels == 0 || sampleRate <= 0.0) return false;
    const auto epochMs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
    std::lock_guard<std::mutex> lock(mutex_);
    auto& slot = *slots_[deck];
    if (slot.open) slot.writer.close(); // a re-arm without stop finalizes the old take
    slot.path = dir_ + "/" + takeFileName(deck, epochMs);
    slot.channels = channels;
    slot.sampleRate = sampleRate;
    slot.startEngineSample = startEngineSample;
    slot.sourceDesc = sourceDesc;
    slot.framesWritten = 0;
    slot.droppedFrames = 0;
    wav::Format fmt;
    fmt.channels = channels;
    fmt.sampleRate = sampleRate;
    fmt.bitsPerSample = 32;
    fmt.floatFormat = true;
    slot.open = slot.writer.open(slot.path, fmt, startEngineSample);
    return slot.open;
}

bool Service::endTake(uint32_t deck, uint64_t startEngineSample) {
    if (deck >= slots_.size()) return false;
    drainDeck(deck, true); // pull the tail the render wrote before it stopped
    std::lock_guard<std::mutex> lock(mutex_);
    auto& slot = *slots_[deck];
    if (!slot.open) return false;
    // Correct the Law C-2 stamp BEFORE closing. open() had to write a
    // provisional 0 because the engine only learns the true start at its first
    // render block after arming; leaving it meant every take stamped zero, so
    // every align delta was zero and DAW import landed everything at 0:00.
    // Applied unconditionally: 0 is a legitimate stamp (a take armed at engine
    // sample 0), not a sentinel, and treating it as one is how this went unseen.
    slot.startEngineSample = startEngineSample;
    slot.writer.setStartEngineSample(startEngineSample);
    slot.writer.close();
    slot.open = false;

    // Wall clock as ISO-8601 UTC (hand-formatted — no locale dependency).
    const auto now = std::chrono::system_clock::now();
    const std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tmv{};
#if defined(_WIN32)
    gmtime_s(&tmv, &t);
#else
    gmtime_r(&t, &tmv);
#endif
    char iso[32];
    std::snprintf(iso, sizeof(iso), "%04d-%02d-%02dT%02d:%02d:%02dZ", tmv.tm_year + 1900,
                  tmv.tm_mon + 1, tmv.tm_mday, tmv.tm_hour, tmv.tm_min, tmv.tm_sec);

    wav::writeSidecar(slot.path, deck, slot.startEngineSample, iso, slot.sourceDesc,
                      slot.sampleRate, slot.channels, slot.framesWritten);

    TakeInfo info;
    info.deckId = deck;
    info.path = slot.path;
    info.startEngineSample = slot.startEngineSample;
    info.frames = slot.framesWritten;
    info.sampleRate = slot.sampleRate;
    info.channels = slot.channels;
    info.sourceDesc = slot.sourceDesc;
    takes_.push_back(std::move(info));
    return true;
}

bool Service::forgetTake(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    // Refuse while a deck is still writing this file — a take being recorded is
    // not a take you can discard.
    for (const auto& slot : slots_)
        if (slot->open && slot->path == path) return false;
    for (size_t i = 0; i < takes_.size(); ++i)
        if (takes_[i].path == path) {
            takes_.erase(takes_.begin() + static_cast<long>(i));
            return true;
        }
    return false;
}

std::vector<TakeInfo> Service::takes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return takes_;
}

uint64_t Service::droppedFrames(uint32_t deck) const {
    std::lock_guard<std::mutex> lock(mutex_);
    return deck < slots_.size() ? slots_[deck]->droppedFrames : 0;
}

} // namespace wizard::record
