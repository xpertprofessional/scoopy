#include "SlSettingsStore.h"

namespace wizard::sl {

FileSettingsStore::FileSettingsStore(juce::File file) : file_(std::move(file)) {
    values_ = new juce::DynamicObject();
    if (file_.existsAsFile()) {
        const auto parsed = juce::JSON::parse(file_.loadFileAsString());
        // A non-object (corrupt, truncated, or an unexpected shape) starts blank
        // rather than throwing — a bad file must not make the app unopenable.
        if (auto* obj = parsed.getDynamicObject())
            values_ = new juce::DynamicObject(*obj);
    }
}

juce::var FileSettingsStore::get(const juce::String& key) const {
    return values_->getProperty(key);
}

bool FileSettingsStore::has(const juce::String& key) const {
    return values_->hasProperty(key);
}

void FileSettingsStore::set(const juce::String& key, const juce::var& value) {
    values_->setProperty(key, value);
    persist();
}

bool FileSettingsStore::persist() const {
    file_.getParentDirectory().createDirectory();

    // Atomic: write a sibling temp, then rename over the target. A crash leaves
    // either the old file or the new one, never a half-written settings file.
    // (juce::TemporaryFile's overwriteTargetFileWithTemporary does exactly this
    // rename-into-place and cleans the temp up on failure.)
    juce::TemporaryFile temp(file_);
    if (!temp.getFile().replaceWithText(juce::JSON::toString(juce::var(values_.get()))))
        return false;
    return temp.overwriteTargetFileWithTemporary();
}

} // namespace wizard::sl
