// ScoopyDeck's Backend: the shell Backend minus the device (D-SL-DECKPLUGIN-01).
//
// Deliberately a SIBLING of wizard::merged::Backend rather than a
// parameterisation of it: that ctor's device-open and error string are app law
// (a failure there leaves the APP running silent), and a plugin has no device
// to open — the DAW drives processBlock. Everything else carries over: the
// settings file, the take drain + recorder, the HostServices the dispatcher
// reads. What is ABSENT is the point:
//
//   sink / audioIO      the DAW owns the callback; SlRenderSink's stop→set→
//                       start dance happens in prepareToPlay instead.
//   pluginScanner       never constructed — D-SL-DECKPLUGIN-01 forbids
//                       plugin-in-plugin outright, so `services.pluginScanner`
//                       stays null and `pluginHosting` reads false honestly.
//   services.audio      null: audioDeviceSelection is meaningless in a DAW.
//
// What is PRESENT and easy to miss: `services.externalReturns = true`. Returns
// here are external by architecture (Return 1-4 → DAW tracks), which is a
// different question from whether this host can load a plugin — and the
// dispatcher used to answer both from `pluginScanner`. See SlDispatch.h.
#pragma once

#include "RecordService.h"
#include "SlDispatch.h"
#include "SlSettingsStore.h"
#include "SlTakeDrainSource.h"

struct sl_engine;

namespace wizard::plugin {

struct PluginBackend {
    sl_engine* engine;
    wizard::sl::FileSettingsStore settings;
    wizard::record::SlTakeDrainSource drainSource;
    wizard::record::Service recorder;
    wizard::sl::HostServices services;

    explicit PluginBackend(sl_engine* e);
    ~PluginBackend();
};

} // namespace wizard::plugin
