#include "SlDispatch.h"

#include "AudioIO.h"
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

juce::var capabilities() {
    auto* obj = new juce::DynamicObject();
    // ⚠️ Must equal scoopy web/protocol/schema.ts SCHEMA_VERSION. A mismatch is
    // not silent — scoopy's debug panel renders "SCHEMA MISMATCH" — which is the
    // runtime backstop for a coupling the C++/TS split cannot check at build
    // time. A future codegen step could emit this from schema.ts; until then it
    // is a loud constant, deliberately not buried.
    obj->setProperty("schemaVersion", 88);
    // The merged host = wizard's JUCE shell hosting scoopy's UI. Each flag is
    // what that host can ACTUALLY do today, not what it aspires to — scoopy's UI
    // renders native-only surfaces inert from these, so an optimistic `true`
    // here shows a control that then does nothing.
    obj->setProperty("pluginHosting", false);      // P6, not built
    obj->setProperty("fileSystem", true);          // the shell owns native dialogs
    obj->setProperty("midiHardware", false);       // not built
    obj->setProperty("audioDeviceSelection", true);// wizard's AudioIO enumerates/selects
    // returnFx false = the send/return section is absent and the render is dry,
    // rather than a wrong-sounding echo feeding the returns' C++ defaults (the
    // honest shape the schema comment prescribes for a host without it).
    obj->setProperty("returnFx", false);
    return juce::var(obj);
}

juce::var dispatch(const juce::String& method, const juce::var& params,
                   SettingsStore& settings, sl_engine* engine,
                   HostServices* services) {
    if (method == "getCapabilities")
        return ok(capabilities());

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
        if (action == "scrubBegin") { sl_tape_scrub_begin(engine, tape); return ok(okFlag()); }
        if (action == "scrubTo") {
            sl_tape_scrub_to(engine, tape, numProp(params, "frame"));
            return ok(okFlag());
        }
        if (action == "scrubEnd") { sl_tape_scrub_end(engine, tape); return ok(okFlag()); }
        if (action == "overdubStart") {
            sl_tape_overdub_start(engine, tape, static_cast<uint32_t>(intProp(params, "mode")));
            return ok(okFlag());
        }
        if (action == "overdubStop") { sl_tape_overdub_stop(engine, tape); return ok(okFlag()); }
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
            const bool opened = recorder.beginTake(
                tape, c1 >= 0 ? 2u : 1u, sl_engine_sample_rate(engine),
                0 /* the engine stamps the true start; applied at endTake */,
                params.getProperty("sourceDesc", "").toString().toStdString());
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
        if (action == "clear") {
            sl_deck_clear(engine, deck);
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

} // namespace wizard::sl
