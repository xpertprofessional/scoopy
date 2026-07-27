// The routing graph: ordered-by-default, delayed-only-on-request.
//
// The assertion this fixture exists for is the LATENCY one. A chain A→B→C must
// arrive with ZERO added delay, because the render visits channels in
// dependency order. The rejected design — every route one block late — is
// indistinguishable from this one on a single hop, and only diverges once you
// chain: it would put C two blocks behind A, and would put a strip routed
// straight to main a block AHEAD of a chained one, which is the silent comb
// filter pd-modular-routing §1.3 warns about. So the test drives an IMPULSE and
// checks WHICH SAMPLE it lands on.
#include "sl_engine.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr uint32_t kQ = 64;
constexpr double kRate = 48000.0;
constexpr uint64_t kLen = 64;
constexpr uint32_t kLanes = 6;

/** Index of the first non-zero sample in main L, or -1. */
int firstHit(const std::vector<float>& v) {
    for (uint32_t i = 0; i < v.size(); ++i)
        if (std::abs(v[i]) > 1e-6f) return static_cast<int>(i);
    return -1;
}
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // Summing copies reaches 2.0, whose mean square sits just above the +6 dBFS
    // threshold. Routing is what is under test here, not the guard.
    sl_watchdog_set_enabled(e, 0);

    // Null-safety.
    CHECK(sl_route_add(nullptr, 0, 1, 1.0, 0) == -1);
    CHECK(sl_route_remove(nullptr, 0) == 0);
    CHECK(sl_route_gain(nullptr, 0) == 0.0);
    CHECK(sl_route_active(nullptr, 0) == 0);
    CHECK(sl_route_would_cycle(nullptr, 0, 1) == 0);
    sl_route_render_order(nullptr, nullptr);

    // --- refusals -----------------------------------------------------------
    CHECK(sl_route_add(e, 0, 0, 1.0, 0) == -1);                    // self-loop
    CHECK(sl_route_add(e, 0, sl_channel_count(), 1.0, 0) == -1);   // out of range
    CHECK(sl_route_add(e, 0, 1, -1.0, 0) == -1);                   // negative gain
    CHECK(sl_route_add(e, 0, 1, std::nan(""), 0) == -1);

    // --- a chain A→B→C arrives with ZERO added latency ----------------------
    // Channel 0 carries a one-sample impulse at frame 0; 1 and 2 carry nothing
    // and exist only to pass it along.
    std::vector<float> imp(kLen, 0.0f);
    imp[0] = 1.0f;
    const float* planar[1] = {imp.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1 /* tape */, 0) == 1);
    // 1 and 2 stay unbound — a strip with no element still passes routed audio,
    // which is what makes a live-input strip need no special case.
    CHECK(sl_channel_set_source(e, 1, 0, 0) == 1);
    CHECK(sl_channel_set_source(e, 2, 0, 0) == 1);

    const int32_t ab = sl_route_add(e, 0, 1, 1.0, 0);
    const int32_t bc = sl_route_add(e, 1, 2, 1.0, 0);
    CHECK(ab >= 0 && bc >= 0);
    CHECK(sl_route_active(e, static_cast<uint32_t>(ab)) == 1);

    // The order must place 0 before 1 before 2 — that IS the zero-latency
    // mechanism, so it is worth asserting directly and not only by ear.
    std::vector<uint32_t> order(sl_channel_count(), 0);
    sl_route_render_order(e, order.data());
    const auto posOf = [&](uint32_t ch) {
        return static_cast<int>(std::find(order.begin(), order.end(), ch) - order.begin());
    };
    CHECK(posOf(0) < posOf(1));
    CHECK(posOf(1) < posOf(2));

    std::vector<std::vector<float>> lane(kLanes, std::vector<float>(kQ, 0.0f));
    std::vector<float*> lanes;
    for (auto& l : lane) lanes.push_back(l.data());
    auto render = [&] {
        for (auto& l : lane) std::fill(l.begin(), l.end(), 0.0f);
        sl_render(e, lanes.data(), kLanes, kQ);
    };

    // Route gains ramp IN over 10 ms, so let them settle before measuring
    // amplitude; the ARRIVAL SAMPLE is what this section is about.
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    render();
    // Channel 0 (direct), 1 (one hop) and 2 (two hops) all sum into main. If
    // routes were delayed per hop, main would show the impulse at frame 0 AND
    // again on the next two blocks. It must appear once, at frame 0.
    CHECK(firstHit(lane[0]) == 0);
    const float blockOneTail = std::abs(lane[0][kQ - 1]);
    CHECK(blockOneTail < 1e-6f); // nothing smeared to the end of the block

    // The next block must be silent apart from the loop's own repeat, which
    // lands at frame 0 again — never at frame 1 or 2, which is what an
    // accumulating per-hop delay would produce.
    render();
    CHECK(firstHit(lane[0]) == 0);

    // --- a cycle is REFUSED unless it is asked for ---------------------------
    CHECK(sl_route_would_cycle(e, 2, 0) == 1); // 0→1→2 already reaches back
    CHECK(sl_route_add(e, 2, 0, 1.0, 0) == -1);
    CHECK(sl_route_would_cycle(e, 0, 2) == 0); // the forward direction is fine
    // ...and consented to, it is accepted as a FEEDBACK edge.
    const int32_t fb = sl_route_add(e, 2, 0, 0.5, 1);
    CHECK(fb >= 0);
    // A feedback edge does not constrain the order — that is what lets it close
    // the loop at all.
    sl_route_render_order(e, order.data());
    CHECK(posOf(0) < posOf(1));
    CHECK(sl_route_remove(e, static_cast<uint32_t>(fb)) == 1);
    for (int b = 0; b < 40; ++b) render(); // let it ramp out and drop
    CHECK(sl_route_active(e, static_cast<uint32_t>(fb)) == 0);

    // --- a feedback edge is EXACTLY one block late --------------------------
    // Fresh engine so the measurement is not polluted by the loop above.
    sl_engine_destroy(e);
    e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // Summing copies reaches 2.0, whose mean square sits just above the +6 dBFS
    // threshold. Routing is what is under test here, not the guard.
    sl_watchdog_set_enabled(e, 0);
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1, 0) == 1);
    CHECK(sl_channel_set_source(e, 3, 0, 0) == 1);
    // 0 → 3 as a FEEDBACK edge (legal here, but forced delayed), gain 1.
    const int32_t d = sl_route_add(e, 0, 3, 1.0, 1);
    CHECK(d >= 0);
    // NOTE a channel's output is POST-level and POST-mute, so a route taps what
    // the strip actually contributes — muting the source silences its routed
    // copy too. That is the same tap point the record bus uses, and it is why
    // this measures the delay by counting ARRIVALS rather than by muting the
    // direct path away.
    for (int b = 0; b < 60; ++b) render(); // settle the route ramp

    sl_tape_seek(e, 0, 0);
    sl_tape_trigger(e, 0, 1); // one-shot: a single impulse, once

    // Block N — the DIRECT copy, from channel 0 itself.
    render();
    CHECK(firstHit(lane[0]) == 0);
    // Block N+1 — the DELAYED copy: channel 3 reading channel 0's PREVIOUS
    // block. Same impulse, exactly one block later. This is the whole contract
    // of a feedback edge, and the reason the delay had to be opt-in rather than
    // the default for every cable.
    render();
    CHECK(firstHit(lane[0]) == 0);
    // Block N+2 — nothing. One direct arrival, one delayed, and no tail: the
    // edge delays, it does not regenerate.
    render();
    CHECK(firstHit(lane[0]) == -1);

    // --- re-patching is click-free ------------------------------------------
    sl_engine_destroy(e);
    e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // Summing copies reaches 2.0, whose mean square sits just above the +6 dBFS
    // threshold. Routing is what is under test here, not the guard.
    sl_watchdog_set_enabled(e, 0);
    std::vector<float> dc(kLen, 1.0f);
    const float* dcp[1] = {dc.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, dcp, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1, 0) == 1);
    CHECK(sl_channel_set_source(e, 4, 0, 0) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    for (int b = 0; b < 60; ++b) render();
    // Steady state: channel 0's DC alone on main. Patching 0→4 adds a second
    // copy through channel 4, so main should climb 1.0 → 2.0 — and the whole
    // point is that it CLIMBS rather than jumps.
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(lane[0][i] - 1.0f) < 1e-3f);
    double prev = lane[0][kQ - 1];

    const int32_t live = sl_route_add(e, 0, 4, 1.0, 0);
    CHECK(live >= 0);
    double maxStep = 0.0;
    // Long enough for the one-pole to reach its snap threshold: at 64-frame
    // blocks, 40 blocks is only ~5 time constants and still 0.5% short.
    for (int b = 0; b < 200; ++b) { // patch IN
        render();
        for (uint32_t i = 0; i < kQ; ++i) {
            maxStep = std::max(maxStep, std::abs(static_cast<double>(lane[0][i]) - prev));
            prev = lane[0][i];
        }
    }
    CHECK(maxStep < 0.05); // a cable fades in; it does not switch on
    CHECK(std::abs(lane[0][0] - 2.0f) < 1e-3f);

    CHECK(sl_route_remove(e, static_cast<uint32_t>(live)) == 1);
    maxStep = 0.0;
    // Long enough for the one-pole to reach its snap threshold: at 64-frame
    // blocks, 40 blocks is only ~5 time constants and still 0.5% short.
    for (int b = 0; b < 200; ++b) { // patch OUT
        render();
        for (uint32_t i = 0; i < kQ; ++i) {
            maxStep = std::max(maxStep, std::abs(static_cast<double>(lane[0][i]) - prev));
            prev = lane[0][i];
        }
    }
    CHECK(maxStep < 0.05); // and fades out rather than cutting
    CHECK(std::abs(lane[0][0] - 1.0f) < 1e-3f); // back to the direct copy alone
    CHECK(sl_route_active(e, static_cast<uint32_t>(live)) == 0); // dropped once silent

    // --- THE DEFAULT WIRING is real, visible, removable routes --------------
    // A fresh engine is wired straight through, the way a mixer's channel 1 is
    // wired to jack 1. These are not hidden special cases in the mixer — they
    // are routes, so the matrix can show them and a document can re-point them.
    sl_engine_destroy(e);
    e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0);
    // 8 channel outputs → main, plus 8 × 4 sends → their FX buses.
    CHECK(sl_route_count_active(e) == sl_channel_count() * 5);
    sl_route_clear_all(e);
    CHECK(sl_route_count_active(e) == 0);
    sl_route_install_defaults(e);
    CHECK(sl_route_count_active(e) == sl_channel_count() * 5);

    // --- A SEND IS ROUTABLE (decision 5) ------------------------------------
    // The channel owns the send's LEVEL; where it GOES is a route. So send 3
    // can feed another strip's input instead of an effect — the case the user
    // asked for: "send 3 could be routed to the input of another deck and feed
    // the looper".
    CHECK(sl_tape_load(e, 0, 1, kLen, dcp, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1, 0) == 1);
    CHECK(sl_channel_set_source(e, 6, 0, 0) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    sl_channel_set_send(e, 0, 2, 0.5); // send 3 (0-based 2) at half
    // Patch that send tap into channel 6's INPUT rather than its FX bus.
    const int32_t sendRoute = sl_route_add_ex(e, 1 /* channelSend */, 0, 2,
                                              0 /* channelIn */, 6, 1.0, 0);
    CHECK(sendRoute >= 0);
    // A send tap is channel-sourced, so it constrains the order exactly like an
    // output tap does — 0 must render before 6 or the copy would be a block old.
    sl_route_render_order(e, order.data());
    CHECK(posOf(0) < posOf(6));
    for (int b = 0; b < 300; ++b) render();
    // main now carries: channel 0 direct (1.0) + channel 6 fed by the send
    // (1.0 × 0.5) = 1.5.
    CHECK(std::abs(lane[0][0] - 1.5f) < 1e-3f);
    // Riding the send level moves what channel 6 receives — the level stayed
    // with the channel even though the destination did not.
    sl_channel_set_send(e, 0, 2, 0.25);
    for (int b = 0; b < 300; ++b) render();
    CHECK(std::abs(lane[0][0] - 1.25f) < 1e-3f);

    // --- endpoint refusals ---------------------------------------------------
    CHECK(sl_route_add_ex(e, 9, 0, 0, 0, 1, 1.0, 0) == -1);            // bad src kind
    CHECK(sl_route_add_ex(e, 0, 0, 0, 9, 1, 1.0, 0) == -1);            // bad dst kind
    CHECK(sl_route_add_ex(e, 1, 0, 99, 0, 1, 1.0, 0) == -1);           // no such send
    CHECK(sl_route_add_ex(e, 3, 99, 0, 0, 1, 1.0, 0) == -1);           // no such return
    CHECK(sl_route_add_ex(e, 0, 0, 0, 1, 99, 1.0, 0) == -1);           // no such send bus
    // A send tap closing a cycle is refused exactly like an output tap.
    CHECK(sl_route_add_ex(e, 1 /* channelSend */, 6, 0, 0, 0, 1.0, 0) == -1);

    // --- A DEVICE INPUT IS JUST A ROUTE -------------------------------------
    // Which is why a live "input element" needs no special case in the strip:
    // patch an input into a channel and the strip hears it.
    sl_engine_destroy(e);
    e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0);
    CHECK(sl_channel_set_source(e, 0, 0, 0) == 1); // no element at all
    CHECK(sl_route_add_ex(e, 2 /* deviceInput */, 2, 3, 0 /* channelIn */, 0, 1.0, 0) >= 0);
    std::vector<float> zero(kQ, 0.0f), inA(kQ, 0.5f), inB(kQ, -0.25f);
    const float* ins[4] = {zero.data(), zero.data(), inA.data(), inB.data()};
    const auto renderIn = [&] {
        for (int b = 0; b < 300; ++b) {
            for (auto& l : lane) std::fill(l.begin(), l.end(), 0.0f);
            sl_render_io(e, ins, 4, lanes.data(), kLanes, kQ);
        }
    };

    // …BUT THE STRIP DOES NOT HEAR IT UNTIL THE MONITOR IS OPEN. The cable is
    // patched and REC would capture through it; the monitor decides whether it
    // is also audible. Closed is the default because a strip that arrives
    // listening is a strip that arrives feeding back — see Channel::monitor.
    CHECK(sl_channel_monitor(e, 0) == 0u);
    renderIn();
    CHECK(std::abs(lane[0][0]) < 1e-3f);
    CHECK(std::abs(lane[1][0]) < 1e-3f);

    sl_channel_set_monitor(e, 0, 1u);
    CHECK(sl_channel_monitor(e, 0) == 1u);
    renderIn();
    CHECK(std::abs(lane[0][0] - 0.5f) < 1e-3f);  // L from input 2
    CHECK(std::abs(lane[1][0] + 0.25f) < 1e-3f); // R from input 3

    // The gate is a GAIN, not a disconnection: it glides on the same 10 ms
    // constant as everything else, so flipping it under a live signal is a fade
    // rather than a click, and it lands exactly on 0 and 1 rather than near them.
    sl_channel_set_monitor(e, 0, 0u);
    renderIn();
    CHECK(std::abs(lane[0][0]) < 1e-3f);
    sl_channel_set_monitor(e, 0, 1u);

    // --- A RATE CHANGE MUST NOT EAT THE PATCH -------------------------------
    // SlRenderSink::setSampleRate does a stop → set → start rebuild on EVERY
    // device open (D-WZ-RATE-01), and that path reconfigures the channel bank.
    // An earlier cut reinstalled the boot defaults there, so plugging in a
    // different interface silently threw the user's whole patchbay away and
    // wired everything back to main. Sizing buffers and owning the document are
    // different jobs.
    {
        sl_engine* r = sl_engine_create(kRate, kQ, 86);
        CHECK(r != nullptr);
        const uint32_t bootRoutes = sl_route_count_active(r);
        CHECK(bootRoutes == sl_channel_count() * 5); // channel → main, send n → FX n
        // Build a patch: one extra cable, and one boot cable removed.
        const int32_t mine = sl_route_add(r, 0, 1, 0.5, 0);
        CHECK(mine >= 0);
        CHECK(sl_route_remove(r, 0) == 1);
        const uint32_t patched = sl_route_count_active(r);
        CHECK(patched == bootRoutes); // +1 added, −1 removed

        sl_engine_stop(r);                            // the sink's rebuild...
        CHECK(sl_engine_set_sample_rate(r, 44100.0) == 1);
        CHECK(sl_engine_start(r) == 1);

        CHECK(sl_engine_sample_rate(r) == 44100.0);   // the rate really changed
        CHECK(sl_route_count_active(r) == patched);   // ...and the patch survived it
        CHECK(sl_route_active(r, static_cast<uint32_t>(mine)) == 1); // my cable, specifically
        CHECK(sl_route_active(r, 0) == 0);            // and the one I removed stayed removed
        sl_engine_destroy(r);
    }

    // --- THE ORDER IS ALWAYS A PERMUTATION ----------------------------------
    // It is published as ONE packed atomic rather than eight separate ones,
    // because a render reading mid-rebuild would otherwise see half the old
    // order and half the new — and that mix is not a permutation: it can name
    // one channel twice (rendered twice, summed into main twice, its routes
    // poured twice) and omit another (stale output, routes never poured).
    // Re-patching while the audio thread runs is the NORMAL case here, so this
    // checks the invariant across many topologies.
    for (int trial = 0; trial < 64; ++trial) {
        const uint32_t a = static_cast<uint32_t>(trial) % sl_channel_count();
        const uint32_t b = (a + 1u + static_cast<uint32_t>(trial) / 8u) % sl_channel_count();
        if (a != b) (void)sl_route_add(e, a, b, 0.5, 0);
        sl_route_render_order(e, order.data());
        bool seen[8] = {};
        for (uint32_t i = 0; i < sl_channel_count(); ++i) {
            CHECK(order[i] < sl_channel_count()); // in range
            CHECK(!seen[order[i]]);               // and never twice
            seen[order[i]] = true;
        }
        for (uint32_t i = 0; i < sl_channel_count(); ++i) CHECK(seen[i]); // none omitted
        render();
    }

    // --- INTROSPECTION + ROUND-TRIP -----------------------------------------
    // The persistence contract, proven without a file: read the whole graph
    // back out, wipe it, rebuild it from what was read, and check the audio is
    // identical. If enumeration lost or mangled a field this fails, which is
    // the point — a save/load that quietly drops a cable is the failure mode
    // that only shows up on stage.
    sl_engine_destroy(e);
    e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0);
    CHECK(sl_route_capacity() >= sl_channel_count() * 5);
    CHECK(sl_route_source_kind(nullptr, 0) == 0);
    CHECK(sl_route_source_sub(nullptr, 0) == 0xFFFFFFFFu);

    CHECK(sl_tape_load(e, 0, 1, kLen, dcp, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1, 0) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    sl_channel_set_send(e, 0, 1, 0.5);
    // A patch worth saving: a chain, a send re-pointed at a strip, and a
    // consented feedback edge — one of each kind that behaves differently.
    CHECK(sl_route_add(e, 0, 1, 0.75, 0) >= 0);
    CHECK(sl_route_add_ex(e, 1 /* channelSend */, 0, 1, 0 /* channelIn */, 2, 1.0, 0) >= 0);
    CHECK(sl_route_add(e, 1, 0, 0.25, 1) >= 0); // feedback
    for (int b = 0; b < 400; ++b) render();
    const double before0 = lane[0][0];
    const double before1 = lane[1][0];
    CHECK(std::abs(before0) > 1e-6);

    struct Saved {
        uint32_t sk, si, ss, dk, di, fb;
        double gain;
    };
    std::vector<Saved> saved;
    bool sawDefault = false, sawFeedback = false, sawSendTap = false;
    for (uint32_t id = 0; id < sl_route_capacity(); ++id) {
        if (sl_route_active(e, id) == 0) continue;
        saved.push_back({sl_route_source_kind(e, id), sl_route_source_index(e, id),
                         sl_route_source_sub(e, id), sl_route_dest_kind(e, id),
                         sl_route_dest_index(e, id), sl_route_feedback(e, id),
                         sl_route_gain(e, id)});
        if (sl_route_is_default(e, id) != 0) sawDefault = true;
        if (sl_route_feedback(e, id) != 0) sawFeedback = true;
        if (sl_route_source_kind(e, id) == 1) sawSendTap = true;
    }
    CHECK(saved.size() == sl_route_count_active(e));
    CHECK(sawDefault && sawFeedback && sawSendTap); // all three kinds survived the read

    sl_route_clear_all(e);
    CHECK(sl_route_count_active(e) == 0);
    for (const auto& s : saved)
        CHECK(sl_route_add_ex(e, s.sk, s.si, s.ss, s.dk, s.di, s.gain, s.fb) >= 0);
    CHECK(sl_route_count_active(e) == saved.size());

    for (int b = 0; b < 400; ++b) render();
    // Same patch, same sound. (Route gains ramp from zero after a rebuild, so
    // this is compared once settled — a reload fades in rather than banging.)
    CHECK(std::abs(lane[0][0] - before0) < 1e-3);
    CHECK(std::abs(lane[1][0] - before1) < 1e-3);
    std::printf("  round-tripped %zu routes, main %.4f -> %.4f\n", saved.size(), before0,
                static_cast<double>(lane[0][0]));

    // --- routes are bounded, and exhaustion is reported, not ignored --------
    int added = 0;
    for (uint32_t i = 0; i < 200; ++i) {
        // 5→6 repeatedly: legal, parallel cables, until the table is full.
        if (sl_route_add(e, 5, 6, 0.1, 0) >= 0) ++added;
    }
    CHECK(added > 0);
    CHECK(sl_route_add(e, 5, 6, 0.1, 0) == -1); // full: refused, not silently dropped

    sl_engine_destroy(e);
    std::printf("sl_route_test OK\n");
    return 0;
}
