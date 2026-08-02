#include "SlDispatch.h"

#include "AudioIO.h"
#include "MidiHost.h"
#include "NativePluginHost.hpp" // JUCE-free scanner surface (P6-2)
#include "RecordService.h"
#include "SlWorldApply.h"
#include "TakeScan.h"
#include "sl_engine.h"

#include <vector>

namespace wizard::sl {

namespace {

juce::var ok(juce::var result) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("ok", true);
    obj->setProperty("result", std::move(result));
    return juce::var(obj);
}

juce::var fail(const juce::String& error) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("ok", false);
    obj->setProperty("error", error);
    return juce::var(obj);
}

juce::var emptyObject() { return juce::var(new juce::DynamicObject()); }

/** `{ ok: true }` — the shape every plane command's result starts from. */
juce::var okFlag(bool value = true) {
    auto* o = new juce::DynamicObject();
    o->setProperty("ok", value);
    return juce::var(o);
}

int intProp(const juce::var& params, const char* key, int fallback = 0) {
    const auto v = params.getProperty(key, juce::var());
    return v.isVoid() ? fallback : static_cast<int>(v);
}

double numProp(const juce::var& params, const char* key, double fallback = 0.0) {
    const auto v = params.getProperty(key, juce::var());
    return v.isVoid() ? fallback : static_cast<double>(v);
}

bool boolProp(const juce::var& params, const char* key, bool fallback = false) {
    const auto v = params.getProperty(key, juce::var());
    return v.isVoid() ? fallback : static_cast<bool>(v);
}

/** Frames of tape material this engine says exist, for range-checking a loop or
    a waveform span before it reaches the ABI. */
uint64_t tapeFrames(const sl_engine* e, uint32_t tape) {
    return sl_tape_frames(e, tape);
}

} // namespace

juce::var capabilities(const HostServices* services) {
    auto* obj = new juce::DynamicObject();
    // ⚠️ Must equal scoopy web/protocol/schema.ts SCHEMA_VERSION. A mismatch is
    // not silent — scoopy's debug panel renders "SCHEMA MISMATCH" — which is the
    // runtime backstop for a coupling the C++/TS split cannot check at build
    // time. A future codegen step could emit this from schema.ts; until then it
    // is a loud constant, deliberately not buried.
    // ⚠️ THIS WAS **92** AGAINST A schema.ts OF 96 (H5 found it, `schema:check`
    // now gates it). Four versions stale, and the "loud constant" above was not
    // loud enough on its own — the two things that were supposed to catch it
    // both missed:
    //   · App.tsx:207 DOES compare them and set "SCHEMA MISMATCH: ui vN vs
    //     engine vM" — but it renders on the FALLBACK debug panel, and every
    //     real panel (`plane` included) returns before reaching it. The backstop
    //     was defeated by routing, not absent.
    //   · every browser walk passed, because `browserLink.ts:275` reports the
    //     UI's OWN constant — the browser host agrees with itself BY
    //     CONSTRUCTION and cannot fail this check however wrong native is.
    // A comment saying "must equal" is not a gate. `npm run schema:check` is.
    obj->setProperty("schemaVersion", 98);
    // The merged host = wizard's JUCE shell hosting scoopy's UI. Each flag is
    // what that host can ACTUALLY do today, not what it aspires to — scoopy's UI
    // renders native-only surfaces inert from these, so an optimistic `true`
    // here shows a control that then does nothing.
    //
    // pluginHosting is PER-HOST truth (P6-2): true exactly when a scanner is
    // present — the app owns one since the host compiled in (P6-1); a headless
    // dispatcher has none and stays false.
    obj->setProperty("pluginHosting",
                     services != nullptr && services->pluginScanner != nullptr);
    obj->setProperty("fileSystem", true);          // the shell owns native dialogs
    obj->setProperty("midiHardware", false);       // not built
    obj->setProperty("audioDeviceSelection", true);// wizard's AudioIO enumerates/selects
    // returnFx: "the send/return section reaches something real".
    //
    // P6-3 derived this from the scanner alone, on the rule "a return is either
    // external or a hosted plugin" — true of the two hosts that existed then.
    // ScoopyDeck broke it (D-SL-DECKPLUGIN-02 · D1): it hosts no plugins BY
    // DECISION and its returns are external, routed out of Return 1-4 into DAW
    // tracks. The derivation answered false, which hid the S1-S4 row and made
    // `worldFromSession` zero every send — the send section invisible and
    // silent in the one host built around sends.
    //
    // So the two questions are separate now. A hosted plugin still implies a
    // real return (an unloaded slot consumes the send into silence, which is
    // the honest meaning of an empty slot); `externalReturns` is the other way
    // to earn it, and neither implies the other.
    obj->setProperty("returnFx",
                     services != nullptr &&
                         (services->pluginScanner != nullptr || services->externalReturns));
    return juce::var(obj);
}

