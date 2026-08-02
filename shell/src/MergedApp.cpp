// The merged shell's assembly. See MergedApp.h for why this is a library.
//
// Everything here moved out of MergedMain.cpp at H3 unchanged — same order,
// same comments, same behaviour. The only edits are the ones the move forced:
// members are defined out-of-line, and the page-loaded hook H5 needs is added.
#include "MergedApp.h"

#include "ScoopyPaths.h"

#include "WebResources.h"
#include "sl_engine.h"

#include <algorithm>

namespace wizard::merged {

namespace {

std::optional<juce::WebBrowserComponent::Resource>
provideResource(const juce::String& path) {
    const juce::File root{MERGED_WEBDIST_DIR}; // the vendored, hash-pinned webdist
    auto payload = wizard::webresources::load(root, path);
    if (!payload.has_value()) return std::nullopt;
    const auto* bytes = static_cast<const std::byte*>(payload->data.getData());
    return juce::WebBrowserComponent::Resource{
        std::vector<std::byte>(bytes, bytes + payload->data.getSize()),
        payload->mimeType,
    };
}

/** The shell's WebView: a navigation allowlist, plus the page-loaded hook.
    `pageFinishedLoading` is JUCE's own notification that the bundle has run —
    the earliest moment at which asking the page anything is meaningful. */
class GuardedWebView final : public juce::WebBrowserComponent {
public:
    using OnLoaded = std::function<void()>;

    GuardedWebView(const Options& options, OnLoaded onLoadedToUse)
        : juce::WebBrowserComponent(options), onLoaded(std::move(onLoadedToUse)) {}

    bool pageAboutToLoad(const juce::String& newURL) override {
        // Same allowlist as the legacy shell: a stray drop must not navigate the
        // app away (P1 spike §Q3). Unit-tested in web_resources_test.
        return wizard::webresources::navigationAllowed(
            newURL, juce::WebBrowserComponent::getResourceProviderRoot());
    }

