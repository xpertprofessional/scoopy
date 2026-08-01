#include "PeerRegistry.h"

#include <cstring>

namespace wizard::plugin {

std::array<PeerRegistry::Slot, PeerRegistry::kSlots>& PeerRegistry::table() noexcept {
    // FUNCTION-LOCAL STATIC, deliberately: this must be one table per PROCESS
    // and initialised before any instance touches it, and a plugin has no
    // start-up hook to order namespace-scope construction against. C++11
    // guarantees the initialisation is thread-safe, which matters because two
    // instances can be constructed concurrently by a host scanning in parallel.
    static std::array<Slot, kSlots> slots;
    return slots;
}

int PeerRegistry::claim() noexcept {
    auto& slots = table();
    for (int i = 0; i < kSlots; ++i) {
        bool expected = false;
        // compare_exchange, not a load-then-store: two instances constructed on
        // different threads must not walk away believing they own the same row.
        if (slots[(size_t) i].taken.compare_exchange_strong(expected, true,
                                                            std::memory_order_acq_rel))
            return i;
    }
    return -1; // full — the deck just cannot be a reference
}

void PeerRegistry::release(int slot) noexcept {
    if (slot < 0 || slot >= kSlots) return;
    auto& s = table()[(size_t) slot];
    // Blank it BEFORE freeing the slot, or a peer enumerating between the two
    // would read a dead instance's row and offer it as a live reference.
    Row empty;
    publish(slot, empty);
    s.taken.store(false, std::memory_order_release);
}

void PeerRegistry::publish(int slot, const Row& row) noexcept {
    if (slot < 0 || slot >= kSlots) return;
    auto& s = table()[(size_t) slot];
    s.seq.fetch_add(1, std::memory_order_release);
    std::atomic_thread_fence(std::memory_order_release);
    s.row = row;
    std::atomic_thread_fence(std::memory_order_release);
    s.seq.fetch_add(1, std::memory_order_release);
}

int PeerRegistry::peers(Row* out, int max, int excludeSlot) noexcept {
    if (out == nullptr || max <= 0) return 0;
    auto& slots = table();
    int n = 0;
    for (int i = 0; i < kSlots && n < max; ++i) {
        if (i == excludeSlot) continue;
        auto& s = slots[(size_t) i];
        if (!s.taken.load(std::memory_order_acquire)) continue;
        Row copy;
        // Seqlock read: retry until the sequence is even and unchanged, so
        // `cycle` and `anchor` came from the same publish. Bounded — a writer
        // moves at human rate and spinning here would be worse than skipping a
        // peer for one poll.
        bool stable = false;
        for (int attempt = 0; attempt < 8 && !stable; ++attempt) {
            const auto before = s.seq.load(std::memory_order_acquire);
            if (before % 2 != 0) continue;
            std::atomic_thread_fence(std::memory_order_acquire);
            copy = s.row;
            std::atomic_thread_fence(std::memory_order_acquire);
            stable = s.seq.load(std::memory_order_acquire) == before;
        }
        if (!stable) continue;
        // A stopped peer, or one with no resolvable cycle, is not a reference:
        // waiting on a boundary that will never come round is the hang this
        // whole design refuses.
        if (!copy.playing || !(copy.cyclePpq > 0.0)) continue;
        out[n++] = copy;
    }
    return n;
}

} // namespace wizard::plugin
