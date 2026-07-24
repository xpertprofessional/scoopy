// Pure dispatch for scoopy's slCommand surface — (method, params) -> reply var.
//
// This is the merged shell's answer to the command surface scoopy's web UI
// speaks (schema.ts COMMANDS). It is the real thing the P1 spike stubbed: the
// spike faked getCapabilities and failed everything else; this implements the
// BOOT HANDSHAKE for real — capabilities, the settings quartet, and view-state
// reads — so scoopy's UI comes up "linked · schema v86" and can persist.
//
// GUI-free on purpose, exactly like wizard's own CommandDispatch: the whole
// surface is exercised headlessly (sl_dispatch_test) with no WebView and no
// display. Main.cpp's slCommand native function is a thin adapter over this.
//
// NOT here yet (each its own increment, ABI.md "declare only what is done"):
//   · the PatternFile→v3-snapshot play path (worldPublish / publishTrackPattern
//     / gridEdit) — needs the sl_engine and scoopy's document format
//   · host-tier commands that need the device/dialog layer (audio device
//     enumeration, file browser, background image) — answered by the shell,
//     not this pure core, when they land
// Anything this dispatcher does not implement is REFUSED honestly (ok:false),
// which scoopy's boot path tolerates by design (its command calls catch).
#pragma once

#include <juce_core/juce_core.h>

namespace wizard::sl {

/** Persistence behind getSetting/setSetting/getSettings. Injected so the
    dispatcher is testable with an in-memory fake and the shell can back it with
    a real file store, without this core knowing which. Values are JSON-shaped
    vars (string/number/bool/object), mirroring scoopy's UserDefaults values;
    an absent key reads as `var()` (→ null on the wire). */
class SettingsStore {
public:
    virtual ~SettingsStore() = default;
    virtual juce::var get(const juce::String& key) const = 0;
    virtual void set(const juce::String& key, const juce::var& value) = 0;
    virtual bool has(const juce::String& key) const = 0;
};

/** Reply shape: { ok, result?, error? } — the shared envelope (envelope.ts),
    the same one scoopy's JuceLink checks `ok !== true` against. */
juce::var dispatch(const juce::String& method, const juce::var& params, SettingsStore& settings);

/** The merged host's capability model, exposed for the test and for Main.cpp to
    reuse. schemaVersion MUST track scoopy's SCHEMA_VERSION or its UI renders a
    mismatch banner — a runtime backstop for the one coupling a C++/TS split
    can't check at build time. */
juce::var capabilities();

} // namespace wizard::sl
