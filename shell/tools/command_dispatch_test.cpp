// Headless test of the WZP Command JSON-RPC surface — no WebView, no display.
#include "CommandDispatch.h"

#include "WZProtocol.h"
#include "wz_engine.h"

#include <cstdio>

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
