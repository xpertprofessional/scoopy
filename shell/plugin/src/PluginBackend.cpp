#include "PluginBackend.h"

#include "sl_engine.h"

namespace wizard::plugin {

PluginBackend::PluginBackend(sl_engine* e, const juce::String& faceDir)
    : engine(e),
      // Its OWN data directory (D-SL-DECKPLUGIN-01): a plugin instance sharing
      // WizardMerged/settings.json would fight the app over launch.face and
      // recordings.dir from inside somebody's DAW session. `faceDir` is per
      // PRODUCT, not per instance — every ScoopyTape shares one settings.json
      // and none of them touch ScoopyDeck's.
      settings(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                   .getChildFile(faceDir + "/settings.json")),
      drainSource(e) {
    // ⚠️ THE LIBRARY IS SHARED WITH THE APP, deliberately.
    //
    // This pointed at ScoopyDeck/Takes at first, which gave the plugin its own
    // empty world: `session ▾` listed NOTHING, because slFiles derives the
    // library from this path (takesDir/../Library) and the user's sessions all
    // live under WizardMerged/. "No load existing session" was the symptom
    // (reported 2026-08-01) and an isolated data directory was the cause.
    //
    // Sessions, samples and takes belong to the PERSON, not to which face of
    // scoopy they opened — a session composed in the app must be loadable in
    // the plugin and vice versa. Only `settings.json` stays separate (above),
    // because window/launch preferences genuinely are per-face.
    const auto stored = settings.get("recordings.dir").toString();
    const auto takesDir =
        stored.isNotEmpty()
            ? juce::File(stored)
            : juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                  .getChildFile("WizardMerged/Takes");
    services.takesDir = takesDir.getFullPathName().toStdString();
    // Same honesty contract as the app: an unstarted recorder makes the record
    // commands refuse rather than pretend to capture.
    if (recorder.start(drainSource, services.takesDir)) services.recorder = &recorder;
    // services.audio and services.pluginScanner stay null — see the header.
    //
    // …but the RETURNS ARE REAL, and that is a separate question (D1). This
    // host's Return 1-4 are output buses: the deck's sends leave through them,
    // a DAW track processes them, and the result comes back in the DAW's mixer.
    // That IS a return section — it is simply not made of hosted plugins.
    // Without this the dispatcher derived returnFx from the (deliberately null)
    // scanner, hid the per-track S1-S4 row, and had worldFromSession zero every
    // send value — the send architecture invisible in the host designed for it.
    services.externalReturns = true;
}

PluginBackend::~PluginBackend() {
    // Before the engine goes: the drain thread holds a reference to it, and
    // finalizes any take still open (same ordering law as the app's Backend).
    recorder.stop();
}

} // namespace wizard::plugin
