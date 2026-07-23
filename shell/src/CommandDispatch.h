// Pure Command dispatch: (method, params) -> reply var.
//
// Kept free of any WebView/GUI dependency so the WZP JSON-RPC surface can be
// tested headlessly (command_dispatch_test). Main.cpp's native-function
// callback is a thin adapter over this.
//
// HostServices (device layer, file decode) is threaded through as a nullable
// argument when those tiers land (P0-11 / P1); headless tests pass nullptr and
// get identical replies for the device-free commands.
#pragma once

#include <juce_core/juce_core.h>

struct wz_engine;

namespace wizard::command {

// Reply shape: { ok: bool, result?: <method result>, error?: string }.
// Mirrors CommandReplySchema in web/protocol/schema.ts.
juce::var dispatch(wz_engine* engine, const juce::String& method, const juce::var& params);

} // namespace wizard::command
