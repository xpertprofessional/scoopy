// THE MAP CAN REMEMBER A PLUGIN (P6-5a) — proven with a REAL AudioUnit.
//
// The user's sentence made literal: "just needs to be fitted into the map system
// so we can also restore these settings (like a plugin loaded) within a map."
// This is the engine/wire half of it, and it is the half that can be proven
// headlessly: what a document must WRITE DOWN (the identifier a plugin can be
// found by again, plus the plugin's own opaque state) and that feeding those back
// reconstitutes the same plugin. The document half — the `.scoopyMap` field, the
// save/restore path and the missing-plugin refusal — is P6-5b.
//
// WHY A SEPARATE BINARY FROM plugin_audible_test: that one proves sound, this one
// proves memory. Sharing a main() would mean one failure could no longer say
// which of the two claims broke.
//
// ⚠️ THE ASSERTION THAT MATTERS IS THE SECOND LOAD, and it is deliberately not
// "the call returned 1". A restore that accepted the blob and silently dropped it
// would pass that. So this drives the round trip through the DISPATCHER — the
// exact JSON the map layer will send — and asserts the plugin comes back with the
// SAME state bytes it had when the map was saved.
//
// Skips (exit 77, ctest SKIP_RETURN_CODE) when Apple's AUDelay is absent — the
// honest shape for a CI box without Apple's AUs; a dev Mac always has them.
#include "SlDispatch.h"
#include "NativePluginHost.hpp"
#include "sl_engine.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <cstdio>
#include <map>
#include <string>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
using namespace wizard::sl;

class FakeSettings final : public SettingsStore {
public:
    juce::var get(const juce::String& key) const override {
        auto it = map.find(key);
        return it == map.end() ? juce::var() : it->second;
    }
    void set(const juce::String& key, const juce::var& value) override { map[key] = value; }
    bool has(const juce::String& key) const override { return map.count(key) != 0; }
    std::map<juce::String, juce::var> map;
};

bool replyOk(const juce::var& r) { return r.getProperty("ok", false); }
juce::var result(const juce::var& r) { return r.getProperty("result", juce::var()); }

constexpr uint32_t kQ = 256;
constexpr double kRate = 48000.0;

/** Pump the message loop until `slot` reports a loaded plugin, or we give up.
    Loads are async on the JUCE message thread by design (a plugin instantiation
    is not safe anywhere else), so a test that read straight back would be
    measuring the race, not the feature. */
bool waitForName(sl_engine* e, int returnIndex, bool wantLoaded) {
    for (int i = 0; i < 200; ++i) {
        juce::MessageManager::getInstance()->runDispatchLoopUntil(25);
        const bool loaded = sl_fx_plugin_name(e, returnIndex, nullptr, 0) > 0;
        if (loaded == wantLoaded) return true;
    }
    return false;
}

/** The ABI's size-then-fill contract, exercised the way a caller must use it. */
std::string pull(uint32_t (*fn)(const sl_engine*, int, char*, uint32_t),
                 sl_engine* e, int returnIndex) {
    const uint32_t len = fn(e, returnIndex, nullptr, 0);
    if (len == 0) return {};
    std::vector<char> buf(len + 1, '\0');
    fn(e, returnIndex, buf.data(), len + 1);
    return std::string(buf.data());
}
} // namespace

