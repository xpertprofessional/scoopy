#include "SlDispatch.h"

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

} // namespace

juce::var capabilities() {
    auto* obj = new juce::DynamicObject();
    // ⚠️ Must equal scoopy web/protocol/schema.ts SCHEMA_VERSION. A mismatch is
    // not silent — scoopy's debug panel renders "SCHEMA MISMATCH" — which is the
    // runtime backstop for a coupling the C++/TS split cannot check at build
    // time. A future codegen step could emit this from schema.ts; until then it
    // is a loud constant, deliberately not buried.
    obj->setProperty("schemaVersion", 86);
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

juce::var dispatch(const juce::String& method, const juce::var& params, SettingsStore& settings) {
    if (method == "getCapabilities")
        return ok(capabilities());

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

    // ── Honest refusal ─────────────────────────────────────────────────────────
    // Everything else is not implemented on this host YET. Refusing (rather than
    // faking ok) is safe: scoopy's boot path catches command rejections, and a
    // fake success would make the UI believe in a feature that renders nothing.
    // Host-tier commands the UI actually needs arrive in later increments, each
    // wired to the device/engine tier it requires.
    return fail("slCommand: '" + method + "' is not implemented on this host yet");
}

} // namespace wizard::sl