juce::var dispatch(const juce::String& method, const juce::var& params,
                   SettingsStore& settings, sl_engine* engine,
                   HostServices* services) {
    if (method == "getCapabilities")
        return ok(capabilities(services));

    // ── Play path (Option B) ─────────────────────────────────────────────────
    // This host's worldPublish carries a FLAT World object (already keyed by
    // engine name by the web layer's worldFromSession + field->name table),
    // under `world` — NOT scoopy's stock `json` PatternFile string, which the
    // native side deliberately does not parse (that translation lives in TS).
    if (method == "worldPublish") {
        if (engine == nullptr) return fail("worldPublish: no engine on this host");
        const auto world = params.getProperty("world", juce::var());
        if (world.getDynamicObject() == nullptr)
            return fail("worldPublish: expected a flat `world` object (Option B), "
                        "not a PatternFile string");
        // applyWorld returns {applied, error} — exactly this command's result.
        return ok(applyWorld(engine, world));
    }

    // ── Settings quartet ────────────────────────────────────────────────────
    if (method == "getSetting") {
        const auto key = params.getProperty("key", juce::var()).toString();
        if (key.isEmpty()) return fail("getSetting: key missing");
        // Absent key → { value: null }, never a fabricated default: the UI
        // distinguishes "unset" from "set to a falsy value" and picks its own
        // default for the former.
        auto* r = new juce::DynamicObject();
        r->setProperty("value", settings.has(key) ? settings.get(key) : juce::var());
        return ok(juce::var(r));
    }

    if (method == "setSetting") {
        const auto key = params.getProperty("key", juce::var()).toString();
        if (key.isEmpty()) return fail("setSetting: key missing");
        // The property is present-but-null for an explicit clear; getProperty's
        // default only fills in when the key is truly absent from the payload.
        settings.set(key, params.getProperty("value", juce::var()));
        return ok(emptyObject());
    }

    if (method == "getSettings") {
        const auto keys = params.getProperty("keys", juce::var());
        if (!keys.isArray()) return fail("getSettings: keys must be an array");
        auto* values = new juce::DynamicObject();
        for (const auto& k : *keys.getArray()) {
            const auto key = k.toString();
            // Only keys that exist are returned; the UI treats a missing entry
            // as unset, so echoing null for every asked key would erase that
            // distinction.
            if (settings.has(key)) values->setProperty(key, settings.get(key));
        }
        auto* r = new juce::DynamicObject();
        r->setProperty("values", juce::var(values));
        return ok(juce::var(r));
    }

    // ── View state ───────────────────────────────────────────────────────────
    // getUiState answers the empty object for every topic: this host pushes UI
    // state via the slUiState event lane (as the spike showed), so the pull is a
    // safe default rather than a source of truth. The UI renders its own default
    // for an empty topic — which is exactly what it does on the desktop before
    // the first push arrives.
    if (method == "getUiState")
        return ok(emptyObject());

    // ── MIDI: devices and roles (S9, ledger B8) ─────────────────────────────
    //
    // ⚠️ THE CONFIGURATION HALF ONLY, and the honesty is the point. These
    // enumerate real CoreMIDI endpoints and remember which one holds which
    // role. Nothing here emits a note or a clock byte: that needs an engine
    // MIDI door which does not exist (`ScoopyPluginProcessor.h` records the
    // same wall). `getCapabilities` therefore still answers `midiHardware:
    // false` — see the note there — so no surface lights up claiming a
    // hardware lane that cannot carry anything yet.
    //
    // Before this, all eleven MIDI methods were specified in `schema.ts` and
    // answered by NOBODY, so `MidiPanel.tsx` — a complete donor-parity pane —
    // showed "loading endpoints…" forever.
    if (method == "enumerateMidiEndpoints" || method == "refreshMidiDevices" ||
        method == "setMidiEnabled" || method == "selectMidiDevice" ||
        method == "setMidiSyncMode" || method == "setMidiSlaveTransportPolicy" ||
        method == "getMidiClockStatus") {
        auto* midi = services != nullptr ? services->midi : nullptr;
        if (midi == nullptr) return fail(method + ": no MIDI surface on this build");

        const auto roleOf = [](const juce::String& r) {
            if (r == "cc") return host::MidiHost::Role::cc;
            if (r == "note") return host::MidiHost::Role::note;
            if (r == "clock") return host::MidiHost::Role::clock;
            return host::MidiHost::Role::clockOutput;
        };

        if (method == "refreshMidiDevices") {
            midi->refresh();
            return ok(emptyObject());
        }
        if (method == "setMidiEnabled") {
            midi->setEnabled(params.getProperty("enabled", false));
            return ok(emptyObject());
        }
        if (method == "selectMidiDevice") {
            midi->select(roleOf(params.getProperty("role", "cc").toString()),
                         static_cast<int>(params.getProperty("deviceId", 0)));
            return ok(emptyObject());
        }
        if (method == "setMidiSyncMode") {
            midi->syncMode = params.getProperty("mode", "internalMaster").toString();
            return ok(emptyObject());
        }
        if (method == "setMidiSlaveTransportPolicy") {
            midi->slaveTransportPolicy =
                params.getProperty("policy", "fullTransport").toString();
            return ok(emptyObject());
        }
        if (method == "getMidiClockStatus") {
            // HONEST ZEROES. There is no clock input, so `locked` is false and
            // stays false. Reporting a plausible bpm here would be the worst
            // kind of wrong: a readout that looks alive over a lane carrying
            // nothing.
            auto* st = new juce::DynamicObject();
            st->setProperty("locked", false);
            st->setProperty("bpm", 0.0);
            st->setProperty("tickCount", 0);
            return ok(juce::var(st));
        }

        // enumerateMidiEndpoints
        midi->refresh();
        const auto listVar = [](const juce::Array<host::MidiHost::Endpoint>& in) {
            juce::Array<juce::var> out;
            for (const auto& e : in) {
                auto* o = new juce::DynamicObject();
                o->setProperty("id", e.id);
                o->setProperty("name", e.name);
                out.add(juce::var(o));
            }
            return juce::var(out);
        };
        auto* obj = new juce::DynamicObject();
        obj->setProperty("sources", listVar(midi->sources()));
        obj->setProperty("destinations", listVar(midi->destinations()));
        obj->setProperty("enabled", midi->enabled());
        obj->setProperty("ccDeviceId", midi->selected(host::MidiHost::Role::cc));
        obj->setProperty("noteDeviceId", midi->selected(host::MidiHost::Role::note));
        obj->setProperty("clockDeviceId", midi->selected(host::MidiHost::Role::clock));
        obj->setProperty("clockOutputId", midi->selected(host::MidiHost::Role::clockOutput));
        obj->setProperty("syncMode", midi->syncMode);
        obj->setProperty("slaveTransportPolicy", midi->slaveTransportPolicy);
        return ok(juce::var(obj));
    }

    // ── Plugin scanner + FX-return slots (P6-2) ─────────────────────────────
    //
    // The scanner is HOST property (services->pluginScanner): the app owns the
    // real JUCE-backed one, a headless dispatcher owns none and every command
    // here refuses by name — the same honest shape as the record commands.
    if (method == "listPlugins" || method == "listInstruments") {
        auto* scanner = services != nullptr ? services->pluginScanner : nullptr;
        if (scanner == nullptr) return fail(method + ": no plugin host on this build");
        // One scan, two halves: FX inserts for the return picker, instruments
        // for the track row — same list, opposite isInstrument filter.
        const bool wantInstruments = (method == "listInstruments");
        juce::Array<juce::var> list;
        for (const auto& p : scanner->results()) {
            if (p.isInstrument != wantInstruments) continue;
            auto* obj = new juce::DynamicObject();
            obj->setProperty("identifier", juce::String(p.identifier));
            obj->setProperty("name", juce::String(p.name));
            obj->setProperty("manufacturer", juce::String(p.manufacturer));
            obj->setProperty("format", juce::String(p.format));
            list.add(juce::var(obj));
        }
        auto* r = new juce::DynamicObject();
        r->setProperty("plugins", juce::var(list));
        r->setProperty("scanning", scanner->isScanning());
        return ok(juce::var(r));
    }

    if (method == "rescanPlugins") {
        auto* scanner = services != nullptr ? services->pluginScanner : nullptr;
        if (scanner == nullptr) return fail("rescanPlugins: no plugin host on this build");
        // Fire-and-forget: the scan runs out-of-process per plugin and can take
        // minutes on a first sweep. The panel polls listPlugins while
        // `scanning` reads true — that poll IS the progress UI, so no event
        // lane is needed here. No-op if a scan is already running (the
        // scanner's own guard).
        scanner->beginScan(/*progress*/ nullptr, /*completion*/ nullptr);
        return ok(emptyObject());
    }

    if (method == "selectFxPlugin") {
        auto* scanner = services != nullptr ? services->pluginScanner : nullptr;
        if (scanner == nullptr) return fail("selectFxPlugin: no plugin host on this build");
        if (engine == nullptr) return fail("selectFxPlugin: no engine on this host");
        const int returnIndex = static_cast<int>(params.getProperty("returnIndex", 0));
        // null identifier = unload — the picker's "— none —" row.
        const auto idVar = params.getProperty("identifier", juce::var());
        const juce::String identifier = idVar.isVoid() ? juce::String() : idVar.toString();
        // P6-5: an optional opaque state blob, applied AT INSTANTIATION so a
        // restored plugin is never briefly heard at its defaults. Absent on every
        // ordinary pick from the list — only a map restore has a blob to give.
        const auto stateVar = params.getProperty("state", juce::var());
        const juce::String state = stateVar.isVoid() ? juce::String() : stateVar.toString();
        if (sl_fx_plugin_select_state(engine, returnIndex, scanner,
                                      identifier.isEmpty() ? nullptr : identifier.toRawUTF8(),
                                      state.isEmpty() ? nullptr : state.toRawUTF8()) == 0)
            return fail("selectFxPlugin: refused (bad returnIndex or hostless build)");
        // Accepted, not loaded: instantiation is async on the message thread.
        // The toolbar push picks the name/latency up when the load lands.
        return ok(emptyObject());
    }

    // WHAT A MAP MUST STORE ABOUT THE FX RETURNS (P6-5) — the identifier a
    // plugin can be found by again, and its own opaque state.
    //
    // A COMMAND, not a field on the toolbar push, and the blob's size is the
    // reason: a plugin carrying an impulse response or sample content runs to
    // hundreds of KB, and that has no business crossing the bridge twice a second
    // for a UI that never displays it. This is pulled once, when a map is saved.
    if (method == "getFxSlotState") {
        if (engine == nullptr) return fail("getFxSlotState: no engine on this host");
        juce::Array<juce::var> slots;
        for (int i = 1; i <= 4; ++i) {
            auto* o = new juce::DynamicObject();
            o->setProperty("returnIndex", i);
            // Sized twice by design (see sl_engine.h): ask for the length, then
            // fill exactly that. Truncating a state blob would persist something
            // the plugin rejects on restore — a map that quietly forgets.
            const uint32_t idLen = sl_fx_plugin_identifier(engine, i, nullptr, 0);
            if (idLen == 0) {
                // Explicit nulls: an empty slot is a FACT the document records,
                // not a key it omits (zod .nullable() demands the key exist, and
                // a missing key would read as "unknown" instead of "empty").
                o->setProperty("identifier", juce::var());
                o->setProperty("state", juce::var());
                slots.add(juce::var(o));
                continue;
            }
            std::vector<char> idBuf(idLen + 1, '\0');
            sl_fx_plugin_identifier(engine, i, idBuf.data(), idLen + 1);
            o->setProperty("identifier", juce::String(juce::CharPointer_UTF8(idBuf.data())));

            const uint32_t stLen = sl_fx_plugin_state(engine, i, nullptr, 0);
            if (stLen == 0) {
                // A plugin that saves nothing is normal (AUDelay does exactly
                // this on some hosts) — the identifier alone still restores it.
                o->setProperty("state", juce::var());
            } else {
                std::vector<char> stBuf(stLen + 1, '\0');
                sl_fx_plugin_state(engine, i, stBuf.data(), stLen + 1);
                o->setProperty("state", juce::String(juce::CharPointer_UTF8(stBuf.data())));
            }
            slots.add(juce::var(o));
        }
        auto* res = new juce::DynamicObject();
        res->setProperty("slots", juce::var(slots));
        return ok(juce::var(res));
    }

    // The FX slot's per-return controls. Only the EDITOR is backed here (P6-4);
    // the other three ops belong to controls whose home is the mixer strip, and
    // the merged host has no mixer yet (P7-MIX-0, blocked on P6-AUDIT). They are
    // refused BY NAME rather than swallowed: a UI that sent `toggleMode` and got
    // a silent `{}` would draw a mode it is not in, which is worse than a
    // refusal the note line can show (P3-U6 puts these on screen).
    if (method == "fxSlot") {
        if (engine == nullptr) return fail("fxSlot: no engine on this host");
        const int returnIndex = static_cast<int>(params.getProperty("returnIndex", 0));
        if (returnIndex < 1 || returnIndex > 4)
            return fail("fxSlot: returnIndex must be 1–4");
        const auto op = params.getProperty("op", juce::var()).toString();
        if (op == "toggleEditor") {
            if (services == nullptr || services->pluginScanner == nullptr)
                return fail("fxSlot: no plugin host on this build");
            // TOGGLE reads the ENGINE's state, never a client's idea of it: the
            // window can be closed by its own close box, so a caller flipping its
            // own last request would need two clicks to reopen it.
            if (sl_fx_editor_available(engine, returnIndex) == 0)
                return fail("fxSlot: no plugin with an editor on FX "
                            + juce::String(returnIndex));
            const bool shown = sl_fx_editor_visible(engine, returnIndex) != 0;
            sl_fx_editor_set_visible(engine, returnIndex, shown ? 0 : 1);
            // The reply carries no state on purpose — the work is marshalled to
            // the JUCE message thread and has not happened yet. The ~2 Hz toolbar
            // push is what reports the window, and it reports the WINDOW.
            return ok(emptyObject());
        }
        return fail("fxSlot: '" + op + "' is not implemented in the merged host yet "
                    "(the mixer strip's controls arrive with P7-MIX-0)");
    }

    // ── The plane (merge P2 step 4) ──────────────────────────────────────────
    //
    // The merged engine's strip surface, reached by NOUN with an `action` verb
    // (schema.ts's own gridEdit/fxSlot/capture style). The C ABI stays the
    // authority; this is a thin, validating adapter onto it — no policy, no
    // state of its own. Where an action's required field is missing the reply
    // is a loud refusal, because one zod object serves every action and so the
    // combination can only be checked here.
    if (method.startsWith("sl") &&
        (method == "slChannel" || method == "slTape" || method == "slRoute" ||
         method == "slRouteList" || method == "slRecord" || method == "slWorld" ||
         method == "slDeck" || method == "slMaster")) {
        if (engine == nullptr) return fail(method + ": no engine on this host");
    }

    if (method == "slChannel") {
        const auto action = params.getProperty("action", juce::var()).toString();
        const auto ch = static_cast<uint32_t>(intProp(params, "channel"));
        if (action == "setSource") {
            const auto kind = static_cast<uint32_t>(intProp(params, "kind"));
            const auto index = static_cast<uint32_t>(intProp(params, "index"));
            // Binding is the one channel op that can be REFUSED by the engine
            // (unknown kind, out-of-range tape/deck), so its result is reported
            // rather than assumed — a silently-unbound strip would render
            // nothing with no explanation anywhere.
            return ok(okFlag(sl_channel_set_source(engine, ch, kind, index) == 1));
        }
        if (action == "setLevel") {
            sl_channel_set_level(engine, ch, numProp(params, "level", 1.0));
            return ok(okFlag());
        }
        if (action == "setMute") {
            sl_channel_set_mute(engine, ch, boolProp(params, "muted") ? 1u : 0u);
            return ok(okFlag());
        }
        // THE MONITOR SWITCH — whether this strip's device input reaches the
        // channel. Distinct from mute, which is the channel's OUTPUT: the two
        // were conflated and `M` was the only way to stop an input feeding back,
        // which also killed the tape. See sl_engine.h's sl_channel_set_monitor.
        //
        // The reply carries the state the ENGINE ended up in, not the request,
        // because the engine moves this switch itself at record-start and at the
        // Law C-3 handoff — a caller that assumed its own value would draw a lit
        // MON over a closed gate.
        if (action == "setMonitor") {
            sl_channel_set_monitor(engine, ch, boolProp(params, "on") ? 1u : 0u);
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("monitor", sl_channel_monitor(engine, ch) != 0);
            return ok(juce::var(o));
        }
        if (action == "setSend") {
            sl_channel_set_send(engine, ch, static_cast<uint32_t>(intProp(params, "send")),
                                numProp(params, "level"));
            return ok(okFlag());
        }
        // Per-strip DRV (P3-X2). Tape/input strips only by convention: a grid
        // strip's DRV is the session document's masterClipper block (the core's
        // per-deck stage is document-fed — see sl_engine.h's setDrive note).
        if (action == "setDrive") {
            sl_channel_set_drive(engine, ch, static_cast<uint32_t>(intProp(params, "curve")),
                                 numProp(params, "amount", 1.0));
            return ok(okFlag());
        }
        return fail("slChannel: unknown action '" + action + "'");
    }

    if (method == "slTape") {
        const auto action = params.getProperty("action", juce::var()).toString();
        const auto tape = static_cast<uint32_t>(intProp(params, "tape"));
        if (action == "trigger") {
            sl_tape_trigger(engine, tape, static_cast<uint32_t>(intProp(params, "mode")));
            return ok(okFlag());
        }
        if (action == "seek") {
            sl_tape_seek(engine, tape, static_cast<uint64_t>(numProp(params, "frame")));
            return ok(okFlag());
        }
        if (action == "setLoop") {
            sl_tape_set_loop(engine, tape, boolProp(params, "enabled") ? 1u : 0u,
                             static_cast<uint64_t>(numProp(params, "start")),
                             static_cast<uint64_t>(numProp(params, "end")));
            return ok(okFlag());
        }
        if (action == "setRate") {
            sl_tape_set_rate(engine, tape, numProp(params, "rate", 1.0));
            return ok(okFlag());
        }
        if (action == "setTempoMode") {
            // P3-2b-5: 0 timePitch · 1 timeStretch. The mode decides what the
            // one rate number drives; entering 1 lazily allocates the tape's
            // stretcher (async warm-up — the render stays dry until warm).
            sl_tape_set_tempo_mode(engine, tape,
                                   static_cast<uint32_t>(intProp(params, "mode")));
            return ok(okFlag());
        }
        if (action == "scrubBegin") { sl_tape_scrub_begin(engine, tape); return ok(okFlag()); }
        if (action == "scrubTo") {
            sl_tape_scrub_to(engine, tape, numProp(params, "frame"));
            return ok(okFlag());
        }
        if (action == "scrubEnd") { sl_tape_scrub_end(engine, tape); return ok(okFlag()); }
        if (action == "overdubStart") {
            // A PUNCH, MADE WHOLE (P3-U3). The engine layers the tape's RECORD
            // SOURCE into the loop — so the source must be SET here (an unset
            // source layers silence, which is a punch that "worked" and did
            // nothing), and each pass must drain to its own crash-safe stamped
            // take: the RAM mix is destructive, the file is what preserves the
            // pass (D-WZ-OVERDUB-01 / recorder.md §9).
            if (services == nullptr || services->recorder == nullptr)
                return fail("slTape/overdubStart: no recorder on this host");
            const auto kind = static_cast<uint32_t>(intProp(params, "sourceKind", 0));
            const auto c0 = static_cast<int32_t>(intProp(params, "chan0", 0));
            const auto c1 = static_cast<int32_t>(intProp(params, "chan1", -1));
            if (sl_tape_set_record_source(engine, tape, kind, c0, c1) != 1)
                return fail("slTape/overdubStart: the engine refused that record source");
            // The punch begins within one block of now — an overdub's start is
            // known at OPEN, unlike a recording's (which only record-stop can
            // report), so the stamp is captured here and KEPT at close.
            const uint64_t startedAt = sl_engine_time_samples(engine);
            sl_tape_overdub_start(engine, tape, static_cast<uint32_t>(intProp(params, "mode")));
            const bool opened = services->recorder->beginTake(
                tape, sl_tape_channels(engine, tape), sl_engine_sample_rate(engine), startedAt,
                params.getProperty("sourceDesc", "overdub").toString().toStdString(),
                numProp(params, "bpmAtStart", 0.0));
            return ok(okFlag(opened));
        }
        if (action == "overdubStop") {
            sl_tape_overdub_stop(engine, tape);
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            if (services != nullptr && services->recorder != nullptr &&
                services->recorder->endTakeKeepStamp(tape)) {
                const auto all = services->recorder->takes();
                if (!all.empty()) o->setProperty("path", juce::String(all.back().path));
            }
            return ok(juce::var(o));
        }
        if (action == "info") {
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("frames", static_cast<juce::int64>(sl_tape_frames(engine, tape)));
            o->setProperty("channels", static_cast<int>(sl_tape_channels(engine, tape)));
            o->setProperty("rate", sl_tape_rate(engine, tape));
            o->setProperty("state", static_cast<int>(sl_tape_state(engine, tape)));
            return ok(juce::var(o));
        }
        if (action == "waveform") {
            const auto columns = static_cast<uint32_t>(intProp(params, "columns", 0));
            if (columns == 0) return fail("slTape/waveform: columns must be > 0");
            const auto frames = tapeFrames(engine, tape);
            const auto startF = static_cast<uint64_t>(numProp(params, "startFrame", 0.0));
            // An absent/zero end means "the whole tape", which is what a strip
            // that has just finished recording asks for and does not yet know
            // the length of.
            const auto endRaw = static_cast<uint64_t>(numProp(params, "endFrame", 0.0));
            const auto endF = endRaw == 0 ? frames : endRaw;
            std::vector<float> mn(columns, 0.0f), mx(columns, 0.0f);
            const auto written =
                sl_tape_waveform(engine, tape, static_cast<uint32_t>(intProp(params, "channel")),
                                 startF, endF, columns, mn.data(), mx.data());
            juce::Array<juce::var> aMin, aMax;
            // `written` may be short of `columns` (an empty or shorter tape);
            // reporting only what was written keeps the UI from drawing zeros
            // it would read as real silence at the end of the wave.
            for (uint32_t i = 0; i < written; ++i) {
                aMin.add(static_cast<double>(mn[i]));
                aMax.add(static_cast<double>(mx[i]));
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("min", juce::var(aMin));
            o->setProperty("max", juce::var(aMax));
            return ok(juce::var(o));
        }
        return fail("slTape: unknown action '" + action + "'");
    }

    if (method == "slRoute") {
        const auto action = params.getProperty("action", juce::var()).toString();
        if (action == "clearAll") { sl_route_clear_all(engine); return ok(okFlag()); }
        if (action == "installDefaults") {
            sl_route_install_defaults(engine);
            return ok(okFlag());
        }
        if (action == "add") {
            const auto id = sl_route_add_ex(
                engine, static_cast<uint32_t>(intProp(params, "srcKind")),
                static_cast<uint32_t>(intProp(params, "srcIndex")),
                static_cast<uint32_t>(intProp(params, "srcSub", -1)),
                static_cast<uint32_t>(intProp(params, "dstKind")),
                static_cast<uint32_t>(intProp(params, "dstIndex")),
                numProp(params, "gain", 1.0), boolProp(params, "feedback") ? 1u : 0u);
            auto* o = new juce::DynamicObject();
            // A REFUSAL IS A RESULT, not an error: the commonest reason is "this
            // would close a cycle and you did not ask for a feedback edge",
            // which the UI answers by offering one. Failing the whole command
            // would make that an exception to catch instead of a choice to make.
            o->setProperty("ok", id >= 0);
            if (id >= 0) o->setProperty("id", static_cast<int>(id));
            return ok(juce::var(o));
        }
        if (action == "remove") {
            return ok(okFlag(sl_route_remove(engine,
                                             static_cast<uint32_t>(intProp(params, "id"))) == 1));
        }
        if (action == "setGain") {
            sl_route_set_gain(engine, static_cast<uint32_t>(intProp(params, "id")),
                              numProp(params, "gain", 1.0));
            return ok(okFlag());
        }
        if (action == "wouldCycle") {
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("wouldCycle",
                           sl_route_would_cycle(
                               engine, static_cast<uint32_t>(intProp(params, "srcIndex")),
                               static_cast<uint32_t>(intProp(params, "dstIndex"))) != 0);
            return ok(juce::var(o));
        }
        return fail("slRoute: unknown action '" + action + "'");
    }

    if (method == "slRouteList") {
        juce::Array<juce::var> arr;
        const auto capacity = sl_route_capacity();
        for (uint32_t id = 0; id < capacity; ++id) {
            auto* r = new juce::DynamicObject();
            const bool active = sl_route_active(engine, id) != 0;
            r->setProperty("active", active);
            r->setProperty("srcKind", static_cast<int>(sl_route_source_kind(engine, id)));
            r->setProperty("srcIndex", static_cast<int>(sl_route_source_index(engine, id)));
            // Passed through as the engine's 0xFFFFFFFF sentinel rather than
            // folded to 0 or null here: 0 is a real send index and a real input
            // channel, and captureRoutes() already knows the sentinel.
            r->setProperty("srcSub",
                           static_cast<double>(sl_route_source_sub(engine, id)));
            r->setProperty("dstKind", static_cast<int>(sl_route_dest_kind(engine, id)));
            r->setProperty("dstIndex", static_cast<int>(sl_route_dest_index(engine, id)));
            r->setProperty("gain", sl_route_gain(engine, id));
            r->setProperty("feedback", sl_route_feedback(engine, id) != 0);
            r->setProperty("isDefault", sl_route_is_default(engine, id) != 0);
            arr.add(juce::var(r));
        }
        std::vector<uint32_t> order(sl_channel_count(), 0u);
        sl_route_render_order(engine, order.data());
        juce::Array<juce::var> orderArr;
        for (auto c : order) orderArr.add(static_cast<int>(c));

        auto* o = new juce::DynamicObject();
        o->setProperty("routes", juce::var(arr));
        o->setProperty("renderOrder", juce::var(orderArr));
        return ok(juce::var(o));
    }

    // ── Recording: half engine, half file ────────────────────────────────────
    if (method == "slRecord") {
        if (services == nullptr || services->recorder == nullptr)
            return fail("slRecord: this host has no record service");
        auto& recorder = *services->recorder;
        const auto action = params.getProperty("action", juce::var()).toString();
        const auto tape = static_cast<uint32_t>(intProp(params, "tape"));

        if (action == "start") {
            const auto kind = static_cast<uint32_t>(intProp(params, "sourceKind"));
            const auto c0 = static_cast<int32_t>(intProp(params, "chan0"));
            const auto c1 = static_cast<int32_t>(intProp(params, "chan1", -1));
            // The engine REFUSES an unknown kind or an unbacked channel rather
            // than falling back to input 0. Stop here if it does: opening a take
            // file for a capture that will never happen leaves a 0-frame wav on
            // disk that looks exactly like a lost recording.
            if (sl_tape_set_record_source(engine, tape, kind, c0, c1) != 1)
                return fail("slRecord: the engine refused that record source");
            // Pre-allocate chunks BEFORE capture begins, on this (non-audio)
            // thread — the whole point of the service seam.
            sl_tape_record_service(engine);
            sl_tape_record_start(engine, tape);
            // ⚠️ THE TAKE'S WIDTH IS THE ENGINE'S, NOT THE REQUEST'S (P3-F3).
            // This used to be `c1 >= 0 ? 2u : 1u` — the requested channel pair.
            // But a channelBus or mainMix capture is ALWAYS STEREO in the ring
            // (sl_channel_test pins it: "a bus is always stereo"), so a bus
            // take asked for with chan1 = -1 opened a MONO file while drain()
            // delivered stereo frames: the drain scratch overflowed by 2× —
            // REAL heap corruption on every REC-from-bus stop (the P3-R2/R3
            // gesture) — and the WAV held interleaved halves at double speed.
            // record_start has already stamped the true capture width, so ask
            // the engine — the same pattern overdubStart used from day one.
            const bool opened = recorder.beginTake(
                tape, sl_tape_channels(engine, tape), sl_engine_sample_rate(engine),
                0 /* the engine stamps the true start; applied at endTake */,
                params.getProperty("sourceDesc", "").toString().toStdString(),
                // P3-2b-1: the MASTER tempo when capture began, from TS (the
                // tempo authority). 0 = caller had none; the sidecar omits it.
                numProp(params, "bpmAtStart", 0.0));
            return ok(okFlag(opened));
        }
        if (action == "stop") {
            // ORDER IS LOAD-BEARING. record_stop RETURNS the Law C-2 start
            // stamp — the only moment it exists — and endTake writes it into
            // the file's bext TimeReference and the sidecar. Reversing these,
            // or dropping the stamp between them, is exactly how every take
            // came to ship TimeReference = 0 before recorder_drain_test.
            const auto stamp = sl_tape_record_stop(engine, tape);
            const bool closed = recorder.endTake(tape, stamp);
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", closed);
            o->setProperty("startEngineSample", static_cast<double>(stamp));
            const auto all = recorder.takes();
            if (!all.empty()) {
                o->setProperty("path", juce::String(all.back().path));
                o->setProperty("frames", static_cast<double>(all.back().frames));
            }
            return ok(juce::var(o));
        }
        return fail("slRecord: unknown action '" + action + "'");
    }

    // ── The .scoopyMap document ──────────────────────────────────────────────
    //
    // The shell moves BYTES; the document layer decides what they mean. No
    // parsing here, and no path ever handed to the web layer — a webview must
    // not hold a filesystem path it could dereference.
    if (method == "slMap") {
        if (services == nullptr || services->takesDir.empty())
            return fail("slMap: this host has no document directory");
        const juce::File dir = juce::File(services->takesDir).getParentDirectory()
                                   .getChildFile("Maps");
        const auto action = params.getProperty("action", juce::var()).toString();

        if (action == "list") {
            dir.createDirectory();
            juce::Array<juce::var> arr;
            for (const auto& f : dir.findChildFiles(juce::File::findFiles, false, "*.scoopyMap")) {
                auto* o = new juce::DynamicObject();
                o->setProperty("name", f.getFileNameWithoutExtension());
                o->setProperty("savedAt",
                               static_cast<double>(f.getLastModificationTime().toMilliseconds()));
                arr.add(juce::var(o));
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("maps", juce::var(arr));
            return ok(juce::var(o));
        }

        const auto name = params.getProperty("name", juce::var()).toString();
        if (name.isEmpty()) return fail("slMap: name missing");
        // A name is a FILE NAME, never a path: `../` in a document name must not
        // be able to write outside the maps directory.
        const auto safe = juce::File::createLegalFileName(name);
        if (safe.isEmpty()) return fail("slMap: name is not a usable file name");
        const auto file = dir.getChildFile(safe + ".scoopyMap");

        if (action == "save") {
            dir.createDirectory();
            const auto json = params.getProperty("json", juce::var()).toString();
            if (json.isEmpty()) return fail("slMap/save: json missing");
            // ATOMIC: write a temporary and replace, so a crash mid-write
            // leaves the PREVIOUS map intact rather than a truncated one. A
            // half-written document is worse than no document — it looks
            // openable and refuses at the moment you need it.
            const auto tmp = file.getSiblingFile(safe + ".scoopyMap.tmp");
            if (!tmp.replaceWithText(json)) return fail("slMap/save: could not write");
            if (!tmp.moveFileTo(file)) {
                tmp.deleteFile();
                return fail("slMap/save: could not replace the existing map");
            }
            return ok(okFlag());
        }

        if (action == "open") {
            if (!file.existsAsFile()) return fail("slMap/open: no such map");
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("json", file.loadFileAsString());
            return ok(juce::var(o));
        }

        if (action == "delete") {
            // moveToTrash, never delete — same reasoning as a take: a mis-click
            // on a document that represents a night's work stays recoverable.
            return ok(okFlag(file.existsAsFile() && file.moveToTrash()));
        }

        // COLLECT-ON-EXPORT. The one step that makes a map self-contained for
        // travel: a saved map REFERENCES its takes by path, which is right on
        // the machine that recorded them and useless anywhere else.
        //
        // ⚠️ THE SPLIT THAT MAKES THIS POSSIBLE. TS decides WHAT — it hands over
        // the already-rewritten document and the list of files by path, because
        // it owns the format and the shell must never parse a document. The
        // shell moves BYTES. No audio crosses the bridge: a take is capped at
        // 256 MB, so base64 would be ~350 MB of string per take, which is not
        // slow but fatal.
        if (action == "export") {
            const auto json = params.getProperty("json", juce::var()).toString();
            if (json.isEmpty()) return fail("slMap/export: json missing");
            dir.createDirectory();
            const auto out = dir.getChildFile(safe + ".scoopyMapPkg");

            juce::ZipFile::Builder zip;
            // The document, from a temporary the builder can stream from.
            const auto docTmp = dir.getChildFile(safe + ".export.tmp");
            if (!docTmp.replaceWithText(json)) return fail("slMap/export: could not stage");
            zip.addFile(docTmp, 0, "map.scoopyMap"); // level 0 = STORED

            juce::Array<juce::var> missing;
            const auto* takes = params.getProperty("takes", juce::var()).getArray();
            if (takes != nullptr) {
                for (const auto& t : *takes) {
                    const juce::File src(t.getProperty("path", juce::var()).toString());
                    const auto entry = t.getProperty("entry", juce::var()).toString();
                    // A take that is gone is REPORTED, never silently skipped —
                    // and the export still succeeds, because an incomplete
                    // package beats none and the strip will say "audio missing"
                    // honestly on the other machine.
                    if (!src.existsAsFile() || entry.isEmpty()) {
                        missing.add(src.getFullPathName());
                        continue;
                    }
                    // STORED for the audio too: a take is WAV, which deflate
                    // barely shrinks, so compressing would spend real time to
                    // save almost nothing.
                    zip.addFile(src, 0, entry);
                }
            }

            bool wrote = false;
            {
                juce::FileOutputStream stream(out);
                if (stream.openedOk()) {
                    stream.setPosition(0);
                    stream.truncate();
                    double progress = 0.0;
                    wrote = zip.writeToStream(stream, &progress);
                }
            }
            docTmp.deleteFile();
            if (!wrote) {
                out.deleteFile();
                return fail("slMap/export: could not write the package");
            }

            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("path", out.getFullPathName());
            o->setProperty("missing", juce::var(missing));
            return ok(juce::var(o));
        }
        return fail("slMap: unknown action '" + action + "'");
    }

    // ── The library filesystem (P3-SES-1 — THE FLIP) ─────────────────────────
    //
    // The session/sample library, as native disk. OPFS is the BROWSER
    // companion's storage; the JUCE WKWebView host can LIST an OPFS library but
    // cannot WRITE one (measured — every "new session" was a zero-length
    // landmine), so the merged app's library lives here instead: the same move
    // slMap already made, one tier down. The web's `opfs.ts` routes to this
    // whole-hog when a JUCE backend exists, so sessions, samples and the file
    // browser flip together and the browser path stays byte-identical.
    //
    // The shell moves BYTES (base64 or text); it never parses a session.
    // Paths are OPFS-shaped ("/sessions/Untitled/pattern.json"), validated
    // segment-by-segment and CONTAINED under <takesDir>/../Library — the
    // web_resources traversal rule, applied to storage.
    if (method == "slFiles") {
        if (services == nullptr || services->takesDir.empty())
            return fail("slFiles: this host has no library directory");
        const juce::File libRoot = juce::File(services->takesDir).getParentDirectory()
                                       .getChildFile("Library");
        const auto action = params.getProperty("action", juce::var()).toString();
        const auto rawPath = params.getProperty("path", juce::var()).toString();

        // Resolve an OPFS-style path against the root, refusing anything that
        // could step outside it. Segment names are kept VERBATIM (a kit's
        // filePath must round-trip exactly), so containment is checks, not
        // renaming.
        //
        // TWO MOUNTS (P3-U7): "/takes/…" reads the take library — READ-ONLY,
        // because carve's invariant is that a grid track and a tape reference
        // the SAME take with no copy, so a kit sample's filePath must be able
        // to point straight at the WAV the recorder wrote. Everything else
        // lives under Library/ as before. Writes/removes under /takes are
        // refused: the take library has its own verbs (slTakes delete → Trash)
        // and a sample import must never be able to alter a take.
        juce::StringArray segs;
        segs.addTokens(rawPath, "/", "");
        segs.removeEmptyStrings();
        const bool inTakes = segs.size() > 0 && segs[0] == "takes";
        if (inTakes && (action == "write" || action == "remove" || action == "mkdirs"))
            return fail("slFiles: /takes is read-only (the take library has its own verbs)");
        const juce::File root =
            inTakes ? juce::File(services->takesDir) : libRoot;
        juce::File file = root;
        {
            for (int si = inTakes ? 1 : 0; si < segs.size(); ++si) {
                const auto& seg = segs[si];
                if (seg == "." || seg == ".." || seg.containsChar('\\') ||
                    seg.containsChar(':'))
                    return fail("slFiles: refused path segment '" + seg + "'");
                file = file.getChildFile(seg);
            }
            // Belt and braces: whatever the walk produced must still be inside.
            if (file != root && !file.isAChildOf(root))
                return fail("slFiles: path escapes the library");
        }

        if (action == "list") {
            if (!file.isDirectory()) return fail("slFiles/list: no such directory");
            juce::Array<juce::var> arr;
            for (const auto& e :
                 file.findChildFiles(juce::File::findFilesAndDirectories, false)) {
                auto* o = new juce::DynamicObject();
                o->setProperty("name", e.getFileName());
                o->setProperty("isDirectory", e.isDirectory());
                o->setProperty("sizeBytes",
                               e.isDirectory() ? 0.0 : static_cast<double>(e.getSize()));
                o->setProperty("modifiedMs",
                               static_cast<double>(
                                   e.getLastModificationTime().toMilliseconds()));
                arr.add(juce::var(o));
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("entries", juce::var(arr));
            return ok(juce::var(o));
        }

        if (action == "mkdirs")
            return ok(okFlag(file.createDirectory()));

        if (action == "exists") {
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("exists", file.exists());
            return ok(juce::var(o));
        }

        if (action == "read") {
            if (!file.existsAsFile()) return fail("slFiles/read: no such file");
            juce::MemoryBlock bytes;
            if (!file.loadFileAsData(bytes)) return fail("slFiles/read: could not read");
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("b64", juce::Base64::toBase64(bytes.getData(), bytes.getSize()));
            return ok(juce::var(o));
        }

        if (action == "write") {
            // ATOMIC, like slMap/save: stage a sibling and rename, so a crash
            // mid-write leaves the previous file rather than a truncated one —
            // the exact landmine class the OPFS store manufactured.
            juce::MemoryBlock bytes;
            const auto text = params.getProperty("text", juce::var());
            const auto b64 = params.getProperty("b64", juce::var());
            if (!text.isVoid()) {
                const juce::String s = text.toString(); // keep the String alive
                const auto utf8 = s.toUTF8();           // …while its bytes are copied
                bytes.append(utf8.getAddress(), utf8.sizeInBytes() - 1);
            } else if (!b64.isVoid()) {
                juce::MemoryOutputStream decoded(bytes, false);
                if (!juce::Base64::convertFromBase64(decoded, b64.toString()))
                    return fail("slFiles/write: bad base64");
            } else {
                return fail("slFiles/write: text or b64 required");
            }
            if (!file.getParentDirectory().createDirectory())
                return fail("slFiles/write: could not create the directory");
            const auto tmp = file.getSiblingFile(file.getFileName() + ".tmp");
            {
                juce::FileOutputStream out(tmp);
                if (!out.openedOk()) return fail("slFiles/write: could not stage");
                out.setPosition(0);
                out.truncate();
                if (!out.write(bytes.getData(), bytes.getSize())) {
                    tmp.deleteFile();
                    return fail("slFiles/write: could not write");
                }
            }
            // VERIFY before the rename — a short write must never replace a
            // good file, and the failure names the byte counts.
            if (static_cast<size_t>(tmp.getSize()) != bytes.getSize()) {
                const auto detail = juce::String(tmp.getSize()) + " of " +
                                    juce::String(static_cast<int64_t>(bytes.getSize())) +
                                    " bytes";
                tmp.deleteFile();
                return fail("slFiles/write: staged " + detail);
            }
            if (!tmp.moveFileTo(file)) {
                tmp.deleteFile();
                return fail("slFiles/write: could not replace the existing file");
            }
            return ok(okFlag());
        }

        if (action == "remove") {
            if (!file.exists()) return fail("slFiles/remove: no such entry");
            if (file == libRoot) return fail("slFiles/remove: refused the library root");
            // Trash first — a session directory is a night's work and a
            // mis-click must stay recoverable (the slMap/delete rule). Staged
            // temporaries and test scratch may live where trash is unavailable;
            // recursive delete is the honest fallback, reported if it too fails.
            const bool gone = file.moveToTrash() || file.deleteRecursively();
            return ok(okFlag(gone));
        }

        return fail("slFiles: unknown action '" + action + "'");
    }

    // ── The master output ────────────────────────────────────────────────────
    if (method == "slMaster") {
        if (engine == nullptr) return fail("slMaster: no engine on this host");
        const auto action = params.getProperty("action", juce::var()).toString();
        if (action == "setLevel") {
            sl_master_set_level(engine, numProp(params, "level", 1.0));
            return ok(okFlag());
        }
        return fail("slMaster: unknown action '" + action + "'");
    }

    // ── Grid decks ───────────────────────────────────────────────────────────
    // Only what the ABI has. Scene selection is deliberately absent: sl_deck_*
    // has no scene entry point, and a scene is a projection of the DOCUMENT, so
    // it travels inside the published world instead.
    if (method == "slDeck") {
        if (engine == nullptr) return fail("slDeck: no engine on this host");
        const auto action = params.getProperty("action", juce::var()).toString();
        const auto deck = static_cast<uint32_t>(intProp(params, "deck"));
        if (action == "setTempoSync") {
            sl_deck_set_tempo_sync(engine, deck, numProp(params, "ratio", 1.0));
            return ok(okFlag());
        }
        // The rest of the deck's TEMPO AXIS (SL-ABI-V3 §3). These take the
        // command path rather than the param lane because the plane sends them
        // as part of applying a map — an ordered sequence whose failures must be
        // visible — while the param lane is fire-and-forget for live drags. Both
        // reach the same `sl_param_set`; the difference is whether anyone is
        // listening for a refusal.
        //
        // A NAME THAT THE ENGINE DOES NOT KNOW IS A FAILED REPLY, not a shrug.
        // The engine ignores an unknown id by design (it must never misapply a
        // value), which means the only place a mismatch can be reported is here,
        // while the id is being resolved.
        {
            const char* paramName = action == "setTempoMode"   ? "tempoMode"
                                    : action == "setRate"      ? "rate"
                                    : action == "setTranspose" ? "transpose"
                                    : action == "setTexture"   ? "texture"
                                                               : nullptr;
            if (paramName != nullptr) {
                const int32_t id = sl_param_id_for_name(paramName);
                if (id == SL_PARAM_UNKNOWN)
                    return fail(juce::String("slDeck: engine has no param '") + paramName + "'");
                sl_param_set(engine, deck, id, numProp(params, "value", 0.0));
                // Read back, so a REFUSED value (an unknown tempo mode, a
                // non-positive rate) is visible to the caller instead of looking
                // like it landed. The engine refuses rather than clamps, and a
                // silent refusal is the same defect class as a dropped param.
                return ok([&] {
                    auto* o = new juce::DynamicObject();
                    o->setProperty("ok", true);
                    o->setProperty("value", sl_param_get(engine, deck, id));
                    return juce::var(o);
                }());
            }
        }
        if (action == "clear") {
            sl_deck_clear(engine, deck);
            return ok(okFlag());
        }
        // QUANTIZED LAUNCH (P11-3c) — the wire for the ABI P11-3b built. Without
        // this the engine's `requestQuantizedLaunch` was reachable from C and
        // unreachable from the app, which is the exact defect class this
        // project keeps paying for.
        //
        // The deck must already be published as active with its start step set
        // (the core's stated precondition); the engine half sets `launchArmed`
        // and republishes before requesting, so the caller here only has to
        // name the reference and the granularity.
        if (action == "requestQuantizedLaunch") {
            sl_deck_request_quantized_launch(
                engine, deck, static_cast<uint32_t>(intProp(params, "refDeck")),
                static_cast<uint16_t>(intProp(params, "quantizeSteps")));
            return ok(okFlag());
        }
        if (action == "cancelQuantizedLaunch") {
            sl_deck_cancel_quantized_launch(engine, deck);
            return ok(okFlag());
        }
        // HOW A CALLER KNOWS IT ACTUALLY CAME IN. The armed flag says the
        // request was accepted; this monotonic counter says the audio started.
        // A pending lamp cleared on the former reports success too early.
        if (action == "launchFired") {
            return ok([&] {
                auto* o = new juce::DynamicObject();
                o->setProperty("ok", true);
                o->setProperty("count", (int) sl_deck_launch_fired_count(engine, deck));
                return juce::var(o);
            }());
        }
        // SKIP-STEP — the deck transport verb with no other home. play/stop live
        // on the companion (it owns the pattern document), but a playhead jump is
        // the engine's: it has to land on a step boundary the render decides, and
        // nothing above the ABI can see that boundary. The donor groups it with
        // play/stop under `transportDeck` for the same reason it is one verb —
        // here the ownership split puts it beside the other engine deck ops.
        if (action == "skipStep") {
            sl_deck_skip_step(engine, deck,
                              static_cast<int64_t>(numProp(params, "step", -1.0)));
            return ok(okFlag());
        }
        return fail("slDeck: unknown action '" + action + "'");
    }

    // ── Device inputs, for the plane's source picker ─────────────────────────
    // Channel names are compacted to ACTIVE inputs, so index i here IS the
    // `srcIndex` a deviceInput route wants. One list, no second mapping.
    if (method == "slDevices") {
        if (services == nullptr || services->audio == nullptr)
            return fail("slDevices: this host has no device layer");
        auto& io = *services->audio;
        const auto action = params.getProperty("action", juce::var()).toString();
        auto toArray = [](const juce::StringArray& in) {
            juce::Array<juce::var> out;
            for (const auto& s : in) out.add(s);
            return juce::var(out);
        };
        if (action == "list") {
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("current", io.inputDeviceName());
            o->setProperty("devices", toArray(io.availableInputDevices()));
            o->setProperty("channels", toArray(io.activeInputChannelNames()));
            return ok(juce::var(o));
        }
        if (action == "setInput") {
            const auto name = params.getProperty("name", juce::var()).toString();
            if (name.isEmpty()) return fail("slDevices/setInput: name missing");
            // A device switch REBUILDS the device (D-WZ-RATE-01 stop→set→start)
            // but does NOT recreate the engine, so tapes, routes and channel
            // state all survive it — which is what makes changing your
            // interface mid-set safe rather than a reset.
            const auto err = io.setDevices(name, {}, sl_engine_sample_rate(engine));
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", err.isEmpty());
            o->setProperty("error", err.isEmpty() ? juce::var() : juce::var(err));
            o->setProperty("current", io.inputDeviceName());
            o->setProperty("channels", toArray(io.activeInputChannelNames()));
            return ok(juce::var(o));
        }
        return fail("slDevices: unknown action '" + action + "'");
    }

    // ── The grid, through the native engine ──────────────────────────────────
    // The counterpart of the plane's strip surface: a scoopy SESSION reaching
    // sl_engine, so a grid strip and a tape strip mix in ONE engine on ONE
    // clock. applyWorld is generic by design — it resolves each field by NAME
    // through the ABI and never learns what any of them mean — so this handler
    // stays a pass-through and no field mapping exists in C++ to drift.
    if (method == "slWorld") {
        if (engine == nullptr) return fail("slWorld: no engine on this host");
        const auto action = params.getProperty("action", juce::var()).toString();
        if (action == "registerSample") {
            // A rejected register is REPORTED: a world naming a sample the
            // engine never received renders silence, which looks exactly like a
            // broken engine rather than a missing file.
            return ok(okFlag(registerSample(engine, params)));
        }
        if (action == "publish") {
            const auto world = params.getProperty("world", juce::var());
            if (world.getDynamicObject() == nullptr)
                return fail("slWorld/publish: expected a flat `world` object");
            // applyWorld returns {applied, error} — merged into this method's
            // result rather than nested, so the caller reads one shape.
            const auto applied = applyWorld(engine, world);
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("applied", applied.getProperty("applied", false));
            o->setProperty("error", applied.getProperty("error", juce::var()));
            return ok(juce::var(o));
        }
        return fail("slWorld: unknown action '" + action + "'");
    }

    if (method == "slTakes") {
        if (services == nullptr) return fail("slTakes: this host has no take directory");
        const auto action = params.getProperty("action", juce::var()).toString();
        if (action == "list") {
            // Scanned from DISK rather than read out of the recorder, which
            // only knows what this process captured — the difference is every
            // take from every previous session.
            juce::Array<juce::var> arr;
            for (const auto& t : record::scanTakes(services->takesDir)) {
                auto* o = new juce::DynamicObject();
                o->setProperty("path", juce::String(t.wavPath));
                o->setProperty("sidecar", t.sidecarReadable
                                              ? juce::var(juce::String(t.sidecarJson))
                                              : juce::var());
                arr.add(juce::var(o));
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("ok", true);
            o->setProperty("takes", juce::var(arr));
            return ok(juce::var(o));
        }
        const auto path = params.getProperty("path", "").toString();
        if (action == "delete") {
            // Forget first: a take still recording is refused, and the list
            // must never point at a file that has just been moved away.
            const bool forgotten = services->recorder != nullptr
                                       ? services->recorder->forgetTake(path.toStdString())
                                       : true;
            bool trashed = false;
            if (forgotten) {
                const juce::File wav(path);
                const juce::File sidecar(path + ".json");
                // moveToTrash, never delete — a mis-click stays recoverable,
                // and a take is the one artifact of a performance that happened.
                trashed = wav.moveToTrash();
                if (sidecar.existsAsFile()) sidecar.moveToTrash();
            }
            return ok(okFlag(forgotten && trashed));
        }
        if (action == "reveal") {
            const juce::File f(path);
            const bool exists = f.existsAsFile();
            if (exists) f.revealToUser();
            return ok(okFlag(exists));
        }
        return fail("slTakes: unknown action '" + action + "'");
    }

    // ── Honest refusal ─────────────────────────────────────────────────────────
    // Everything else is not implemented on this host YET. Refusing (rather than
    // faking ok) is safe: scoopy's boot path catches command rejections, and a
    // fake success would make the UI believe in a feature that renders nothing.
    // Host-tier commands the UI actually needs arrive in later increments, each
    // wired to the device/engine tier it requires.
    return fail("slCommand: '" + method + "' is not implemented on this host yet");
}

juce::var toolbarState(sl_engine* engine, HostServices* services) {
    // ⚠️ This object must satisfy ToolbarUiState (schema.ts, `.strict()`) IN
    // FULL — zod refuses a partial, so a missing field here silently returns
    // the FxSlotPanel to WaitingForState. The only consumers of this topic in
    // the merged host are the FX 1–4 picker windows (deckmixer/djmode/transport
    // are retired doors), so: fxSlots is the truth, everything else is the
    // schema-required NEUTRAL, spelled out rather than fabricated from state
    // this host does not have.
    auto* obj = new juce::DynamicObject();

    auto boolArray = [](int n, bool v) {
        juce::Array<juce::var> a;
        for (int i = 0; i < n; ++i) a.add(v);
        return juce::var(a);
    };
    auto numArray = [](int n, double v) {
        juce::Array<juce::var> a;
        for (int i = 0; i < n; ++i) a.add(v);
        return juce::var(a);
    };

    obj->setProperty("masterIsPlaying", false);
    obj->setProperty("masterTempo", 120.0);
    obj->setProperty("deckPlaying", boolArray(3, false));
    obj->setProperty("deckQuantizePending", boolArray(3, false));
    obj->setProperty("deckVolume", numArray(3, 1.0));
    obj->setProperty("deckMuted", boolArray(3, false));
    obj->setProperty("deckSoloed", boolArray(3, false));
    obj->setProperty("sendSoloed", boolArray(4, false));
    obj->setProperty("returnVolume", numArray(2, 1.0));
    obj->setProperty("crossfaderEngaged", false);
    obj->setProperty("crossfaderPosition", 0.0);
    obj->setProperty("deckCEnabled", false);
    obj->setProperty("djModeEnabled", false);
    obj->setProperty("editingDeckIndex", juce::var());
    obj->setProperty("deckSections", juce::var(juce::Array<juce::var>()));

    // The truth this push exists for: per-return plugin name + latency, read
    // straight from the engine's slots. Loads are async — a slot mid-load reads
    // as empty and the next push (the shell re-sends at ~2 Hz) carries the name.
    juce::Array<juce::var> fxSlots;
    for (int i = 1; i <= 4; ++i) {
        auto* slot = new juce::DynamicObject();
        char name[256];
        const bool loaded = engine != nullptr
            && sl_fx_plugin_name(engine, i, name, sizeof(name)) > 0;
        slot->setProperty("mode", "host");
        slot->setProperty("pluginName", loaded ? juce::var(juce::String(juce::CharPointer_UTF8(name)))
                                               : juce::var());
        // THE WINDOW, not the last request (P6-4) — this push is how a UI learns
        // that the user closed the editor by its own close box, or that "show"
        // did nothing because the plugin has no editor of its own.
        slot->setProperty("editorVisible",
                          engine != nullptr && sl_fx_editor_visible(engine, i) != 0);
        // Whether the door should be offered at all: loaded AND has an editor.
        slot->setProperty("editorAvailable",
                          engine != nullptr && sl_fx_editor_available(engine, i) != 0);
        slot->setProperty("hostToHardware", false);
        slot->setProperty("postFader", false);
        slot->setProperty("latencyMs", engine != nullptr ? sl_fx_plugin_latency_ms(engine, i) : 0.0);
        slot->setProperty("sendMasterGain", 1.0);
        slot->setProperty("returnLevel", 1.0);
        slot->setProperty("muted", false);
        slot->setProperty("soloed", false);
        slot->setProperty("externalAvailable", false);
        slot->setProperty("channelLabel", juce::var());
        slot->setProperty("outputChannel", -1);
        fxSlots.add(juce::var(slot));
    }
    obj->setProperty("fxSlots", juce::var(fxSlots));

    {
        juce::Array<juce::var> outs;
        for (int i = 0; i < 3; ++i) outs.add(juce::var());
        obj->setProperty("deckOutputChannels", juce::var(outs));
    }
    obj->setProperty("outputPairs", juce::var(juce::Array<juce::var>()));
    {
        juce::Array<juce::var> perDeck;
        for (int d = 0; d < 3; ++d) perDeck.add(numArray(4, 0.0));
        obj->setProperty("deckMasterSend", juce::var(perDeck));
    }
    {
        auto* mic = new juce::DynamicObject();
        mic->setProperty("enabled", false);
        mic->setProperty("gain", 1.0);
        mic->setProperty("monitorOn", false);
        mic->setProperty("muted", false);
        mic->setProperty("send1", 0.0);
        mic->setProperty("send2", 0.0);
        mic->setProperty("send3", 0.0);
        mic->setProperty("send4", 0.0);
        mic->setProperty("inputStartChannel", 0);
        mic->setProperty("inputIsStereo", false);
        obj->setProperty("mic", juce::var(mic));
    }
    obj->setProperty("inputChannelCount", 0);
    {
        auto* kb = new juce::DynamicObject();
        kb->setProperty("enabled", false);
        kb->setProperty("octaveOffset", 0);
        kb->setProperty("velocity", 100);
        obj->setProperty("musicalKeyboard", juce::var(kb));
    }
    obj->setProperty("midiPin", juce::var());

    (void) services; // reserved: later increments may read device state here
    return juce::var(obj);
}

} // namespace wizard::sl
