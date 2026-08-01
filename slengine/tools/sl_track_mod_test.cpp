// SL ABI — host modulation offsets (D-SL-DECKPLUGIN-04).
//
// The door a DAW automation lane writes through, and the reason it exists: the
// donor's M1–M4 modulation bank never came across, and rather than port it the
// deck plugin lets the HOST be the modulator. That only works if an offset is
// genuinely additive on top of the session (nobody wins a fight over one
// number), genuinely audible (a lane that moves nothing is the whole feature
// failing silently), and genuinely free when idle — the last is not a
// performance nicety but the promise the DSP characterization gates rest on.
//
// What this pins, in order: the name/id space round-trips; every refusal is a
// refusal and not a misapplied write; an untouched engine renders BIT-IDENTICAL
// audio; and each target actually moves the sound in the direction it claims.
//
// Deck-scope transpose/texture are set/get only here. They land on the bus
// STRETCHER, which is on its dry path until it is warm (see
// sl_deck_stretch_ready) and inaudible in tempoOnly by definition — an audible
// assertion would be pinning the stretcher's warm-up, not this door. That check
// belongs in the host, on a real timeline.
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

constexpr double kPi = 3.14159265358979323846;
constexpr uint32_t kBlock = 512;
constexpr double kSampleRate = 48000.0;
constexpr double kToneHz = 220.0;

/** Energy at one frequency — how this test tells 220 Hz from 440 Hz without
    caring where in the buffer the burst fell. Counting zero crossings would NOT
    work here: playing the same sample twice as fast holds the cycle count and
    only shortens the burst, so the crossings per trigger come out identical. */
double goertzel(const std::vector<float>& x, double freq) {
    const double coeff = 2.0 * std::cos(2.0 * kPi * freq / kSampleRate);
    double s1 = 0.0, s2 = 0.0;
    for (const float v : x) {
        const double s0 = static_cast<double>(v) + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return std::sqrt(std::fabs(s1 * s1 + s2 * s2 - coeff * s1 * s2));
}

double rms(const std::vector<float>& x) {
    if (x.empty()) return 0.0;
    double acc = 0.0;
    for (const float v : x) acc += static_cast<double>(v) * v;
    return std::sqrt(acc / static_cast<double>(x.size()));
}

/** One deck-0 session: a 220 Hz tone triggered on all eight steps, at full
    volume, centred, with every send down — so each target below starts from a
    base the offset has somewhere to move it FROM. */
bool buildSession(sl_engine* e) {
    const int32_t volumeId = sl_track_param_id("SL_T_VOLUME");
    const int32_t panId    = sl_track_param_id("SL_T_PAN");
    if (volumeId == SL_PARAM_UNKNOWN || panId == SL_PARAM_UNKNOWN) return false;
    const uint8_t steps[8] = {1, 1, 1, 1, 1, 1, 1, 1};
    if (sl_snapshot_begin(e, 0, 120.0, /*is_playing*/ 1, 0) != 1) return false;
    if (sl_snapshot_track_begin(e, "tone", steps, 8) != 1) return false;
    sl_snapshot_track_set(e, volumeId, 1.0);
    sl_snapshot_track_set(e, panId, 0.0);
    sl_snapshot_track_end(e);
    return sl_snapshot_commit(e) > 0;
}

sl_engine* makeEngine(std::vector<float>& tone) {
    sl_engine* e = sl_engine_create(kSampleRate, kBlock, 86);
    if (e == nullptr) return nullptr;
    if (sl_engine_register_sample(e, "tone", tone.data(), nullptr,
                                  static_cast<uint32_t>(tone.size()), kSampleRate) != 1)
        return nullptr;
    // Returns to EXTERNAL, exactly as ScoopyPluginProcessor does at engine
    // create: the core defaults them to host-plugin mode, where a send is
    // handed to a hosted effect and — in a host that can never load one —
    // vanishes into an empty slot (D-SL-DECKPLUGIN-02 · D1). Without this the
    // send lane below is silent for a reason that has nothing to do with the
    // offset under test.
    for (uint32_t r = 1; r <= 4; ++r) sl_return_set_external(e, r, 1);
    if (!buildSession(e)) return nullptr;
    if (sl_engine_start(e) != 1) return nullptr;
    return e;
}

/** Render `blocks` blocks, returning main L and (optionally) the send-1 lane.
    Bus order is the engine's lane order: 0/1 main, 2..5 sends 1..4. */
struct Rendered {
    std::vector<float> mainL, mainR, send1;
};

Rendered render(sl_engine* e, int blocks) {
    Rendered out;
    std::vector<float> l(kBlock), r(kBlock), s1(kBlock), s2(kBlock), s3(kBlock), s4(kBlock);
    float* buses[6] = {l.data(), r.data(), s1.data(), s2.data(), s3.data(), s4.data()};
    for (int b = 0; b < blocks; ++b) {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        std::fill(s1.begin(), s1.end(), 0.0f);
        std::fill(s2.begin(), s2.end(), 0.0f);
        std::fill(s3.begin(), s3.end(), 0.0f);
        std::fill(s4.begin(), s4.end(), 0.0f);
        sl_render(e, buses, 6, kBlock);
        out.mainL.insert(out.mainL.end(), l.begin(), l.end());
        out.mainR.insert(out.mainR.end(), r.begin(), r.end());
        out.send1.insert(out.send1.end(), s1.begin(), s1.end());
    }
    return out;
}

} // namespace

