// scoopy's slCommand boot handshake, tested headlessly (no WebView, no display).
//
// Proves the merged shell answers the commands scoopy's UI issues at boot with
// the shared reply envelope, backs settings with real persistence, and refuses
// the not-yet-implemented rest honestly rather than faking success.
#include "SlDispatch.h"
#include "SlWorldApply.h"
#include "NativePluginHost.hpp"
#include "sl_engine.h"

#include <cstdio>
#include <cmath>
#include <map>
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

/** In-memory store — proves the dispatcher persists without a file. */
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
/** A refusal's MESSAGE. Asserted on (not just `!ok`) wherever the point of the
    refusal is that it says which thing it refused — a caller can only act on a
    named reason, and P3-U6 puts these on the plane's note line verbatim. */
juce::String errorOf(const juce::var& r) { return r.getProperty("error", juce::var()).toString(); }
} // namespace

int main(int argc, char* argv[]) {
    // Debug door: `sl_dispatch_test --dump-toolbar` prints the toolbar push as
    // JSON and exits, so the TS side can prove the C++ shape against the REAL
    // zod schema (node -e "...ToolbarUiState.parse(...)"). Not part of the
    // ctest run — a hand tool for exactly the drift the key-set pins guard.
    if (argc > 1 && juce::String(argv[1]) == "--dump-toolbar") {
        wizard::sl::HostServices services;
        sl_engine* e = sl_engine_create(48000.0, 512, 96);
        std::printf("%s\n", juce::JSON::toString(wizard::sl::toolbarState(e, &services))
                                .toRawUTF8());
        sl_engine_destroy(e);
        return 0;
    }
    FakeSettings settings;

    // getCapabilities — the handshake. schemaVersion must equal schema.ts's
    // SCHEMA_VERSION, or the UI shows a mismatch banner.
    //
    // ⚠️ THIS PIN SAID **92** WHILE schema.ts SAID 96, so the test DEFENDED the
    // drift: the assertion agreed with the stale constant and went green for
    // four bumps. That is why `npm run schema:check` now gates this literal too
    // — a hand-written number in a test is a fourth place to drift, not a check. The host's real capabilities, not
    // aspirational ones.
    {
        const auto r = dispatch("getCapabilities", juce::var(), settings, nullptr);
        CHECK(replyOk(r));
        const auto caps = result(r);
        CHECK((int) caps.getProperty("schemaVersion", 0) == 106); // scoopy SCHEMA_VERSION
        CHECK((bool) caps.getProperty("fileSystem", false) == true);
        CHECK((bool) caps.getProperty("audioDeviceSelection", false) == true);
        CHECK((bool) caps.getProperty("pluginHosting", true) == false);
        CHECK((bool) caps.getProperty("midiHardware", true) == false);
        CHECK((bool) caps.getProperty("returnFx", true) == false);
        // The exported helper agrees with the dispatched answer.
        CHECK((int) capabilities().getProperty("schemaVersion", 0) == 106);
    }

    // An unset key reads as null (value present, null) — NOT absent, NOT a
    // fabricated default. The UI needs "unset" to be distinguishable.
    {
        const auto r = dispatch("getSetting",
            juce::JSON::parse(R"({"key":"theme.tokens"})"), settings, nullptr);
        CHECK(replyOk(r));
        CHECK(result(r).hasProperty("value"));
        CHECK(result(r).getProperty("value", "x").isVoid()); // null on the wire
    }

    // setSetting persists; getSetting reads it back verbatim, structure intact.
    {
        const auto set = dispatch("setSetting",
            juce::JSON::parse(R"({"key":"deck.volume","value":0.8})"), settings, nullptr);
        CHECK(replyOk(set));
        const auto got = dispatch("getSetting",
            juce::JSON::parse(R"({"key":"deck.volume"})"), settings, nullptr);
        CHECK(replyOk(got));
        CHECK((double) result(got).getProperty("value", 0.0) == 0.8);

        // An object value survives round-trip (theme tokens are objects).
        dispatch("setSetting",
            juce::JSON::parse(R"({"key":"theme.tokens","value":{"accent":"#abc","n":3}})"), settings, nullptr);
        const auto obj = result(dispatch("getSetting",
            juce::JSON::parse(R"({"key":"theme.tokens"})"), settings, nullptr)).getProperty("value", juce::var());
        CHECK(obj.getProperty("accent", "").toString() == "#abc");
        CHECK((int) obj.getProperty("n", 0) == 3);
    }

    // An explicit null value is a CLEAR, distinct from an absent key in the
    // payload — getProperty's default must not paper over the difference.
    {
        dispatch("setSetting", juce::JSON::parse(R"({"key":"k","value":5})"), settings, nullptr);
        CHECK(settings.has("k"));
        dispatch("setSetting", juce::JSON::parse(R"({"key":"k","value":null})"), settings, nullptr);
        CHECK(settings.has("k")); // still set, now to null
        CHECK(settings.get("k").isVoid());
    }

    // getSettings returns only keys that exist — a missing key is omitted, not
    // echoed as null, so the UI keeps "unset" meaning unset.
    {
        settings.set("a", 1);
        settings.set("b", juce::var("two"));
        const auto r = dispatch("getSettings",
            juce::JSON::parse(R"({"keys":["a","b","missing"]})"), settings, nullptr);
        CHECK(replyOk(r));
        const auto values = result(r).getProperty("values", juce::var());
        CHECK((int) values.getProperty("a", 0) == 1);
        CHECK(values.getProperty("b", "").toString() == "two");
        CHECK(!values.hasProperty("missing"));
    }

    // getUiState is a safe empty default (state arrives via the push lane).
    {
        const auto r = dispatch("getUiState",
            juce::JSON::parse(R"({"topic":"background"})"), settings, nullptr);
        CHECK(replyOk(r));
        CHECK(result(r).getDynamicObject() != nullptr); // an object, empty
    }

    // Malformed params are refused, not crashed.
    CHECK(!replyOk(dispatch("getSetting", juce::var(), settings, nullptr)));       // no key
    CHECK(!replyOk(dispatch("setSetting", juce::JSON::parse(R"({"value":1})"), settings, nullptr))); // no key
    CHECK(!replyOk(dispatch("getSettings", juce::JSON::parse(R"({"keys":"x"})"), settings, nullptr))); // keys not array

    // The not-yet-implemented surface refuses honestly — ok:false with a reason
    // naming the method — rather than faking success (which scoopy's UI would
    // believe). A representative sample the boot path touches.
    for (const char* m : {"worldPublish", "gridEdit", "publishMenuTree",
                          "enumerateAudioDevices", "listPlugins", "fileBrowser"}) {
        const auto r = dispatch(m, juce::var(), settings, nullptr);
        CHECK(!replyOk(r));
        CHECK(r.getProperty("error", "").toString().contains(m));
    }

    // OUTPUT ROUTING (S5). With no audio device the two CHANNEL commands refuse
    // BY NAME rather
    // than pretending to route — the shape this whole command family was stuck
    // in for months, declared in schema.ts and answered by nobody, where a
    // caller could not tell "routed" from "silently ignored".
    for (const char* m : {"setDeckOutputChannels", "setSendOutputChannel"}) {
        const auto r = dispatch(m, juce::var(), settings, nullptr);
        CHECK(!replyOk(r));
        CHECK(r.getProperty("error", "").toString().contains(m));
    }

    // worldPublish ROUTING (the applier itself is covered by sl_world_apply_test).
    // With a real engine, a flat `world` object routes through and applies; the
    // Option-B contract is enforced — a stock PatternFile `json` string, which
    // this host does not parse, is refused with a reason.
    // PER-TRACK OUTPUT ROUTING reaches the ENGINE (S5). It refused by name for
    // one commit, which is how the gap was found: every other piece of
    // output-1/2 mode already existed — the world map, SL_T_OUTPUT_ASSIGN, the
    // pattern file, the projection, worldFromSession and the track row's own
    // control — and the core had carried `setPerTrackRoutingActive` with
    // nothing able to call it. This asserts the answer, not a refusal.
    //
    // It needs an ENGINE but no audio device, unlike its two siblings: the
    // switch is engine state, while a channel assignment is a device fact.
    {
        sl_engine* e = sl_engine_create(48000.0, 512, 86);
        CHECK(e != nullptr);
        for (const char* on : {"true", "false"}) {
            const auto r = dispatch("setPerTrackOutputRouting",
                                    juce::JSON::parse(juce::String("{\"enabled\":") + on +
                                                      ",\"deviceUid\":\"dev\"}"),
                                    settings, e);
            CHECK(replyOk(r));
        }
        sl_engine_destroy(e);
    }

    {
        sl_engine* e = sl_engine_create(48000.0, 512, 86);
        CHECK(e != nullptr);
        std::vector<float> tone(4800);
        for (size_t i = 0; i < tone.size(); ++i)
            tone[i] = 0.4f * std::sin(2.0 * 3.14159265358979 * 220.0 * (double) i / 48000.0);
        auto* left = new juce::Array<juce::var>();
        for (float v : tone) left->add((double) v);
        auto* s = new juce::DynamicObject();
        s->setProperty("id", "tone");
        s->setProperty("left", juce::var(*left));
        CHECK(registerSample(e, juce::var(s)));
        delete left;

        auto world = juce::JSON::parse(R"({"world":{"deck":0,"bpm":120,"isPlaying":true,
            "startStep":0,"tracks":[{"sampleId":"tone","steps":[1,1,1,1],"volume":1.0}]}})");
        const auto r = dispatch("worldPublish", world, settings, e);
        CHECK(replyOk(r));
        CHECK((bool) result(r).getProperty("applied", false));

        // Contract: a PatternFile string (stock scoopy shape) is refused here.
        const auto stock = dispatch("worldPublish",
            juce::JSON::parse(R"({"json":"<PatternFile>"})"), settings, e);
        CHECK(!replyOk(stock));

        sl_engine_destroy(e);
    }

    // ── The plane's strip surface (merge P2 step 4) ──────────────────────────
    {
        sl_engine* e = sl_engine_create(48000.0, 512, 87);
        CHECK(e != nullptr);

        // WITHOUT AN ENGINE, every engine-backed plane command refuses by name
        // rather than crashing on a null. The UI's boot path catches refusals;
        // a segfault is not something it can catch.
        for (const char* m : {"slChannel", "slTape", "slRoute", "slRouteList", "slRecord"}) {
            const auto r = dispatch(m, juce::var(), settings, nullptr);
            CHECK(!replyOk(r));
            CHECK(r.getProperty("error", "").toString().contains(m));
        }

        // An unknown action is refused rather than silently doing nothing. One
        // zod object serves every action, so this combination check exists ONLY
        // here — a typo'd action that returned ok would be a control that looks
        // wired and is not.
        CHECK(!replyOk(dispatch("slChannel",
                                juce::JSON::parse(R"({"action":"nope","channel":0})"),
                                settings, e)));
        CHECK(!replyOk(dispatch("slTape", juce::JSON::parse(R"({"action":"nope","tape":0})"),
                                settings, e)));
        CHECK(!replyOk(dispatch("slRoute", juce::JSON::parse(R"({"action":"nope"})"),
                                settings, e)));

        // ── The deck's tempo axis (SL-ABI-V3 §3) ────────────────────────────
        //
        // The param actions REPORT THE ENGINE'S READ-BACK, and that is the whole
        // point of them replying with a value. The engine refuses a value it
        // cannot honour rather than clamping it, so `ok: true` alone would say
        // nothing about whether the write landed — a tempo mode the engine does
        // not have would look applied and the deck would keep stretching.
        {
            auto deckParam = [&](const char* json) {
                return dispatch("slDeck", juce::JSON::parse(json), settings, e);
            };
            const auto mode = deckParam(R"({"action":"setTempoMode","deck":0,"value":2})");
            CHECK(replyOk(mode));
            CHECK((double) result(mode).getProperty("value", -1.0) == 2.0);

            // A mode the engine does not have: the reply is OK (the command was
            // understood) and the VALUE is unchanged (the write was refused).
            const auto badMode = deckParam(R"({"action":"setTempoMode","deck":0,"value":9})");
            CHECK(replyOk(badMode));
            CHECK((double) result(badMode).getProperty("value", -1.0) == 2.0);

            const auto rate = deckParam(R"({"action":"setRate","deck":0,"value":1.5})");
            CHECK((double) result(rate).getProperty("value", -1.0) == 1.5);
            const auto badRate = deckParam(R"({"action":"setRate","deck":0,"value":0})");
            CHECK((double) result(badRate).getProperty("value", -1.0) == 1.5);

            // Transpose accepts negatives — it is semitones, not a ratio. The
            // param that most obviously must NOT share the ratio's positive-only
            // guard, which is why the engine keys them separately.
            const auto trans = deckParam(R"({"action":"setTranspose","deck":0,"value":-7})");
            CHECK((double) result(trans).getProperty("value", 0.0) == -7.0);

            // TEXTURE (the donor's WIN) reaches the engine through the same
            // read-back path, and its refusal is visible for the same reason:
            // it is BOUNDED [0,1], so an out-of-range write is refused whole and
            // the reply proves the old value still stands.
            const auto tex = deckParam(R"({"action":"setTexture","deck":0,"value":0.4})");
            CHECK(replyOk(tex));
            CHECK((double) result(tex).getProperty("value", -1.0) == 0.4);
            const auto badTex = deckParam(R"({"action":"setTexture","deck":0,"value":3})");
            CHECK((double) result(badTex).getProperty("value", -1.0) == 0.4);

            // SKIP-STEP is a request, not a param: it replies with the plain ok
            // flag because there is nothing to read back — the jump is applied
            // at the next step boundary inside render(). A missing or negative
            // step is refused by the engine, and the command still answers ok
            // (it was understood); what must NOT happen is a dispatch failure or
            // a corrupted deck.
            CHECK(replyOk(deckParam(R"({"action":"skipStep","deck":0,"step":16})")));
            CHECK(replyOk(deckParam(R"({"action":"skipStep","deck":0,"step":-4})")));
            CHECK(replyOk(deckParam(R"({"action":"skipStep","deck":0})")));

            // QUANTIZED LAUNCH (P11-3c) — the wire. Before this the engine's
            // requestQuantizedLaunch was reachable from C and unreachable from
            // the app; a route that answers is the whole row.
            CHECK(replyOk(deckParam(
                R"({"action":"requestQuantizedLaunch","deck":1,"refDeck":0,"quantizeSteps":16})")));
            // The engine's own refusals ride underneath (zero quantum, a deck
            // waiting on itself); the COMMAND is still understood, so it answers
            // ok — the same shape setTempoMode uses for a refused value.
            CHECK(replyOk(deckParam(
                R"({"action":"requestQuantizedLaunch","deck":1,"refDeck":1,"quantizeSteps":16})")));
            CHECK(replyOk(deckParam(
                R"({"action":"requestQuantizedLaunch","deck":1,"refDeck":0,"quantizeSteps":0})")));
            CHECK(replyOk(deckParam(R"({"action":"cancelQuantizedLaunch","deck":1})")));
            // Cancelling nothing is safe — a UI that disarms on every stop must
            // not have to know whether anything was armed.
            CHECK(replyOk(deckParam(R"({"action":"cancelQuantizedLaunch","deck":1})")));

            // THE FIRED COUNTER, which is how a pending lamp clears honestly:
            // the armed flag says the request was accepted, this says the audio
            // started. Nothing has fired here, so it reads 0 rather than absent.
            const auto fired = deckParam(R"({"action":"launchFired","deck":1})");
            CHECK(replyOk(fired));
            CHECK((int) result(fired).getProperty("count", -1) == 0);

            CHECK(!replyOk(deckParam(R"({"action":"nope","deck":0})")));
            CHECK(!replyOk(dispatch("slDeck", juce::var(), settings, nullptr)));
            sl_deck_clear(e, 0); // leave the ground as it was found
        }

        // A channel binding REPORTS the engine's refusal instead of assuming
        // success: kind 9 does not exist, and a strip silently bound to nothing
        // would render silence with no explanation anywhere in the UI.
        const auto bad = dispatch("slChannel",
                                  juce::JSON::parse(R"({"action":"setSource","channel":0,"kind":9,"index":0})"),
                                  settings, e);
        CHECK(replyOk(bad));
        CHECK(!(bool) result(bad).getProperty("ok", true));

        const auto good = dispatch("slChannel",
                                   juce::JSON::parse(R"({"action":"setSource","channel":0,"kind":1,"index":0})"),
                                   settings, e);
        CHECK((bool) result(good).getProperty("ok", false));
        CHECK(sl_channel_source_kind(e, 0) == 1);

        // Level and mute reach the engine.
        dispatch("slChannel", juce::JSON::parse(R"({"action":"setLevel","channel":0,"level":0.25})"),
                 settings, e);
        CHECK(sl_channel_level(e, 0) == 0.25);
        dispatch("slChannel", juce::JSON::parse(R"({"action":"setMute","channel":0,"muted":true})"),
                 settings, e);
        CHECK(sl_channel_muted(e, 0) == 1);
        dispatch("slChannel", juce::JSON::parse(R"({"action":"setSend","channel":0,"send":2,"level":0.5})"),
                 settings, e);
        CHECK(sl_channel_send(e, 0, 2) == 0.5);

        // slRouteList reports one entry PER SLOT (active or not), which is the
        // shape captureRoutes() consumes, plus the render order.
        {
            const auto r = dispatch("slRouteList", juce::var(), settings, e);
            CHECK(replyOk(r));
            const auto* routes = result(r).getProperty("routes", juce::var()).getArray();
            CHECK(routes != nullptr);
            CHECK(routes->size() == (int) sl_route_capacity());
            const auto* order = result(r).getProperty("renderOrder", juce::var()).getArray();
            CHECK(order != nullptr && order->size() == (int) sl_channel_count());
            // A fresh engine boots with the DEFAULT wiring installed, and it is
            // flagged — the plane draws no cable for a default, so every cable
            // on screen is one the user made.
            int actives = 0, defaults = 0;
            for (const auto& v : *routes) {
                if ((bool) v.getProperty("active", false)) ++actives;
                if ((bool) v.getProperty("isDefault", false)) ++defaults;
            }
            CHECK(actives > 0 && defaults == actives);
        }

        // clearAll then add: the document-load path. A REFUSED add is reported
        // as ok:false in the RESULT, not as a failed command — the commonest
        // refusal is "that would close a cycle", which the UI answers by
        // offering a feedback edge rather than by catching an exception.
        dispatch("slRoute", juce::JSON::parse(R"({"action":"clearAll"})"), settings, e);
        CHECK(sl_route_count_active(e) == 0);
        const auto added = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":2,"dstIndex":0,"gain":1.0})"),
            settings, e);
        CHECK(replyOk(added));
        CHECK((bool) result(added).getProperty("ok", false));
        CHECK(sl_route_count_active(e) == 1);

        // A cycle is refused UNLESS consented to. 0→1 then 1→0 closes a loop.
        dispatch("slRoute", juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":0,"dstKind":0,"dstIndex":1,"gain":1.0})"),
                 settings, e);
        const auto cyc = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":1.0})"),
            settings, e);
        CHECK(!(bool) result(cyc).getProperty("ok", true)); // refused, no feedback flag
        const auto consented = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"add","srcKind":0,"srcIndex":1,"dstKind":0,"dstIndex":0,"gain":1.0,"feedback":true})"),
            settings, e);
        CHECK((bool) result(consented).getProperty("ok", false)); // honoured when asked for

        // wouldCycle answers the same question WITHOUT patching, so the UI can
        // explain the refusal before making it.
        const auto wc = dispatch("slRoute",
            juce::JSON::parse(R"({"action":"wouldCycle","srcIndex":1,"dstIndex":0})"), settings, e);
        CHECK(replyOk(wc));

        // A tape's waveform over an EMPTY tape returns empty arrays rather than
        // a column of zeros — zeros would draw as real silence at full width.
        const auto wave = dispatch("slTape",
            juce::JSON::parse(R"({"action":"waveform","tape":0,"channel":0,"columns":64})"), settings, e);
        CHECK(replyOk(wave));
        CHECK(result(wave).getProperty("min", juce::var()).getArray() != nullptr);
        // columns must be > 0 — a zero-column request is a UI bug, not a
        // silently-empty waveform.
        CHECK(!replyOk(dispatch("slTape",
            juce::JSON::parse(R"({"action":"waveform","tape":0,"channel":0,"columns":0})"), settings, e)));

        const auto info = dispatch("slTape", juce::JSON::parse(R"({"action":"info","tape":0})"),
                                   settings, e);
        CHECK(replyOk(info));
        CHECK((int) result(info).getProperty("state", -1) == 0); // idle

        // RECORDING WITHOUT A RECORD SERVICE refuses honestly. This is the state
        // the merged shell is in if its drain thread fails to start, and the
        // state every headless caller is in — a fake success would open no file
        // and lose the take silently.
        CHECK(!replyOk(dispatch("slRecord", juce::JSON::parse(R"({"action":"start","tape":0})"),
                                settings, e, nullptr)));
        CHECK(!replyOk(dispatch("slTakes", juce::JSON::parse(R"({"action":"list"})"),
                                settings, e, nullptr)));

        // The source picker's data needs the DEVICE layer, which a headless
        // harness does not have. Refused by name rather than answered with an
        // empty device list — "no devices" and "no device layer" are different
        // facts, and a picker showing an empty list would look like a machine
        // with no inputs.
        CHECK(!replyOk(dispatch("slDevices", juce::JSON::parse(R"({"action":"list"})"),
                                settings, e, nullptr)));

        // With a HostServices carrying a takes directory but no recorder, take
        // ENUMERATION still works — reading the disk needs no drain thread, and
        // a user must be able to see yesterday's takes even if today's audio
        // device never opened.
        {
            wizard::sl::HostServices svc;
            svc.takesDir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                               .getChildFile("sl_dispatch_test_takes").getFullPathName().toStdString();
            const auto r = dispatch("slTakes", juce::JSON::parse(R"({"action":"list"})"),
                                    settings, e, &svc);
            CHECK(replyOk(r));
            CHECK(result(r).getProperty("takes", juce::var()).getArray() != nullptr);
            // Recording still refuses — there is no service to write with.
            CHECK(!replyOk(dispatch("slRecord", juce::JSON::parse(R"({"action":"start","tape":0})"),
                                    settings, e, &svc)));
        }

        sl_engine_destroy(e);
    }

    // ── slFiles — the native library filesystem (P3-SES-1) ───────────────────
    // The OPFS replacement on the JUCE host. What must hold: byte round-trips
    // (text and base64), verbatim names, listing, atomic replace, containment
    // (a path may NEVER escape the library), and honest refusals.
    {
        FakeSettings s2;
        const auto scratch = juce::File::getSpecialLocation(juce::File::tempDirectory)
                                 .getChildFile("sl_dispatch_test_files");
        scratch.deleteRecursively();
        wizard::sl::HostServices svc;
        svc.takesDir = scratch.getChildFile("Takes").getFullPathName().toStdString();
        const auto lib = scratch.getChildFile("Library");
        auto call = [&](const char* json) {
            return dispatch("slFiles", juce::JSON::parse(json), s2, nullptr, &svc);
        };

        // No services → refused by name, never a fabricated empty library.
        CHECK(!replyOk(dispatch("slFiles", juce::JSON::parse(R"({"action":"list","path":"/"})"),
                                s2, nullptr, nullptr)));

        // Text round-trip, directories made on the way. Name kept VERBATIM —
        // "Untitled 2" with its space is the library's actual naming scheme.
        CHECK(replyOk(call(
            R"({"action":"write","path":"/sessions/Untitled 2/pattern.json","text":"{\"bpm\":120}"})")));
        {
            const auto r = call(R"({"action":"read","path":"/sessions/Untitled 2/pattern.json"})");
            CHECK(replyOk(r));
            juce::MemoryBlock decoded;
            {
                juce::MemoryOutputStream out(decoded, false);
                CHECK(juce::Base64::convertFromBase64(
                    out, result(r).getProperty("b64", juce::var()).toString()));
            }
            CHECK(juce::String::fromUTF8(static_cast<const char*>(decoded.getData()),
                                         static_cast<int>(decoded.getSize())) ==
                  "{\"bpm\":120}");
        }

        // The file really is where the containment says it is.
        CHECK(lib.getChildFile("sessions/Untitled 2/pattern.json").existsAsFile());

        // Base64 round-trip of real bytes, including zeros.
        {
            const unsigned char raw[5] = {0x00, 0xFF, 0x10, 0x00, 0x7F};
            const auto b64 = juce::Base64::toBase64(raw, sizeof(raw));
            CHECK(replyOk(dispatch("slFiles",
                [&] {
                    auto* o = new juce::DynamicObject();
                    o->setProperty("action", "write");
                    o->setProperty("path", "/samples/kit/hit.bin");
                    o->setProperty("b64", b64);
                    return juce::var(o);
                }(),
                s2, nullptr, &svc)));
            const auto f = lib.getChildFile("samples/kit/hit.bin");
            CHECK(f.getSize() == 5);
            juce::MemoryBlock back;
            CHECK(f.loadFileAsData(back));
            CHECK(back.getSize() == 5 && std::memcmp(back.getData(), raw, 5) == 0);
        }

        // Listing: the sessions dir holds exactly the one directory, as a dir.
        {
            const auto r = call(R"({"action":"list","path":"/sessions"})");
            CHECK(replyOk(r));
            const auto* entries = result(r).getProperty("entries", juce::var()).getArray();
            CHECK(entries != nullptr && entries->size() == 1);
            CHECK(entries->getReference(0).getProperty("name", "") == juce::var("Untitled 2"));
            CHECK((bool) entries->getReference(0).getProperty("isDirectory", false));
        }
        // A directory that does not exist is a FAILURE, matching OPFS's throw —
        // "no such directory" and "empty" are different facts.
        CHECK(!replyOk(call(R"({"action":"list","path":"/nowhere"})")));

        // Atomic replace: writing over keeps exactly the new content.
        CHECK(replyOk(call(
            R"({"action":"write","path":"/sessions/Untitled 2/pattern.json","text":"NEW"})")));
        CHECK(lib.getChildFile("sessions/Untitled 2/pattern.json").loadFileAsString() == "NEW");
        // …and no stale .tmp stays behind.
        CHECK(!lib.getChildFile("sessions/Untitled 2/pattern.json.tmp").exists());

        // CONTAINMENT. Nothing with ".." may resolve; nothing may escape.
        CHECK(!replyOk(call(R"({"action":"read","path":"/../secrets"})")));
        CHECK(!replyOk(call(R"({"action":"write","path":"/a/../../x","text":"no"})")));
        CHECK(!replyOk(call(R"({"action":"remove","path":"/.."})")));
        CHECK(!replyOk(call(R"({"action":"remove","path":"/"})"))); // the root itself

        // THE /takes MOUNT (P3-U7): read-only access to the take library, so a
        // carved grid track's sample can reference the recorder's WAV with no
        // copy. Reads work; every mutation is refused by name.
        {
            const auto takesDirF = scratch.getChildFile("Takes");
            takesDirF.createDirectory();
            CHECK(takesDirF.getChildFile("tape1_123.wav").replaceWithText("RIFFfake"));
            const auto r = call(R"({"action":"read","path":"/takes/tape1_123.wav"})");
            CHECK(replyOk(r));
            const auto lst = call(R"({"action":"list","path":"/takes"})");
            CHECK(replyOk(lst));
            CHECK(!replyOk(call(R"({"action":"write","path":"/takes/x.wav","text":"no"})")));
            CHECK(!replyOk(call(R"({"action":"remove","path":"/takes/tape1_123.wav"})")));
            CHECK(!replyOk(call(R"({"action":"mkdirs","path":"/takes/sub"})")));
            // Containment holds inside the mount too.
            CHECK(!replyOk(call(R"({"action":"read","path":"/takes/../Library/secrets"})")));
        }

        // exists / mkdirs / remove.
        {
            const auto r = call(R"({"action":"exists","path":"/sessions/Untitled 2"})");
            CHECK(replyOk(r) && (bool) result(r).getProperty("exists", false));
        }
        CHECK(replyOk(call(R"({"action":"mkdirs","path":"/sessions/Empty"})")));
        CHECK(lib.getChildFile("sessions/Empty").isDirectory());
        CHECK(replyOk(call(R"({"action":"remove","path":"/sessions/Untitled 2"})")));
        CHECK(!lib.getChildFile("sessions/Untitled 2").exists());
        // Removing what is not there is a failure, matching OPFS's throw.
        CHECK(!replyOk(call(R"({"action":"remove","path":"/sessions/Untitled 2"})")));

        scratch.deleteRecursively();
    }

    // ── returnFx and pluginHosting are INDEPENDENT (D-SL-DECKPLUGIN-02 · D1) ─
    //
    // They were one derivation, on the rule "a return is either external or a
    // hosted plugin". ScoopyDeck is the host that rule predates: it forbids
    // plugin-in-plugin by decision AND routes Return 1-4 out to DAW tracks. The
    // collapsed derivation answered returnFx:false, which hid the per-track
    // S1-S4 row and made worldFromSession zero every send — the send section
    // invisible in the host built around sends.
    //
    // All four corners, so neither flag can quietly start implying the other.
    {
        HostServices external;          // ScoopyDeck: returns yes, hosting no
        external.externalReturns = true;
        const auto caps = result(dispatch("getCapabilities", juce::var(), settings,
                                          nullptr, &external));
        CHECK((bool) caps.getProperty("returnFx", false) == true);
        CHECK((bool) caps.getProperty("pluginHosting", true) == false);

        HostServices neither;           // headless: no scanner, no buses
        const auto none = result(dispatch("getCapabilities", juce::var(), settings,
                                          nullptr, &neither));
        CHECK((bool) none.getProperty("returnFx", true) == false);
        CHECK((bool) none.getProperty("pluginHosting", true) == false);
    }

    // ── Plugin scanner + FX-return slots (P6-2) ─────────────────────────────
    // Headless truth: without a scanner every plugin command refuses by name
    // and pluginHosting stays false; WITH one (here the link-time stub — this
    // binary carries no JUCE plugin host) the commands answer the schema shape
    // and the capability flips. The app wires the REAL scanner the same way.
    {
        CHECK(!replyOk(dispatch("listPlugins", juce::var(), settings, nullptr)));
        CHECK(!replyOk(dispatch("rescanPlugins", juce::var(), settings, nullptr)));
        CHECK(!replyOk(dispatch("selectFxPlugin",
            juce::JSON::parse(R"({"returnIndex":1,"identifier":"x"})"), settings, nullptr)));

        scoopyloops::NativePluginScanner scanner;
        HostServices services;
        services.pluginScanner = &scanner;

        const auto caps = result(dispatch("getCapabilities", juce::var(), settings,
                                          nullptr, &services));
        CHECK((bool) caps.getProperty("pluginHosting", false) == true);
        // A hosted plugin still implies a real return — an unloaded slot
        // consumes the send into silence, the honest meaning of an empty slot.
        CHECK((bool) caps.getProperty("returnFx", false) == true);

        const auto lp = dispatch("listPlugins", juce::var(), settings, nullptr, &services);
        CHECK(replyOk(lp));
        CHECK(result(lp).hasProperty("plugins"));
        CHECK(result(lp).getProperty("plugins", juce::var()).isArray());
        CHECK(result(lp).hasProperty("scanning"));
        CHECK(replyOk(dispatch("listInstruments", juce::var(), settings, nullptr, &services)));
        CHECK(replyOk(dispatch("rescanPlugins", juce::var(), settings, nullptr, &services)));

        // selectFxPlugin needs the engine (the slots live in the core).
        CHECK(!replyOk(dispatch("selectFxPlugin",
            juce::JSON::parse(R"({"returnIndex":1,"identifier":"x"})"),
            settings, nullptr, &services)));
        sl_engine* engine = sl_engine_create(48000.0, 512, 96);
        CHECK(engine != nullptr);
        CHECK(!replyOk(dispatch("selectFxPlugin",
            juce::JSON::parse(R"({"returnIndex":9,"identifier":"x"})"),
            settings, engine, &services))); // out-of-range refuses
        CHECK(replyOk(dispatch("selectFxPlugin",
            juce::JSON::parse(R"({"returnIndex":1,"identifier":null})"),
            settings, engine, &services))); // null = unload, always accepted

        // The toolbar push exists FOR fxSlots: 4 slots, panel-critical fields
        // present, pluginName explicit-null when empty (zod .strict() +
        // .nullable() both demand the key exist).
        const auto tb = toolbarState(engine, &services);
        const auto fxSlots = tb.getProperty("fxSlots", juce::var());
        CHECK(fxSlots.isArray() && fxSlots.size() == 4);
        for (int i = 0; i < 4; ++i) {
            const auto slot = fxSlots[i];
            CHECK(slot.hasProperty("pluginName"));
            CHECK(slot.getProperty("pluginName", "x").isVoid()); // nothing loaded
            CHECK(slot.hasProperty("latencyMs"));
            CHECK(slot.getProperty("mode", "").toString() == "host");
        }
        // The EXACT required key set of ToolbarUiState (schema.ts, `.strict()`).
        // zod refuses a missing key AND an unknown one, and the panel's
        // safeParse failure mode is silent (it stays on WaitingForState) — so
        // this pins the full contract, not a sample. The two optional fields
        // (activeIsBouncing / activeIsOutputRecording) are legitimately absent.
        static const char* kToolbarKeys[] = {
            "masterIsPlaying", "masterTempo", "deckPlaying", "deckQuantizePending",
            "deckVolume", "deckMuted", "deckSoloed", "sendSoloed", "returnVolume",
            "crossfaderEngaged", "crossfaderPosition", "deckCEnabled", "djModeEnabled",
            "editingDeckIndex", "deckSections", "fxSlots", "deckOutputChannels",
            "outputPairs", "deckMasterSend", "mic", "inputChannelCount",
            "musicalKeyboard", "midiPin"};
        for (const char* key : kToolbarKeys) CHECK(tb.hasProperty(key));
        CHECK(tb.getDynamicObject()->getProperties().size()
              == (int) (sizeof(kToolbarKeys) / sizeof(kToolbarKeys[0])));

        static const char* kFxSlotKeys[] = {
            "mode", "pluginName", "editorVisible", "editorAvailable", "hostToHardware",
            "postFader", "latencyMs", "sendMasterGain", "returnLevel", "muted", "soloed",
            "externalAvailable", "channelLabel", "outputChannel"};
        for (const char* key : kFxSlotKeys) CHECK(fxSlots[0].hasProperty(key));
        CHECK(fxSlots[0].getDynamicObject()->getProperties().size()
              == (int) (sizeof(kFxSlotKeys) / sizeof(kFxSlotKeys[0])));

        // ── The EDITOR door (P6-4) ──────────────────────────────────────────
        //
        // ⚠️ WHAT THIS BINARY CAN AND CANNOT PROVE, stated rather than blurred.
        // It links the JUCE-LESS STUB host and runs with no message loop, so a
        // real editor WINDOW cannot appear here and its appearance is a real-host
        // check (P6-AUDIT's walk). What IS provable headlessly is the whole
        // contract around it — the refusals, and the fact that the reported state
        // is the ENGINE's rather than an echo — and those are exactly the parts
        // that were wrong often enough to earn a gate (see P6-2b).
        {
            // No engine: the slots live in the core, so there is nothing to ask.
            CHECK(!replyOk(dispatch("fxSlot",
                juce::JSON::parse(R"({"returnIndex":1,"op":"toggleEditor"})"),
                settings, nullptr, &services)));
            // Out-of-range returns refuse rather than clamping onto return 1 —
            // the P6-2b lesson, pinned at the dispatcher this time.
            for (const char* bad : {R"({"returnIndex":0,"op":"toggleEditor"})",
                                    R"({"returnIndex":5,"op":"toggleEditor"})",
                                    R"({"returnIndex":-1,"op":"toggleEditor"})"})
                CHECK(!replyOk(dispatch("fxSlot", juce::JSON::parse(bad), settings,
                                        engine, &services)));
            // With an engine and a scanner but NOTHING LOADED: refused BY NAME.
            // A silent ok() here is the failure mode that matters — the caller
            // would light an EDIT lamp over a window that never opens.
            const auto noPlugin = dispatch("fxSlot",
                juce::JSON::parse(R"({"returnIndex":1,"op":"toggleEditor"})"),
                settings, engine, &services);
            CHECK(!replyOk(noPlugin));
            CHECK(errorOf(noPlugin).contains("editor"));
            // The three ops the merged host does NOT back are refused by name
            // too, not swallowed: their home is the mixer strip (P7-MIX-0).
            for (const char* op : {"toggleMode", "toggleHostOutput", "togglePostFader"}) {
                const auto r = dispatch("fxSlot",
                    juce::JSON::parse(juce::String(R"({"returnIndex":1,"op":")")
                                      + op + R"("})"),
                    settings, engine, &services);
                CHECK(!replyOk(r));
                CHECK(errorOf(r).contains(op)); // names the op it refused
            }
            // And the ABI reads false on this host rather than guessing — which
            // is what makes the panel disable its door instead of offering it.
            CHECK(sl_fx_editor_available(engine, 1) == 0);
            CHECK(sl_fx_editor_visible(engine, 1) == 0);
            // Boundaries are answers, not crashes.
            CHECK(sl_fx_editor_available(nullptr, 1) == 0);
            CHECK(sl_fx_editor_visible(engine, 0) == 0);
            CHECK(sl_fx_editor_visible(engine, 5) == 0);
            sl_fx_editor_set_visible(nullptr, 1, 1); // must not crash
            sl_fx_editor_set_visible(engine, 9, 1);
        }

        sl_engine_destroy(engine);
    }

    std::printf("sl_dispatch_test OK\n");
    return 0;
}
