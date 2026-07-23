// Headless test of the WZP Command JSON-RPC surface — no WebView, no display.
#include "CommandDispatch.h"

#include "WZProtocol.h"
#include "wz_engine.h"

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