int main() {
    std::vector<float> tone(24000);
    for (size_t i = 0; i < tone.size(); ++i)
        tone[i] = 0.5f * static_cast<float>(
                             std::sin(2.0 * kPi * kToneHz * static_cast<double>(i) / kSampleRate));

    // ── The id space ────────────────────────────────────────────────────────
    const int32_t pitchId  = sl_track_mod_id_for_name("pitch");
    const int32_t volumeId = sl_track_mod_id_for_name("volume");
    const int32_t panId    = sl_track_mod_id_for_name("pan");
    const int32_t toneId   = sl_track_mod_id_for_name("tone");
    const int32_t send1Id  = sl_track_mod_id_for_name("send1");
    CHECK(pitchId != SL_PARAM_UNKNOWN);
    CHECK(volumeId != SL_PARAM_UNKNOWN);
    CHECK(panId != SL_PARAM_UNKNOWN);
    CHECK(toneId != SL_PARAM_UNKNOWN);
    CHECK(send1Id != SL_PARAM_UNKNOWN);
    // Unknown must be UNKNOWN, never 0 — id 0 is a real target, so returning it
    // would silently bend pitch when the caller asked for something else.
    CHECK(sl_track_mod_id_for_name("nope") == SL_PARAM_UNKNOWN);
    CHECK(sl_track_mod_id_for_name(nullptr) == SL_PARAM_UNKNOWN);
    CHECK(sl_deck_mod_id_for_name("nope") == SL_PARAM_UNKNOWN);
    CHECK(sl_deck_mod_id_for_name(nullptr) == SL_PARAM_UNKNOWN);
    CHECK(sl_deck_mod_id_for_name("transpose") == 0);
    CHECK(sl_deck_mod_id_for_name("texture") == 1);

    // Introspection agrees with resolution, so a plugin can BUILD its parameter
    // list from the engine rather than hardcoding a list that can drift.
    CHECK(sl_track_mod_count() == 8);
    for (uint32_t k = 0; k < sl_track_mod_count(); ++k) {
        const char* n = sl_track_mod_name(k);
        CHECK(n != nullptr);
        CHECK(sl_track_mod_id_for_name(n) == static_cast<int32_t>(k)); // round-trips
    }
    CHECK(sl_track_mod_name(sl_track_mod_count()) == nullptr);
    CHECK(sl_deck_mod_count() == 2);
    for (uint32_t k = 0; k < sl_deck_mod_count(); ++k) {
        const char* n = sl_deck_mod_name(k);
        CHECK(n != nullptr);
        CHECK(sl_deck_mod_id_for_name(n) == static_cast<int32_t>(k));
    }
    CHECK(sl_deck_mod_name(sl_deck_mod_count()) == nullptr);

    sl_engine* e = makeEngine(tone);
    CHECK(e != nullptr);

    // ── Refusals: ignored, never misapplied ─────────────────────────────────
    sl_track_mod_set(nullptr, 0, 0, pitchId, 12.0);              // null engine
    sl_track_mod_set(e, sl_deck_count(), 0, pitchId, 12.0);      // deck past the end
    sl_track_mod_set(e, 0, 9999, pitchId, 12.0);                 // track past the end
    sl_track_mod_set(e, 0, 0, SL_PARAM_UNKNOWN, 12.0);           // unknown id
    sl_track_mod_set(e, 0, 0, 9999, 12.0);                       // id past the end
    sl_track_mod_set(e, 0, 0, pitchId, std::nan(""));            // a lane that went NaN
    sl_track_mod_set(e, 0, 0, pitchId, INFINITY);
    CHECK(sl_track_mod_get(e, 0, 0, pitchId) == 0.0);            // nothing landed
    CHECK(sl_track_mod_get(nullptr, 0, 0, pitchId) == 0.0);
    CHECK(sl_track_mod_get(e, 0, 0, SL_PARAM_UNKNOWN) == 0.0);
    sl_deck_mod_set(nullptr, 0, 0, 5.0);
    sl_deck_mod_set(e, sl_deck_count(), 0, 5.0);
    sl_deck_mod_set(e, 0, 99, 5.0);
    sl_deck_mod_set(e, 0, 0, std::nan(""));
    CHECK(sl_deck_mod_get(e, 0, 0) == 0.0);
    CHECK(sl_deck_mod_get(nullptr, 0, 0) == 0.0);
    sl_master_set_mod(nullptr, 0.5);
    sl_master_set_mod(e, -1.0);                                  // negative gain
    sl_master_set_mod(e, std::nan(""));
    CHECK(sl_master_mod(e) == 1.0);                              // still neutral
    CHECK(sl_master_mod(nullptr) == 1.0);

    // ── Set/get round-trip, including the semitone↔lane-unit conversion ─────
    // The core's pitch lane is in UI half-semitones; this ABI speaks semitones.
    // A caller must get back exactly what it wrote or the conversion is a bug
    // that only shows up as "the automation lane reads half of what I drew".
    sl_track_mod_set(e, 0, 3, pitchId, 7.0);
    CHECK(std::fabs(sl_track_mod_get(e, 0, 3, pitchId) - 7.0) < 1e-6);
    sl_track_mod_set(e, 0, 3, pitchId, -12.5);
    CHECK(std::fabs(sl_track_mod_get(e, 0, 3, pitchId) + 12.5) < 1e-6);
    sl_track_mod_set(e, 0, 3, panId, 0.25);
    CHECK(std::fabs(sl_track_mod_get(e, 0, 3, panId) - 0.25) < 1e-6);
    // Offsets are per (deck, track, target) — writing one must not smear.
    CHECK(sl_track_mod_get(e, 0, 4, pitchId) == 0.0);
    CHECK(sl_track_mod_get(e, 1, 3, pitchId) == 0.0);
    CHECK(sl_track_mod_get(e, 0, 3, volumeId) == 0.0);
    sl_track_mod_set(e, 0, 3, pitchId, 0.0);
    sl_track_mod_set(e, 0, 3, panId, 0.0);
    sl_deck_mod_set(e, 0, 0, 3.5);
    CHECK(std::fabs(sl_deck_mod_get(e, 0, 0) - 3.5) < 1e-9);
    sl_deck_mod_set(e, 0, 1, 0.25);
    CHECK(std::fabs(sl_deck_mod_get(e, 0, 1) - 0.25) < 1e-9);
    CHECK(sl_deck_mod_get(e, 1, 0) == 0.0);                      // per deck, not global
    sl_deck_mod_set(e, 0, 0, 0.0);
    sl_deck_mod_set(e, 0, 1, 0.0);
    sl_engine_destroy(e);

    // ── Idle is FREE: an un-automated engine renders bit-identical audio ────
    // Not a performance claim — the DSP characterization gates assert exact
    // sample values, and they run through this same composition loop. If a
    // neutral offset perturbed even one ULP they would start failing for a
    // reason that had nothing to do with the DSP they exist to guard.
    {
        sl_engine* a = makeEngine(tone);
        sl_engine* b = makeEngine(tone);
        CHECK(a != nullptr && b != nullptr);
        // b is touched and returned to neutral — the count must fall back to
        // zero and re-arm the skip, not merely add zero on every lane forever.
        sl_track_mod_set(b, 0, 0, volumeId, 0.5);
        sl_track_mod_set(b, 0, 0, volumeId, 0.0);
        CHECK(sl_track_mod_get(b, 0, 0, volumeId) == 0.0);
        const Rendered ra = render(a, 40);
        const Rendered rb = render(b, 40);
        CHECK(ra.mainL.size() == rb.mainL.size());
        for (size_t i = 0; i < ra.mainL.size(); ++i) {
            CHECK(ra.mainL[i] == rb.mainL[i]);
            CHECK(ra.mainR[i] == rb.mainR[i]);
        }
        CHECK(rms(ra.mainL) > 1e-4); // and it was actually making sound
        sl_engine_destroy(a);
        sl_engine_destroy(b);
    }

    // ── The baseline every audible claim below is measured against ──────────
    double baseRmsL = 0.0, baseRms220 = 0.0, baseSend1 = 0.0;
    {
        sl_engine* base = makeEngine(tone);
        CHECK(base != nullptr);
        const Rendered r = render(base, 60);
        baseRmsL = rms(r.mainL);
        baseRms220 = goertzel(r.mainL, kToneHz);
        baseSend1 = rms(r.send1);
        CHECK(baseRmsL > 1e-3);
        CHECK(baseSend1 < 1e-6);  // sends start closed, so send1 has room to open
        sl_engine_destroy(base);
    }

    // VOLUME: base 1.0, offset −1 → composed 0 → the track goes away.
    {
        sl_engine* v = makeEngine(tone);
        CHECK(v != nullptr);
        sl_track_mod_set(v, 0, 0, volumeId, -1.0);
        const Rendered r = render(v, 60);
        CHECK(rms(r.mainL) < baseRmsL * 0.05);
        sl_engine_destroy(v);
    }

    // PAN: base centred, offset +1 → hard right. L must collapse and R must not.
    {
        sl_engine* p = makeEngine(tone);
        CHECK(p != nullptr);
        sl_track_mod_set(p, 0, 0, panId, 1.0);
        const Rendered r = render(p, 60);
        CHECK(rms(r.mainL) < rms(r.mainR) * 0.1);
        CHECK(rms(r.mainR) > 1e-3);
        sl_engine_destroy(p);
    }

    // SEND 1: base closed, offset +1 → the send lane carries audio. This is the
    // target with a real routing consequence in the plugin — send 1 is its own
    // output bus, so a DAW effect hangs off it.
    {
        sl_engine* s = makeEngine(tone);
        CHECK(s != nullptr);
        sl_track_mod_set(s, 0, 0, send1Id, 1.0);
        const Rendered r = render(s, 60);
        CHECK(rms(r.send1) > 1e-3);
        sl_engine_destroy(s);
    }

    // PITCH: +12 semitones → the 220 Hz tone becomes a 440 Hz tone. Measured as
    // energy at each frequency, because the two are the same NUMBER of cycles
    // (see goertzel above) and only a spectral test can tell them apart.
    {
        sl_engine* p = makeEngine(tone);
        CHECK(p != nullptr);
        sl_track_mod_set(p, 0, 0, pitchId, 12.0);
        CHECK(std::fabs(sl_track_mod_get(p, 0, 0, pitchId) - 12.0) < 1e-6);
        const Rendered r = render(p, 60);
        const double e220 = goertzel(r.mainL, kToneHz);
        const double e440 = goertzel(r.mainL, kToneHz * 2.0);
        CHECK(e440 > e220 * 4.0);            // the octave is where the energy went
        CHECK(e220 < baseRms220 * 0.5);      // and it left the fundamental
        sl_engine_destroy(p);
    }

    // A track index past the session's track count is accepted and inert — a
    // plugin's parameter list is fixed at load and cannot wait for a document,
    // so writing t15 of an 8-track session must be a no-op, not a corruption.
    {
        sl_engine* q = makeEngine(tone);
        sl_engine* ref = makeEngine(tone);
        CHECK(q != nullptr && ref != nullptr);
        sl_track_mod_set(q, 0, 15, volumeId, -1.0);
        sl_track_mod_set(q, 0, 40, pitchId, 24.0);
        CHECK(std::fabs(sl_track_mod_get(q, 0, 15, volumeId) + 1.0) < 1e-6); // stored…
        const Rendered rq = render(q, 40);
        const Rendered rr = render(ref, 40);
        for (size_t i = 0; i < rq.mainL.size(); ++i) CHECK(rq.mainL[i] == rr.mainL[i]); // …inert
        sl_engine_destroy(q);
        sl_engine_destroy(ref);
    }

    // MASTER: a 0.5 multiplier halves what leaves the building. Ramped over
    // 10 ms like every other gain, so this is measured after it has settled.
    {
        sl_engine* m = makeEngine(tone);
        CHECK(m != nullptr);
        sl_master_set_mod(m, 0.5);
        CHECK(sl_master_mod(m) == 0.5);
        render(m, 4);                        // let the ramp land
        const Rendered r = render(m, 60);
        const double halved = rms(r.mainL);
        sl_engine_destroy(m);

        sl_engine* full = makeEngine(tone);
        CHECK(full != nullptr);
        render(full, 4);
        const double unity = rms(render(full, 60).mainL);
        sl_engine_destroy(full);
        CHECK(halved < unity * 0.6 && halved > unity * 0.4);
    }

    // sl_deck_clear drops the deck's offsets: the next strip in this slot must
    // not arrive pre-bent by the automation the last one was under.
    {
        sl_engine* c = makeEngine(tone);
        CHECK(c != nullptr);
        sl_track_mod_set(c, 0, 0, pitchId, 12.0);
        sl_deck_mod_set(c, 0, 0, 5.0);
        sl_deck_mod_set(c, 0, 1, 0.5);
        sl_deck_clear(c, 0);
        CHECK(sl_track_mod_get(c, 0, 0, pitchId) == 0.0);
        CHECK(sl_deck_mod_get(c, 0, 0) == 0.0);
        CHECK(sl_deck_mod_get(c, 0, 1) == 0.0);
        // And the skip re-arms: a cleared deck renders like one never touched.
        CHECK(buildSession(c));
        sl_engine* fresh = makeEngine(tone);
        CHECK(fresh != nullptr);
        const Rendered rc = render(c, 40);
        const Rendered rf = render(fresh, 40);
        for (size_t i = 0; i < rc.mainL.size(); ++i) CHECK(rc.mainL[i] == rf.mainL[i]);
        sl_engine_destroy(c);
        sl_engine_destroy(fresh);
    }

    std::printf("sl_track_mod_test OK\n");
    return 0;
}