int main() {
    juce::ScopedJuceInitialiser_GUI juceInit;

    juce::AudioPluginFormatManager fm;
    juce::addDefaultFormatsToManager(fm);
    juce::AudioPluginFormat* au = nullptr;
    for (int i = 0; i < fm.getNumFormats(); ++i)
        if (fm.getFormat(i)->getName() == "AudioUnit") au = fm.getFormat(i);
    if (au == nullptr) { std::printf("SKIP: no AudioUnit format in this build\n"); return 77; }

    juce::OwnedArray<juce::PluginDescription> found;
    au->findAllTypesForFile(found, "AudioUnit:Effects/aufx,dely,appl");
    if (found.isEmpty()) { std::printf("SKIP: Apple AUDelay not present\n"); return 77; }
    const juce::String identifier = found[0]->createIdentifierString();

    scoopyloops::NativePluginScanner scanner;
    {
        juce::KnownPluginList kl;
        kl.addType(*found[0]);
        scanner.restoreFromXml(kl.createXml()->toString().toStdString());
    }

    FakeSettings settings;
    HostServices services;
    services.pluginScanner = &scanner;

    sl_engine* e = sl_engine_create(kRate, kQ, 95);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    auto cmd = [&](const char* method, const juce::String& json) {
        return dispatch(method, juce::JSON::parse(json), settings, e, &services);
    };

    // ── 1. AN EMPTY SLOT SAYS SO ─────────────────────────────────────────────
    // Explicit nulls, not absent keys: the document records "nothing here" as a
    // fact, and zod's .nullable() demands the key exist either way.
    {
        const auto snap = cmd("getFxSlotState", "{}");
        CHECK(replyOk(snap));
        const auto* slots = result(snap).getProperty("slots", juce::var()).getArray();
        CHECK(slots != nullptr && slots->size() == 4);
        for (int i = 0; i < 4; ++i) {
            CHECK((*slots)[i].hasProperty("identifier"));
            CHECK((*slots)[i].hasProperty("state"));
            CHECK((*slots)[i].getProperty("identifier", "x").isVoid());
            CHECK((int) (*slots)[i].getProperty("returnIndex", -1) == i + 1);
        }
        // And the ABI agrees at the boundary.
        CHECK(sl_fx_plugin_identifier(e, 1, nullptr, 0) == 0);
        CHECK(sl_fx_plugin_state(e, 1, nullptr, 0) == 0);
    }

    // ── 2. LOAD A REAL PLUGIN, THEN READ WHAT A MAP WOULD SAVE ───────────────
    // `cmd` parses, so it takes the JSON TEXT — handing it an already-parsed var
    // would stringify and re-parse into nonsense.
    CHECK(replyOk(cmd("selectFxPlugin",
        R"({"returnIndex":1,"identifier":")" + identifier + "\"}")));
    CHECK(waitForName(e, 1, /*wantLoaded*/ true));

    const std::string savedId = pull(&sl_fx_plugin_identifier, e, 1);
    const std::string savedState = pull(&sl_fx_plugin_state, e, 1);
    // THE IDENTIFIER IS THE PERSISTENCE KEY, not the display name — a document
    // keyed on the name would reload a different plugin on a machine with two.
    CHECK(!savedId.empty());
    CHECK(savedId == identifier.toStdString());
    const std::string shownName = pull(&sl_fx_plugin_name, e, 1);
    CHECK(!shownName.empty());
    // They are genuinely different strings; if they were equal this test would
    // pass while proving nothing about which one was stored.
    CHECK(savedId != shownName);

    // The truncation contract, exercised: the return value is the FULL length
    // whatever the buffer, which is what makes size-then-fill safe. Getting this
    // wrong persists a clipped blob that the plugin rejects on restore.
    {
        char tiny[4] = {'x', 'x', 'x', 'x'};
        const uint32_t full = sl_fx_plugin_identifier(e, 1, tiny, sizeof(tiny));
        CHECK(full == savedId.size());
        CHECK(full > sizeof(tiny));       // genuinely truncated…
        CHECK(tiny[sizeof(tiny) - 1] == '\0'); // …and still NUL-terminated
    }

    // The dispatcher's snapshot carries the same two values.
    {
        const auto snap = cmd("getFxSlotState", "{}");
        CHECK(replyOk(snap));
        const auto* slots = result(snap).getProperty("slots", juce::var()).getArray();
        CHECK(slots != nullptr);
        const auto s1 = (*slots)[0];
        CHECK(s1.getProperty("identifier", "").toString().toStdString() == savedId);
        // AUDelay may legitimately save nothing; when it does save, the wire
        // must carry exactly what the ABI reported.
        if (!savedState.empty())
            CHECK(s1.getProperty("state", "").toString().toStdString() == savedState);
        else
            CHECK(s1.getProperty("state", "x").isVoid());
    }

    // ── 3. DROP IT — the "reopened app" state ────────────────────────────────
    CHECK(replyOk(cmd("selectFxPlugin", R"({"returnIndex":1,"identifier":null})")));
    CHECK(waitForName(e, 1, /*wantLoaded*/ false));
    CHECK(sl_fx_plugin_identifier(e, 1, nullptr, 0) == 0);

    // ── 4. RESTORE FROM WHAT THE MAP WROTE DOWN ──────────────────────────────
    // Through the DISPATCHER, with the exact JSON the map layer will send — a
    // test that called the C function directly would not cover the wire shape
    // the document actually uses.
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("returnIndex", 1);
        p->setProperty("identifier", juce::String(savedId));
        if (!savedState.empty()) p->setProperty("state", juce::String(savedState));
        CHECK(replyOk(dispatch("selectFxPlugin", juce::var(p), settings, e, &services)));
    }
    CHECK(waitForName(e, 1, /*wantLoaded*/ true));

    // The same plugin is back…
    CHECK(pull(&sl_fx_plugin_identifier, e, 1) == savedId);
    // …and it came back with the state the map was holding. THIS is the row's
    // claim: not "the call was accepted" (a restore that dropped the blob would
    // pass that) but "the settings survived the round trip".
    if (!savedState.empty()) CHECK(pull(&sl_fx_plugin_state, e, 1) == savedState);

    // ── 5. A CORRUPT BLOB LOADS AT DEFAULTS RATHER THAN FAILING ──────────────
    // The signed shape of this trade: a map that remembers wrong is a bad
    // afternoon; a map that refuses to open is a lost set. So garbage in the
    // state field must still leave a WORKING plugin on the return.
    CHECK(replyOk(cmd("selectFxPlugin", R"({"returnIndex":1,"identifier":null})")));
    CHECK(waitForName(e, 1, /*wantLoaded*/ false));
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("returnIndex", 1);
        p->setProperty("identifier", juce::String(savedId));
        p->setProperty("state", "!!! not base64 at all !!!");
        CHECK(replyOk(dispatch("selectFxPlugin", juce::var(p), settings, e, &services)));
    }
    CHECK(waitForName(e, 1, /*wantLoaded*/ true));
    CHECK(pull(&sl_fx_plugin_identifier, e, 1) == savedId);

    // ── 6. AN UNKNOWN IDENTIFIER LEAVES THE SLOT EMPTY, NOT WRONG ────────────
    // The missing-plugin case at this tier: the scanner cannot resolve it, so
    // nothing loads. Reporting that to a person is P6-5b's job (it needs the
    // scanned list to say "this machine does not have it"); what matters HERE is
    // that the slot does not end up holding some other plugin.
    CHECK(replyOk(cmd("selectFxPlugin", R"({"returnIndex":1,"identifier":null})")));
    CHECK(waitForName(e, 1, /*wantLoaded*/ false));
    CHECK(replyOk(cmd("selectFxPlugin",
        R"({"returnIndex":1,"identifier":"AudioUnit:Effects/aufx,zzzz,zzzz"})")));
    for (int i = 0; i < 20; ++i)
        juce::MessageManager::getInstance()->runDispatchLoopUntil(25);
    CHECK(sl_fx_plugin_identifier(e, 1, nullptr, 0) == 0);
    CHECK(sl_fx_plugin_name(e, 1, nullptr, 0) == 0);

    sl_fx_teardown(e);
    sl_engine_destroy(e);
    // SELF-REPORTING, in the sl_world_apply_test style: the state round-trip is
    // this file's strongest assertion and it is conditional on the plugin saving
    // anything at all, so the run says which it got. A line reading "state 0 B"
    // means §4 proved identifier-only restore and nothing about settings — worth
    // seeing rather than inferring from a bare OK.
    std::printf("plugin_state_test OK (identifier %zu B, state %zu B)\n",
                savedId.size(), savedState.size());
    return 0;
}
