#include "PluginBackend.h"

#include "sl_engine.h"

namespace wizard::plugin {

PluginBackend::PluginBackend(sl_engine* e)
    : engine(e),
      // Its OWN data directory (D-SL-DECKPLUGIN-01): a plugin instance sharing
      // WizardMerged/settings.json would fight the app over launch.face and
      // recordings.dir from inside somebody's DAW session.
      settings(juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                   .getChildFile("ScoopyDeck/settings.json")),
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
}

PluginBackend::~PluginBackend() {
    // Before the engine goes: the drain thread holds a reference to it, and
    // finalizes any take still open (same ordering law as the app's Backend).
    recorder.stop();
}

} // namespace wizard::plugin
