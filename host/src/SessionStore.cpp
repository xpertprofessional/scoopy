#include "SessionStore.h"

namespace wizard::session {

/** Does this text parse as JSON at all? The shell deliberately does NOT
    validate the SCHEMA — that is the web layer's job and duplicating it here
    would create two sources of truth that drift. But "is it structurally a
    document" is exactly what decides whether the backup is worth trying. */
static bool parses(const juce::String& text) {
    if (text.trim().isEmpty()) return false;
    juce::var parsed;
    return juce::JSON::parse(text, parsed).wasOk() && parsed.isObject();
}

bool Store::write(const juce::String& text) const {
    dir_.createDirectory();
    const auto tmp = temp();
    tmp.deleteFile();

    bool ok = false;
    {
        juce::FileOutputStream out(tmp);
        if (out.openedOk()) {
            ok = out.writeText(text, false, false, nullptr);
            out.flush(); // to disk BEFORE we rename over the good copy
            ok = ok && out.getStatus().wasOk();
        }
    }
    if (ok) {
        if (primary().existsAsFile()) {
            // Rotate first, so even a rename that somehow fails leaves a copy.
            backup().deleteFile();
            primary().copyFileTo(backup());
        }
        ok = tmp.moveFileTo(primary());
    }
    // A failed write must never leave a half-file lying where a reader looks.
    if (!ok) tmp.deleteFile();
    return ok;
}

LoadResult Store::read() const {
    LoadResult r;

    juce::String primaryText;
    if (primary().existsAsFile()) primaryText = primary().loadFileAsString();
    if (parses(primaryText)) return {primaryText, Source::primary};

    // The primary is missing, empty, or not a document. Try the backup —
    // BEFORE giving up, because starting empty is the outcome this whole
    // feature exists to prevent.
    juce::String backupText;
    if (backup().existsAsFile()) backupText = backup().loadFileAsString();
    if (parses(backupText)) return {backupText, Source::backup};

    // Neither is usable. If the primary had SOMETHING in it, hand that back so
    // the web layer can explain what is wrong with it. Reporting "no session"
    // for a file that plainly exists would be a lie the user cannot debug.
    if (primaryText.isNotEmpty()) return {primaryText, Source::primary};
    return r; // genuinely nothing: a first launch
}

} // namespace wizard::session
