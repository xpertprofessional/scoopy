// ScoopyDeck's host-automatable parameters (D-SL-DECKPLUGIN-04).
//
// THE MODULATION SYSTEM, SOURCED FROM THE DAW. The donor carried a 4-channel
// mod bank (M1–M4) routed onto per-track targets by an arm-to-map gesture; it
// never came across, and rather than port it this plugin exposes the TARGETS as
// host parameters and lets the DAW's LFOs and automation lanes be the sources.
// Draw a curve on "T01 Pitch" and the track bends — same destination, same
// additive math, a source the user already knows.
//
// Every parameter here is an OFFSET, neutral at 0 (the master's neutral is 0 dB).
// That is what lets the web UI and the host both hold a control at once: the UI
// owns the base value, automation owns the offset, and the engine adds them. An
// idle lane is not merely quiet, it is bit-identical to no lane at all.
//
// ⚠️ THE LAYOUT IS FROZEN ONCE RELEASED. A DAW addresses automation by index
// (AU) and by id (VST3), so reordering or renaming silently re-points a user's
// existing curves at the wrong control. Targets and tracks may only be APPENDED,
// which is why the ids carry a deck (`d0.t03.pitch`) even though only deck 0 is
// automatable today — decks 1–2 (D-SL-DECKPLUGIN-02 · D4) append cleanly.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <cstdint>
#include <vector>

struct sl_engine;

namespace wizard::plugin {

/** How many tracks carry automation lanes. The web tier's ceiling is 16
    (MAX_TRACKS) and a fresh session ships 8; a plugin's parameter list is built
    at load time and cannot wait to see how deep a document turns out to be, so
    it declares the ceiling and the upper lanes sit inert until a session that
    deep arrives. */
inline constexpr int kAutomatedTracks = 16;

/** The deck these lanes address. One deck today (D-SL-DECKPLUGIN-02 · D4 moves
    to N decks in one instance); the id space is already deck-qualified so that
    day is an append rather than a break. */
inline constexpr int kAutomationDeck = 0;

class HostParams {
public:
    /** Builds the layout and hands it to `proc`. Construct once, in the
        processor's constructor — a host may enumerate parameters immediately
        after and the list must never change shape afterwards. */
    explicit HostParams(juce::AudioProcessor& proc);

    /** Push every changed value into the engine.
     *
     *  ⚠️ CALLED FROM processBlock, and allowed to be: these land on
     *  sl_track_mod_set / sl_deck_mod_set / sl_master_set_mod, the one param
     *  family that is plain atomics rather than a world republish. Per block
     *  rather than on the 40 Hz pump is the point — a 6 Hz LFO quantised to
     *  40 Hz control ticks sounds like a stepped sequence, not like an LFO.
     *
     *  Unchanged values cost a compare and nothing else, so a session with no
     *  automation at all pays 131 float compares per block. */
    void pushToEngine(sl_engine* e) noexcept;

    /** The non-default values, for the state chunk. Sparse on purpose: a
        typical project automates a handful of lanes, and writing all 131 every
        save would bloat every chunk to carry mostly zeros. */
    juce::var writeState() const;

    /** Restore from `stored` (what writeState produced; anything else is
        ignored key by key). Notifies the host, so a DAW's own generic editor
        redraws, and leaves anything absent at its default — which is how a
        chunk written before this feature restores as fully neutral. */
    void readState(const juce::var& stored);

    /** Test seam: the parameter for an id, or nullptr. */
    juce::RangedAudioParameter* find(juce::StringRef paramId) const;

    int size() const { return (int) entries.size(); }

private:
    enum class Scope { track, deck, master };

    struct Entry {
        juce::RangedAudioParameter* param = nullptr;
        Scope scope = Scope::track;
        int track = 0;
        int32_t modId = 0;
        // Last value handed to the engine. Seeded to NaN so the FIRST block
        // pushes everything unconditionally — which is also what carries a
        // restored chunk into the engine, with no separate apply path to keep
        // in step with this one.
        float lastSent = std::numeric_limits<float>::quiet_NaN();
    };

    std::vector<Entry> entries;
};

} // namespace wizard::plugin
