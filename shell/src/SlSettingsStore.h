// File-backed SettingsStore for the merged shell.
//
// SlDispatch takes a SettingsStore& (getSetting/setSetting/getSettings) and the
// headless tests inject a fake; the live window needs a real one that survives a
// restart. This is it — a JSON object on disk, mirroring scoopy's UserDefaults
// role (its settings ARE JSON-shaped values).
//
// Extracted from the window so the persistence is testable without a GUI —
// following wizard's `SessionStore`, which H2b retired once this store had
// inherited its discipline. Writes atomically: a settings file half-written by a
// crash mid-save must leave the PREVIOUS settings intact, not an empty or
// truncated file — losing every preference to one bad save is worse than the
// save failing.
#pragma once

#include "SlDispatch.h"

#include <juce_core/juce_core.h>

namespace wizard::sl {

class FileSettingsStore final : public SettingsStore {
public:
    /** Loads `file` if it holds a JSON object; a missing, empty, or non-object
        file is a clean empty store, never an error (first run looks the same as
        a corrupt file — both start blank rather than refusing to open). */
    explicit FileSettingsStore(juce::File file);

    juce::var get(const juce::String& key) const override;
    void set(const juce::String& key, const juce::var& value) override;
    bool has(const juce::String& key) const override;

private:
    bool persist() const; // atomic; false leaves the on-disk file untouched

    juce::File file_;
    juce::DynamicObject::Ptr values_; // the live object, mirrored to disk on set
};

} // namespace wizard::sl
