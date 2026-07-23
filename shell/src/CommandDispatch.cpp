#include "CommandDispatch.h"

#include "WZProtocol.h"
#include "wz_engine.h"

namespace wizard::command {

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

// Capability handshake — the UI mounts panels from this. Every flag is a
// forward-looking seam wired false until its phase: processCapture (P2 taps),
// virtualDevice (P5 "Wizard Out"), pluginHosting (P6), audioDeviceSelection
// (P0-11 device layer). fileSystem is true — the shell owns native dialogs.
juce::var capabilities() {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("schemaVersion", wz::protocol::kSchemaVersion);
    obj->setProperty("processCapture", false);
    obj->setProperty("virtualDevice", false);
    obj->setProperty("pluginHosting", false);
    obj->setProperty("fileSystem", true);
    obj->setProperty("audioDeviceSelection", false);
    return juce::var(obj);
}

} // namespace

juce::var dispatch(wz_engine* engine, const juce::String& method, const juce::var& params) {
    juce::ignoreUnused(engine, params);

    if (method == "ping") {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("pong", true);
        return ok(juce::var(obj));
    }

    if (method == "getCapabilities")
        return ok(capabilities());

    return fail("unknown method: " + method);
}

} // namespace wizard::command
