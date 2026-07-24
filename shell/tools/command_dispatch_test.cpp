// Headless test of the WZP Command JSON-RPC surface — no WebView, no display.
#include "CommandDispatch.h"

#include "WZProtocol.h"
#include "wz_engine.h"

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

int main() {
    using wizard::command::dispatch;

    wz_engine* e = wz_engine_create(48000.0, 512, wz::protocol::kSchemaVersion);
    CHECK(e != nullptr);

    // ping
    {
        const auto reply = dispatch(e, "ping", juce::var());
        CHECK(static_cast<bool>(reply.getProperty("ok", false)));
        CHECK(static_cast<bool>(
            reply.getProperty("result", juce::var()).getProperty("pong", false)));
    }

    // getCapabilities — must carry the exact key set of the strict zod schema
    // (CapabilitiesSchema); a missing/extra key fails validation in the UI.
    {
        const auto reply = dispatch(e, "getCapabilities", juce::var());
        CHECK(static_cast<bool>(reply.getProperty("ok", false)));
        const auto caps = reply.getProperty("result", juce::var());
        CHECK(static_cast<int>(caps.getProperty("schemaVersion", -1)) ==
              wz::protocol::kSchemaVersion);
        CHECK(caps.hasProperty("processCapture"));
        CHECK(caps.hasProperty("virtualDevice"));
        CHECK(caps.hasProperty("pluginHosting"));
        CHECK(caps.hasProperty("fileSystem"));
        CHECK(caps.hasProperty("audioDeviceSelection"));
        CHECK(static_cast<bool>(caps.getProperty("fileSystem", false)));
    }

    // publishWorld installs the Patch as the engine world and echoes a
    // monotonic revision.
    {
        const auto patchJson = juce::JSON::parse(R"({
            "patch": {
                "schemaVersion": 3,
                "channels": [
                    {"key": "mic", "name": "Mic",
                     "source": {"kind": "deviceInput", "id": "0,1", "name": "Built-in"},
                     "gain": 0.5, "pan": -0.25, "mute": false, "solo": false,
                     "toMonitor": true},
                    {"key": "deck-1", "name": "Deck 1",
                     "source": {"kind": "deck", "id": "0", "name": "Deck 1"},
                     "gain": 0.75, "pan": 0, "mute": true, "solo": false,
                     "toMonitor": false}
                ],
                "decks": [], "outputMap": {"main": [0,1], "monitor": null},
                "uiMode": "console"
            }
        })");
        const auto reply = dispatch(e, "publishWorld", patchJson);
        CHECK(static_cast<bool>(reply.getProperty("ok", false)));
        const auto rev = static_cast<juce::int64>(
            reply.getProperty("result", juce::var()).getProperty("revision", 0));
        CHECK(rev == 1);
        CHECK(wz_world_channel_count(e) == 2);
        // Builder values landed in the strips (keyed params read them back).
        const auto gainId = wz_param_id_for_name("gain");
        const auto muteId = wz_param_id_for_name("mute");
        CHECK(wz_param_get(e, 0, gainId) == 0.5);
        CHECK(wz_param_get(e, 1, muteId) == 1.0);
        // Republishing bumps the revision.
        const auto again = dispatch(e, "publishWorld", patchJson);
        CHECK(static_cast<juce::int64>(
                  again.getProperty("result", juce::var()).getProperty("revision", 0)) == 2);
        // A malformed publish (no channels) is a structured failure.
        const auto bad = dispatch(e, "publishWorld", juce::JSON::parse(R"({"patch": {}})"));
        CHECK(!static_cast<bool>(bad.getProperty("ok", true)));
    }

    // WHICH bus a tap listens to must actually reach the engine. srcChan0 was
    // never published for busTap, so every loopback silently tapped MAIN: an
    // "↺ cue" strip was a second copy of main and nothing said so. There is no
    // world getter, so this is checked where it matters — in the audio.
    {
        auto tapPatch = [](const char* busId) {
            return juce::JSON::parse(juce::String(R"({
                "patch": {
                    "schemaVersion": 3,
                    "channels": [
                        {"key": "mic", "name": "Mic",
                         "source": {"kind": "deviceInput", "id": "0", "name": "In"},
                         "gain": 0.75, "pan": 0, "mute": false, "solo": false,
                         "toMonitor": false},
                        {"key": "tap", "name": "tap",
                         "source": {"kind": "busTap", "id": "BUS", "name": "bus"},
                         "gain": 0.75, "pan": 0, "mute": false, "solo": false,
                         "toMonitor": false}
                    ],
                    "decks": [], "outputMap": {"main": [0,1], "monitor": null},
                    "uiMode": "console"
                }
            })").replace("BUS", busId));
        };
        constexpr uint32_t kQ = 512;
        std::vector<float> in(kQ, 1.0f), l(kQ), r(kQ), cl(kQ), cr(kQ);
        const float* ins[1] = {in.data()};
        float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
        auto renderPeak = [&](int blocks) {
            double p = 0.0;
            for (int b = 0; b < blocks; ++b) {
                wz_engine_render_io(e, ins, 1, outs, 4, kQ);
                for (uint32_t i = 0; i < kQ; ++i)
                    p = std::max(p, std::abs(static_cast<double>(l[i])));
            }
            return p;
        };

        // Nothing is sent to the cue bus, so a tap that really listens to CUE
        // contributes silence and main stays at the mic's own level.
        CHECK(static_cast<bool>(
            dispatch(e, "publishWorld", tapPatch("1")).getProperty("ok", false)));
        const double cueTap = renderPeak(8);
        CHECK(cueTap < 1.2);

        // The same patch pointed at MAIN feeds main back into itself one block
        // late — it climbs. That is the difference the dropped field erased.
        CHECK(static_cast<bool>(
            dispatch(e, "publishWorld", tapPatch("0")).getProperty("ok", false)));
        const double mainTap = renderPeak(8);
        CHECK(mainTap > cueTap * 1.5);
        std::printf("  busTap: cue-tap peak=%.3f  main-tap peak=%.3f\n", cueTap, mainTap);
    }

    // Unknown method → structured failure, not a crash.
    {
        const auto reply = dispatch(e, "nope", juce::var());
        CHECK(!static_cast<bool>(reply.getProperty("ok", true)));
        CHECK(reply.getProperty("error", juce::var()).toString().isNotEmpty());
    }

    wz_engine_destroy(e);
    std::printf("command_dispatch_test OK\n");
    return 0;
}
