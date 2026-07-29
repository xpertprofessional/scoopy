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

#include <string>

struct sl_engine;

namespace scoopyloops {
class NativePluginScanner;
}

namespace wizard::record {
class Service;
}

namespace wizard::host {
class AudioIO;
}

namespace wizard::sl {

/** Host-tier services the pure dispatcher cannot own but some commands need.
    Recording is the case: it is half engine (sl_tape_record_*) and half FILE —
    the drain thread, the take directory, the crash-safe writer — and the file
    half lives in the host. Injected as a struct rather than reached through a
    global so the headless test can pass nothing and prove the refusal path,
    which is the same thing the merged shell does before its device opens.

    A null `recorder` is a legitimate state, not a bug: the dispatcher then
    refuses the record commands honestly instead of pretending to capture. */
struct HostServices {
    record::Service* recorder = nullptr;
    /** Where takes live. Enumeration reads this directly rather than asking the
        recorder, because the point of scanning is to find takes THIS process
        never made. */
    std::string takesDir;
    /** The device layer, for the plane's input SOURCE PICKER.
        A strip's live input is a route from a deviceInput ENDPOINT, and until
        something can name the inputs the picker has nothing to offer — which is
        why every strip was hard-wired to channels 0/1. Nullable: a host with no
        device still answers every other command. */
    host::AudioIO* audio = nullptr;
    /** The AU/VST3 plugin scanner (P6-2) — owned by the app, which is the only
        process with the real NativePluginHost implementation and a JUCE message
        loop for it to marshal on. Null = this host cannot host plugins, and the
        plugin commands (and the pluginHosting capability) say so honestly —
        which is also the headless-test state, where the link-time stub would
        answer empty anyway. */
    scoopyloops::NativePluginScanner* pluginScanner = nullptr;
};

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
    the same one scoopy's JuceLink checks `ok !== true` against.

    `engine` is nullable: the boot handshake (capabilities/settings/view-state)
    needs no engine, so headless settings tests pass nullptr and get identical
    replies. The play path (`worldPublish`) uses it when present, and refuses
    honestly when it is absent — never a fake success. */
juce::var dispatch(const juce::String& method, const juce::var& params,
                   SettingsStore& settings, sl_engine* engine,
                   HostServices* services = nullptr);

/** The merged host's capability model, exposed for the test and for Main.cpp to
    reuse. schemaVersion MUST track scoopy's SCHEMA_VERSION or its UI renders a
    mismatch banner — a runtime backstop for the one coupling a C++/TS split
    can't check at build time.

    `services` (nullable) decides the host-dependent flags: pluginHosting is
    true exactly when a scanner is present — the app passes its services, the
    headless test passes nothing and reads the honest false. */
juce::var capabilities(const HostServices* services = nullptr);

/** The "toolbar" uiState push (P6-2). Exists FOR `fxSlots` — the FxSlotPanel
    (the FX 1–4 doors) subscribes to this topic and renders WaitingForState
    until it arrives. The fxSlot entries are truthful (name/latency read from
    the engine's return slots); every other field is the schema-required
    NEUTRAL, explicitly, because the surfaces that would read them (deckmixer /
    djmode / transport) are retired doors in this host. GUI-free so the shape
    is pinned headlessly. */
juce::var toolbarState(sl_engine* engine, HostServices* services);

} // namespace wizard::sl
