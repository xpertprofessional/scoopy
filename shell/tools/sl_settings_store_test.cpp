// The file-backed SettingsStore: does a setting survive a restart, and does a
// bad file fail safe? Headless (no GUI).
#include "SlSettingsStore.h"

#include <cstdio>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

using namespace wizard::sl;

int main() {
    const auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("wizard-sl-settings-test");
    dir.deleteRecursively();
    const auto file = dir.getChildFile("settings.json");

    // A missing file is a clean empty store, not an error.
    {
        FileSettingsStore s(file);
        CHECK(!s.has("theme.tokens"));
        CHECK(s.get("theme.tokens").isVoid());
    }

    // Set persists to disk and SURVIVES a restart (a new store on the same file).
    {
        FileSettingsStore s(file);
        s.set("deck.volume", 0.8);
        s.set("theme.tokens", juce::JSON::parse(R"({"accent":"#abc","n":3})"));
        s.set("flag", true);
    }
    CHECK(file.existsAsFile());
    {
        FileSettingsStore s(file); // "restart"
        CHECK(s.has("deck.volume"));
        CHECK((double) s.get("deck.volume") == 0.8);
        const auto tokens = s.get("theme.tokens");
        CHECK(tokens.getProperty("accent", "").toString() == "#abc");
        CHECK((int) tokens.getProperty("n", 0) == 3);
        CHECK((bool) s.get("flag") == true);
        CHECK(!s.has("never.set"));
    }

    // Overwrite an existing key; the new value persists, the rest untouched.
    {
        FileSettingsStore s(file);
        s.set("deck.volume", 0.25);
    }
    {
        FileSettingsStore s(file);
        CHECK((double) s.get("deck.volume") == 0.25);
        CHECK(s.has("theme.tokens")); // still there
    }

    // An explicit null value is stored and is distinct from "unset" — the
    // SlDispatch settings contract depends on this survivng persistence.
    {
        FileSettingsStore s(file);
        s.set("cleared", juce::var());
    }
    {
        FileSettingsStore s(file);
        CHECK(s.has("cleared"));         // the KEY exists
        CHECK(s.get("cleared").isVoid()); // its value is null
    }

    // A corrupt (non-JSON-object) file fails safe: the store opens blank rather
    // than throwing, so one bad write can't make the app unopenable.
    {
        CHECK(file.replaceWithText("}{ this is not json"));
        FileSettingsStore s(file);
        CHECK(!s.has("deck.volume")); // blank, not a crash
        s.set("recovered", 1);        // and it can write again over the bad file
    }
    {
        FileSettingsStore s(file);
        CHECK((int) s.get("recovered") == 1);
    }

    dir.deleteRecursively();
    std::printf("sl_settings_store_test OK\n");
    return 0;
}
