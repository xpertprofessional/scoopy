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

    // setTestTone toggles the metered boot tone: enabling it makes the main-bus
    // peak non-zero after a render; disabling returns to silence.
    {
        auto* p = new juce::DynamicObject();
        p->setProperty("enabled", true);
        const auto reply = dispatch(e, "setTestTone", juce::var(p));
        CHECK(static_cast<bool>(reply.getProperty("ok", false)));

        constexpr uint32_t frames = 256;
        std::vector<float> l(frames), r(frames);
        float* buses[2] = {l.data(), r.data()};
        wz_engine_render(e, buses, 2, frames);
        double hot[8] = {};
        CHECK(wz_engine_hotframe(e, hot, 8) == 8);
        CHECK(hot[4] > 0.0); // mainPeakL non-zero with the tone on

        auto* off = new juce::DynamicObject();
        off->setProperty("enabled", false);
        dispatch(e, "setTestTone", juce::var(off));
        wz_engine_render(e, buses, 2, frames);
        CHECK(wz_engine_hotframe(e, hot, 8) == 8);
        CHECK(hot[4] == 0.0);
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