    void pageFinishedLoading(const juce::String&) override {
        // ONCE. A WebView can report a finished load more than once (a reload, a
        // sub-frame settling), and a walk that started twice would interleave
        // two scripts against one page and blame the resulting mess on the app.
        if (onLoaded == nullptr || fired) return;
        fired = true;
        onLoaded();
    }

private:
    OnLoaded onLoaded;
    bool fired = false;
};

} // namespace

// ─────────────────────────────────────────────────────────────────────────────
// Backend
// ─────────────────────────────────────────────────────────────────────────────

Backend::Backend(sl_engine* e)
    : engine(e),
      sink(e),
      audioIO(sink),
      // D-SL-RENAME-01: one resolver, which also carries the migration off the
      // wizard-era directory name. Not spelled out here — it was spelled out in
      // two places before, and the two disagreeing is a reported bug.
      settings(wizard::paths::dataRoot().getChildFile("settings.json")),
      drainSource(e) {
    // Opening the device starts the engine (SlRenderSink::setSampleRate does
    // the D-WZ-RATE-01 stop→set→start). A failure leaves the app running,
    // silent, rather than refusing to open — the UI still comes up.
    deviceError = audioIO.open(sl_engine_sample_rate(engine));

    // Takes live beside the settings, under the app's own data directory,
    // unless the user has chosen a folder. Same key the settings quartet
    // already carries, so the Audio panel's picker points at this without
    // needing a second setting.
    const auto stored = settings.get("recordings.dir").toString();
    const auto takesDir =
        stored.isNotEmpty()
            ? juce::File(stored)
            : wizard::paths::dataRoot().getChildFile("Takes");
    services.takesDir = takesDir.getFullPathName().toStdString();
    // start() creates the directory and launches the drain thread. If it
    // fails, `recorder` stays unstarted and the dispatcher's record commands
    // refuse honestly — the app still runs and still plays.
    if (recorder.start(drainSource, services.takesDir)) services.recorder = &recorder;
    services.audio = &audioIO; // the plane's input source picker reads this
    services.midi = &midi;     // S9: MidiPanel enumerates through this
    services.midiClock = &midiClock;
#if SCOOPY_PLUGIN_HOST
    services.pluginScanner = &pluginScanner; // flips pluginHosting true (P6-2)
#endif
}

Backend::~Backend() {
    // Before the engine goes: the drain thread holds a reference to it, and
    // finalizes any take still open so a quit mid-record leaves a playable
    // file rather than a truncated one.
    recorder.stop();
}

// ─────────────────────────────────────────────────────────────────────────────
// PanelWindow
// ─────────────────────────────────────────────────────────────────────────────

PanelWindow::PanelWindow(Backend& backendToUse, juce::String panel, juce::String panelArgToUse,
                         bool isMainToUse, OpenPanel openPanel, CloseSelf closeSelf,
                         PageLoaded pageLoaded)
    : juce::DocumentWindow("ScoopyLoops - " + panel, juce::Colours::black,
                           juce::DocumentWindow::allButtons),
      backend(backendToUse),
      panelName(std::move(panel)),
      isMain(isMainToUse),
      openPanelFn(std::move(openPanel)),
      panelArg(std::move(panelArgToUse)),
      closeSelfFn(std::move(closeSelf)),
      pageLoadedFn(std::move(pageLoaded)) {
    webView = std::make_unique<GuardedWebView>(
        juce::WebBrowserComponent::Options{}
            .withNativeIntegrationEnabled()
            .withResourceProvider(provideResource)
            // Panel identity, the same hook the mac shell uses: scoopy's
            // App.tsx reads window.__slPanel first (P1 spike §Q2).
            // Panel identity + its ADDRESS (P3-4-2). `__slPanelArg` was
            // read by FxSlotPanel/InstrumentPanel and never injected — an
            // addressed window opened unaddressed. Sanitised to
            // alphanumerics because it rides inside a user script.
            .withUserScript("window.__slPanel = \"" + panelName + "\";" +
                            (panelArg.isNotEmpty()
                                 ? " window.__slPanelArg = \"" +
                                       panelArg.retainCharacters(
                                           "abcdefghijklmnopqrstuvwxyz"
                                           "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") +
                                       "\";"
                                 : juce::String()))
            .withNativeFunction(
                "slCommand",
                [this](const juce::Array<juce::var>& args,
                       juce::WebBrowserComponent::NativeFunctionCompletion complete) {
                    complete(handleCommand(args));
                })
            // Live control writes (SL-ABI-V3 §3). This listener USED TO BE
            // EMPTY — `[](juce::var) {}` — so every param the UI wrote was
            // received and thrown away, and there was nothing on screen to
            // say so. That is the failure mode this shell keeps having to
            // design against, so what replaces it is explicit about both
            // halves: what native owns, and what it does not.
            .withEventListener("slParam", [this](juce::var v) { handleParam(v); }),
        [this] {
            if (pageLoadedFn != nullptr) pageLoadedFn(*this);
        });

    setUsingNativeTitleBar(true);
    setContentNonOwned(webView.get(), false);
    setResizable(true, false);
    centreWithSize(1200, 780);
    setVisible(true);
    webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
}

PanelWindow::~PanelWindow() = default;

void PanelWindow::closeButtonPressed() {
    // The main window closing quits the app; a spawned panel just closes.
    if (isMain) juce::JUCEApplication::getInstance()->systemRequestedQuit();
    else closeSelfFn(this);
}

void PanelWindow::emitHotFrame(const juce::Array<juce::var>& frame) {
    if (webView != nullptr) webView->emitEventIfBrowserIsVisible("slHotFrame", juce::var(frame));
}

void PanelWindow::emitEvent(const juce::String& name, const juce::var& payload) {
    if (webView != nullptr) webView->emitEventIfBrowserIsVisible(name, payload);
}

void PanelWindow::evaluate(const juce::String& script,
                           juce::WebBrowserComponent::EvaluationCallback callback) {
    if (webView == nullptr) {
        // Report the failure rather than dropping the callback: a walk whose
        // assertion never returns looks like a hang, not a result.
        if (callback != nullptr)
            callback(juce::WebBrowserComponent::EvaluationResult::Error{
                juce::WebBrowserComponent::EvaluationResult::Error::Type::unknown,
                "this PanelWindow has no WebView"});
        return;
    }
    webView->evaluateJavascript(script, std::move(callback));
}

/** THE PARAM LANE, and the map from scoopy's names to the engine's.
 *
 * scoopy's `PARAM_IDS` are the Swift-era vocabulary: most of them name a
 * document the merged shell does not own, and several name controls this
 * app reaches by a BETTER route. So the table is short on purpose, and the
 * omissions are the interesting part:
 *
 *   deckVolume · deckMuted · deckSoloed   the strip's channel owns these
 *       (`sl_channel_*`). Mapping them here would be a second way to set
 *       one gain, and the two would disagree the moment either moved.
 *   masterTempo · deckNudgeBpm · sessionBpm   TEMPO INTENT, not engine
 *       state. The plane resolves them through scoopy's tempo law
 *       (djMix.ts) into a per-deck ratio and sends THAT. An engine that
 *       took a master bpm would be a second tempo authority.
 *   everything else   belongs to panels whose document owner is the
 *       browser companion, not this shell.
 *
 * An unmapped name is REFUSED IN THE LOG, once per name — loudly enough to
 * find, quietly enough that a per-rAF drag does not become a console storm.
 * Silence is what cost this shell a session already.
 *
 * ⚠️ THIS TABLE IS THE SEAM, AND IT IS GATED. Both sides are strings that
 * nothing type-checks: a typo on the left never matches a param the UI
 * sends, a typo on the right resolves to SL_PARAM_UNKNOWN, and BOTH fail
 * silently — a control that moves on screen and reaches nothing, which is
 * the defect this phase keeps paying for. `npm run params:check` parses this
 * table and refuses either. Keep it parseable: one `{"scoopy", "engine"}`
 * pair per line. */
namespace {
struct ParamMapping { const char* scoopyName; const char* engineName; };
constexpr ParamMapping kParamMap[] = {
    {"deckTranspose", "transpose"},
    {"deckBusTexture", "texture"},
};
} // namespace

void PanelWindow::handleParam(const juce::var& v) {
    auto* obj = v.getDynamicObject();
    if (obj == nullptr) return;
    const auto name = obj->getProperty("p").toString();
    const auto deck = (int) obj->getProperty("deck");
    const double value = (double) obj->getProperty("v");

    // scoopy name → engine deck-param name. Resolved to ids on use; the
    // ABI's rule is resolve-by-name, not hardcode-the-int.
    const char* engineName = nullptr;
    for (const auto& m : kParamMap)
        if (name == m.scoopyName) { engineName = m.engineName; break; }

    if (engineName == nullptr) {
        if (!warnedParams.contains(name)) {
            warnedParams.add(name);
            DBG("slParam: '" << name << "' has no engine deck param in the merged shell "
                             << "(see the omission list in PanelWindow::handleParam)");
        }
        return;
    }
    if (deck < 0 || deck >= (int) sl_deck_count()) return;
    const int32_t id = sl_param_id_for_name(engineName);
    if (id == SL_PARAM_UNKNOWN) return; // engine and shell disagree — refuse, never guess
    sl_param_set(backend.engine, (uint32_t) deck, id, value);
}

juce::var PanelWindow::handleCommand(const juce::Array<juce::var>& args) {
    const auto method = args.size() > 0 ? args[0].toString() : juce::String();
    const auto params = args.size() > 1 ? args[1] : juce::var();

    // Window-spawning is shell-owned (it needs the window layer), like the
    // legacy shell answered device/dialog commands before the pure
    // dispatcher. This IS the multi-window model: the UI asks, the shell
    // opens another DocumentWindow.
    if (method == "openInstrumentWindow" || method == "openFxSlotWindow" ||
        method == "openAudioRoutingWindow" || method == "openPanelWindow") {
        // openPanelWindow is the plane's own spawn verb (merge P2 step 4):
        // it names the panel rather than encoding it in the method, which is
        // what "compose beside the map" needs — the plane opens a compose
        // window per strip and cannot know at schema-writing time which
        // panels a strip will want.
        const auto panel = method == "openFxSlotWindow"         ? juce::String("fxslot")
                           : method == "openAudioRoutingWindow" ? juce::String("audio")
                           : method == "openPanelWindow"
                               ? params.getProperty("panel", "companion").toString()
                               : juce::String("instrument");
        openPanelFn(panel, params.getProperty("arg", "").toString());
        auto* env = new juce::DynamicObject();
        env->setProperty("ok", true);
        env->setProperty("result", juce::var(new juce::DynamicObject()));
        return juce::var(env);
    }

    // Everything else (the boot handshake, the worldPublish play path and
    // the plane's strip surface) is the pure, unit-tested dispatcher.
    return wizard::sl::dispatch(method, params, backend.settings, backend.engine,
                                &backend.services);
}

// ─────────────────────────────────────────────────────────────────────────────
// MergedApplication
// ─────────────────────────────────────────────────────────────────────────────

void MergedApplication::initialise(const juce::String&) {
    engine = sl_engine_create(48000.0, 512, kScoopySchemaVersion);
    jassert(engine != nullptr);
    jassert(sl_abi_version() == SL_ABI_VERSION);
    backend = std::make_unique<Backend>(engine);

    // SCOOPY STUDIO IS THE ONLY DOOR (D-SL-STUDIO-01).
    //
    // ⚠️ THE CHOOSER IS GONE, and its removal is the decision rather than a
    // simplification. It asked "PLANE or COMPOSE" (P7-L2 · D-SL-LAUNCH-01) and
    // remembered the answer (D-SL-CHOOSER-01), which was right while the app
    // was two products sharing a binary. It is not right now: the plane is
    // FROZEN, so the question offered a door to a surface that receives no
    // further work, and every launch charged one click for it. Both of those
    // decisions are superseded by name in DECISIONS.md.
    //
    // The plane is not deleted and this is not a one-way trip — `?panel=plane`
    // still reaches it, `launchFaceOverride()` below still opens it, and its
    // tests still run. What changed is what the app opens when nobody says.
    //
    // ⚠️ STUDIO IS MAPLESS, and inherits the whole of B5/1's lesson from the
    // compose path it replaces: it opens with NO arg and creates no map
    // document, so an unaddressed session surface had to become a valid state
    // rather than a refusal, and its boot effect must start the engine sink
    // even with nothing to open. Restoring the last session is S7's work; until
    // then an empty studio SAYS so and puts `session ▾` beside the words.
    //
    // `launchFaceOverride()` survives the chooser it was written for. It is no
    // longer about dodging a dialog that would hang a walk — there is no dialog
    // — but about letting a caller name a face on purpose, which is how
    // merged_walk covers the plane and Studio separately.
    const auto forced = launchFaceOverride();
    openPanel(forced.isNotEmpty() ? forced : "studio", "", /*isMain*/ true);

    startTimerHz(30); // the HotFrame broadcast
}

void MergedApplication::shutdown() {
    stopTimer();
    windows.clear();
    // Hosted plugins die synchronously HERE, on the message thread, before
    // the engine that owns their slots: a plugin destructor may pump the
    // message loop, and the async unload path never runs once the loop is
    // stopping (the destroyNow contract, NativePluginHost.hpp).
    if (engine != nullptr) sl_fx_teardown(engine);
    backend.reset();
    if (engine != nullptr) { sl_engine_destroy(engine); engine = nullptr; }
}

void MergedApplication::openPanel(const juce::String& panel, const juce::String& arg,
                                  bool isMain) {
    windows.push_back(std::make_unique<PanelWindow>(
        *backend, panel, arg, isMain,
        [this](const juce::String& p, const juce::String& a) { openPanel(p, a, false); },
        [this](PanelWindow* w) { removeWindow(w); },
        [this](PanelWindow& w) {
            // FIRST page only — subsequent windows load their own pages and a
            // walk must not be restarted by one it spawned itself.
            if (sawFirstPage) return;
            sawFirstPage = true;
            firstPageLoaded(w);
        }));
}

void MergedApplication::removeWindow(PanelWindow* w) {
    // DEFERRED: this is called from w's own closeButtonPressed, so erasing
    // the owning unique_ptr here would delete `w` while its method is still
    // on the stack — a use-after-free the moment control returns. Hop to a
    // later message so the window is torn down after its callback unwinds.
    juce::MessageManager::callAsync([this, w] {
        // Capture identity BEFORE the erase deletes `w`.
        const auto closedPanel = w->panel();
        const auto closedArg = w->arg();
        windows.erase(std::remove_if(windows.begin(), windows.end(),
                                     [w](const std::unique_ptr<PanelWindow>& p) { return p.get() == w; }),
                      windows.end());
        // P3-C1: tell the survivors which window went away — the plane
        // resumes ownership of a deck when its compose window closes
        // (single-publisher rule, P3-C2). Broadcast like the HotFrame:
        // uninterested windows simply have no listener.
        auto* obj = new juce::DynamicObject();
        obj->setProperty("panel", closedPanel);
        obj->setProperty("arg", closedArg);
        const juce::var payload(obj);
        for (auto& win : windows) win->emitEvent("slPanelClosed", payload);
    });
}

void MergedApplication::timerCallback() {
    const auto len = sl_hotframe_length();
    if (hotFrameBuf.size() < len) hotFrameBuf.resize(len, 0.0);
    const auto n = sl_hotframe(engine, hotFrameBuf.data(),
                               static_cast<uint32_t>(hotFrameBuf.size()));
    juce::Array<juce::var> frame;
    frame.ensureStorageAllocated(static_cast<int>(n));
    for (uint32_t i = 0; i < n; ++i) frame.add(hotFrameBuf[i]);
    for (auto& w : windows) w->emitHotFrame(frame);

    // The "toolbar" uiState push (P6-2) — the FX picker windows subscribe
    // to it and render WaitingForState until it arrives. Every 15th
    // HotFrame tick (~2 Hz): cheap to build, and plugin loads are async so
    // a periodic push IS how their names reach the panel — no completion
    // plumbing across the dispatch boundary.
    if (++toolbarTick >= 15) {
        toolbarTick = 0;
        auto* payload = new juce::DynamicObject();
        payload->setProperty("topic", "toolbar");
        payload->setProperty("state",
                             wizard::sl::toolbarState(engine, &backend->services));
        const juce::var msg(payload);
        for (auto& w : windows) w->emitEvent("slUiState", msg);
    }
}

} // namespace wizard::merged
