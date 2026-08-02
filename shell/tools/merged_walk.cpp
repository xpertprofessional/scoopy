// MergedWalk — the walk that runs in the REAL HOST.
//
// WHAT THIS EXISTS FOR
//
// The eight `web/tools/browser_*.mjs` walks drive the UI in a browser. They are
// good, and they are blind to exactly one half of this app: everything that only
// happens when the page is inside a JUCE WebView. A browser page has no
// `window.__JUCE__`, so `browserLink.ts` answers instead of the native
// dispatcher, and any question whose answer differs between the two hosts gets
// answered by the wrong one.
//
// That blind spot has cost this repo repeatedly, always the same way — the lane
// is built, the gate is green, the feature reaches nothing:
//
//   · the `slParam` listener was `[](juce::var) {}` — every param the UI wrote
//     was received and discarded.
//   · `__slPanelArg` was read by two panels and never injected — every
//     addressed window opened unaddressed.
//   · P7-T4 records it as a standing limitation: "NOT provable in Chromium:
//     `returnFx` is false in the browser host".
//
// And building this file found another: the native host reported `schemaVersion`
// 92 against a UI at 96. Two things should have caught that and structurally
// could not — App.tsx's own comparison renders only on the fallback debug panel
// (every real panel returns earlier), and every browser walk passed because
// `browserLink.ts` reports the UI's OWN constant, so the browser host agrees
// with itself by construction. That one is now gated mechanically by
// `npm run schema:check`, which is the better home for a constant comparison;
// this binary is for what genuinely needs the running app.
//
// So: the same app — it links `wz_merged_app`, the shell itself, never a copy —
// with a script driving it instead of a person.
//
// ⚠️ HONEST LIMITS, so nobody mistakes this for more than it is:
//   · It is a GUI binary. It opens real windows and needs a logged-in window
//     server, so it is a local / macOS-runner gate, not a headless-container
//     one. It exits 77 (ctest SKIP) when it cannot get one.
//   · It does NOT replace the human visual pass. It proves a window exists, the
//     page loaded, the bridge is wired and frames arrive — it cannot prove the
//     plane LOOKS right. P6-4 already recorded that no headless test can prove
//     a plugin editor window appears; that stays true here.
//   · It asserts what the PAGE can observe. A control that is wired but
//     invisible still passes. That remains the visual pass's job.
//   · Scripts must be SYNCHRONOUS. JUCE's evaluateJavascript cannot serialise a
//     Promise back (EvaluationResult::Error::Type::unsupportedReturnType), so
//     anything asynchronous is done as "arm in one step, read in a later one"
//     with a settle between — see the HotFrame check.
#include "MergedApp.h"

#include <cstdio>
#include <cstdlib>
#include <vector>

namespace {

constexpr int kExitSkip = 77; // ctest SKIP_RETURN_CODE

/** WHICH FACE this run drives, from `SL_WALK_FACE`; default `studio`.
 *
 * Every check below except the panel-identity one is face-agnostic — they ask
 * about the bridge, the native functions, the mounted bundle and the HotFrame
 * broadcast, none of which care what is drawn. So one binary covers both faces
 * and ctest registers it twice (S1), rather than a second walk drifting from
 * this one.
 *
 * The DEFAULT is `studio` because that is what the app now opens when nobody
 * says (D-SL-STUDIO-01). A gate whose default path is not the product's default
 * path proves the wrong thing; the frozen plane keeps its own registration so
 * freezing does not mean going untested. */
juce::String walkFace() {
    if (const char* env = std::getenv("SL_WALK_FACE"); env != nullptr && *env != 0)
        return juce::String(env);
    return "studio";
}

/** One assertion. `script` runs in the page and must evaluate to a STRING:
    empty means pass, anything else is the reason it failed. A boolean would
    tell us a walk broke without telling us what the app actually had. */
struct Step {
    const char* name;
    int settleMs;      // wait before running (0 = immediately)
    const char* script;
};

const Step kSteps[] = {
    // ── the things that are true ONLY in a JUCE host ────────────────────────
    {"the JuceLink bridge exists (this is a JUCE WebView, not a browser)", 0,
     R"JS((function () {
        if (typeof window.__JUCE__ === 'undefined')
          return 'window.__JUCE__ is undefined - this page is not in a JUCE WebView';
        if (!window.__JUCE__.backend) return '__JUCE__ has no backend';
        return '';
      })())JS"},

    {"the shell registered its native functions (slCommand)", 0,
     R"JS((function () {
        var d = window.__JUCE__ && window.__JUCE__.initialisationData;
        var fns = d && d.__juce__functions;
        if (!fns) return 'no initialisationData.__juce__functions - native integration is off';
        if (fns.indexOf('slCommand') < 0)
          return 'slCommand is not registered; registered: ' + JSON.stringify(fns);
        return '';
      })())JS"},

    // The P3-4-2 defect class: a window opened without the identity the shell
    // was supposed to inject. Invisible to any browser walk, which sets its own.
    // `%FACE%` is substituted before evaluation — see evaluateCurrent. The face
    // is the one thing here that is not the same question on every surface.
    {"panel identity was injected (__slPanel)", 0,
     R"JS((function () {
        if (window.__slPanel !== '%FACE%')
          return '__slPanel is ' + JSON.stringify(window.__slPanel) + ', expected "%FACE%"';
        return '';
      })())JS"},

    {"the committed bundle mounted under WKWebView", 0,
     R"JS((function () {
        var r = document.getElementById('root');
        if (!r) return 'no #root element - the bundle did not load from the resource provider';
        if (r.children.length === 0) return '#root is empty - React did not mount';
        return '';
      })())JS"},

    // ⚠️ THE CHECK ABOVE IS NOT ENOUGH, and finding that out is why this one
    // exists (S1). `__slPanel` proves what the SHELL injected; `#root` having
    // children proves React mounted SOMETHING. Neither proves the named face
    // rendered — App.tsx's route falls through to `DebugPanel` for any panel it
    // does not know, and DebugPanel satisfies both. A walk against a bundle
    // built before a new face existed therefore passes 6/6 while the face is
    // absent, which is precisely the "green gate, feature reaches nothing"
    // shape this binary was written to catch. Measured, not theorised: it
    // happened on this walk's first run.
    {"the named face actually rendered (not the debug fallback)", 0,
     R"JS((function () {
        var m = document.querySelector('main.panel');
        if (!m) {
          // Say WHAT is there. "nothing rendered" sends you looking at the
          // route; a React error overlay or an empty root sends you somewhere
          // else entirely, and the walk is the only place that can see it.
          var r = document.getElementById('root');
          var head = r ? r.innerHTML.slice(0, 300) : '(no #root)';
          return 'no <main class="panel"> - #root contains: ' + head;
        }
        var label = m.getAttribute('aria-label') || '';
        var cls = m.className || '';
        // Each face names itself: Studio/compose via aria-label, the plane via
        // its class. A face that identifies itself as neither is the fallback.
        var ok = label.indexOf('%FACE%') === 0 || cls.indexOf('%FACE%-panel') >= 0;
        if (!ok)
          return 'rendered <main class="' + cls + '" aria-label="' + label +
                 '">, which is not the %FACE% face - the route fell through';
        return '';
      })())JS"},

    // ── MIDI: the shell answers, and says what it can and cannot do (S9) ────
    //
    // The claim being checked is narrow and worth stating: `enumerateMidiEndpoints`
    // reaches the SHELL and comes back with a well-formed answer. Before S9 all
    // eleven MIDI methods were specified and answered by nobody, so this call
    // threw from BrowserLink and MidiPanel showed "loading endpoints…" forever.
    //
    // It does NOT assert that any device exists — a CI box has none, and a walk
    // that needs hardware plugged in is a walk that gets disabled.
    {"(arm) ask the shell to enumerate MIDI endpoints", 0,
     R"JS((function () {
        try {
          window.__midi = null;
          // JUCE's getNativeFunction wire format, verbatim from
          // protocol/juceLink.ts — the SAME lane the app uses, so this measures
          // the shell rather than a convenience the walk invented.
          var id = 909091;
          // ONE completion channel carrying the id in its payload — not a
          // per-id event. Read from protocol/juceLink.ts rather than guessed;
          // guessing it cost this walk one failing run.
          window.__JUCE__.backend.addEventListener('__juce__complete', function (p) {
            if (p && p.promiseId === id) window.__midi = p.result;
          });
          window.__JUCE__.backend.emitEvent('__juce__invoke', {
            name: 'slCommand',
            params: ['enumerateMidiEndpoints', {}],
            resultId: id,
          });
          return '';
        } catch (e) { return 'could not call: ' + e; }
      })())JS"},

    {"the shell ANSWERS enumerateMidiEndpoints (it answered nobody before S9)", 700,
     R"JS((function () {
        var m = window.__midi;
        if (m === null || m === undefined) return 'no reply within ~700ms';
        var r = (typeof m === 'string') ? JSON.parse(m) : m;
        if (r && r.ok === false) return 'refused: ' + JSON.stringify(r.error);
        var res = (r && r.result) ? r.result : r;
        if (!res || !Array.isArray(res.sources) || !Array.isArray(res.destinations))
          return 'malformed: ' + JSON.stringify(res).slice(0, 200);
        if (res.syncMode !== 'internalMaster' && res.syncMode !== 'externalSlave')
          return 'bad syncMode: ' + JSON.stringify(res.syncMode);
        return '';
      })())JS"},

    // The CLOCK lane, page to shell. `stop` because it is the one op that is
    // safe to issue at any time and against any state — it asserts the chain
    // exists without starting anything on somebody's hardware mid-walk.
    {"(arm) ask the shell for the MIDI clock's state", 0,
     R"JS((function () {
        try {
          window.__clk = null;
          var id = 909092;
          window.__JUCE__.backend.addEventListener('__juce__complete', function (p) {
            if (p && p.promiseId === id) window.__clk = p.result;
          });
          window.__JUCE__.backend.emitEvent('__juce__invoke', {
            name: 'slCommand', params: ['midiClock', { op: 'stop' }], resultId: id,
          });
          return '';
        } catch (e) { return 'could not call: ' + e; }
      })())JS"},

    {"the clock lane answers, and reports both running AND open", 700,
     R"JS((function () {
        var m = window.__clk;
        if (m === null || m === undefined) return 'no reply within ~700ms';
        var r = (typeof m === 'string') ? JSON.parse(m) : m;
        if (r && r.ok === false) return 'refused: ' + JSON.stringify(r.error);
        var res = (r && r.result) ? r.result : r;
        if (!res || typeof res.running !== 'boolean') return 'no running flag';
        // `open` is the half that makes "off" distinguishable from "nowhere to
        // send" — without it a silent clock has two causes and one appearance.
        if (typeof res.open !== 'boolean') return 'no open flag';
        if (res.running !== false) return 'a stopped clock reports running';
        return '';
      })())JS"},

    // ── the native -> page lane, end to end ─────────────────────────────────
    // ARM. Subscribes through JUCE's own documented backend API rather than
    // reaching into the app's link object, so this measures the HOST's
    // broadcast and not our own bookkeeping.
    {"(arm) listen for slHotFrame", 0,
     R"JS((function () {
        try {
          window.__walkFrames = 0;
          window.__JUCE__.backend.addEventListener('slHotFrame', function () {
            window.__walkFrames = (window.__walkFrames || 0) + 1;
          });
          return '';
        } catch (e) { return 'could not subscribe: ' + e; }
      })())JS"},

    // READ, one second later. The app broadcasts at 30 Hz, so a second is ~30
    // frames; anything above zero proves the timer, the engine and the emit
    // path all reached the page. Deliberately not asserting an exact count —
    // a gate that fails on scheduler jitter gets ignored, and then it is not a
    // gate.
    {"HotFrames actually arrive in the page (the 30 Hz broadcast)", 1000,
     R"JS((function () {
        var n = window.__walkFrames || 0;
        if (n === 0) return 'no slHotFrame events in ~1s - the broadcast never reached the page';
        return '';
      })())JS"},
};

constexpr int kStepCount = (int) (sizeof(kSteps) / sizeof(kSteps[0]));

struct Check {
    juce::String name;
    bool passed = false;
    juce::String detail;
};

/** Runs the steps one after another. Sequential on purpose: evaluateJavascript
    is asynchronous, and firing them together would interleave their results and
    make a failure impossible to attribute. */
class Walk {
public:
    Walk(wizard::merged::PanelWindow& windowToUse, std::function<void(bool)> onDone)
        : window(windowToUse), done(std::move(onDone)) {}

    void start() { runNext(); }

private:
    void runNext() {
        if (index >= kStepCount) { report(); return; }
        const auto& step = kSteps[index];
        if (step.settleMs > 0)
            juce::Timer::callAfterDelay(step.settleMs, [this] { evaluateCurrent(); });
        else
            evaluateCurrent();
    }

    void evaluateCurrent() {
        const auto& step = kSteps[index];
        const auto script = juce::String(step.script).replace("%FACE%", walkFace());
        window.evaluate(script, [this, name = juce::String(step.name)](
                                         juce::WebBrowserComponent::EvaluationResult r) {
            Check c;
            c.name = name;
            if (const auto* err = r.getError()) {
                c.passed = false;
                c.detail = "evaluation error: " + err->message;
            } else if (const auto* v = r.getResult()) {
                const auto s = v->toString();
                c.passed = s.isEmpty();
                c.detail = s;
            } else {
                c.passed = false;
                c.detail = "no result and no error - the WebView returned nothing";
            }
            checks.push_back(c);
            ++index;
            runNext();
        });
    }

    void report() {
        int failed = 0;
        std::printf("\nMergedWalk - the real host\n");
        std::printf("------------------------------------------------------------\n");
        for (const auto& c : checks) {
            // An (arm) step is plumbing, not a claim; it is still reported so a
            // failure there cannot look like the claim after it passing.
            std::printf("  %s  %s\n", c.passed ? "PASS" : "FAIL", c.name.toRawUTF8());
            if (!c.passed) { std::printf("        %s\n", c.detail.toRawUTF8()); ++failed; }
        }
        std::printf("------------------------------------------------------------\n");
        std::printf("%s - %d/%d\n\n", failed == 0 ? "MergedWalk OK" : "MergedWalk FAILED",
                    kStepCount - failed, kStepCount);
        done(failed == 0);
    }

    wizard::merged::PanelWindow& window;
    std::function<void(bool)> done;
    std::vector<Check> checks;
    int index = 0;
};

/** The app, with a script instead of a person. Everything it drives comes from
    MergedApplication — this subclass adds only the trigger. */
class WalkApplication final : public wizard::merged::MergedApplication {
public:
    const juce::String getApplicationName() override { return "MergedWalk"; }

    static int exitCode;

protected:
    /** The walk names the face it drives rather than taking the app's default,
        so one binary can cover both and a run says which it covered.

        There is no chooser to dodge any more (D-SL-STUDIO-01 removed it), but
        naming the face is still right: the walk asserts `__slPanel` equals what
        it asked for, which is the P3-4-2 defect class — a window opened without
        the identity the shell was supposed to inject. Reading the app's default
        instead would make that check agree with itself by construction. */
    juce::String launchFaceOverride() const override { return walkFace(); }

    void firstPageLoaded(wizard::merged::PanelWindow& w) override {
        // The page has run its bundle, but React mounts on its own schedule.
        // A short settle beats racing the first paint: this is not a
        // performance test, and a flaky gate is worse than a slow one.
        juce::Timer::callAfterDelay(1500, [this, &w] {
            walk = std::make_unique<Walk>(w, [this](bool ok) {
                exitCode = ok ? 0 : 1;
                quit();
            });
            walk->start();
        });
    }

private:
    std::unique_ptr<Walk> walk;
};

int WalkApplication::exitCode = 1; // fail closed: a walk that never ran did not pass

} // namespace

JUCE_CREATE_APPLICATION_DEFINE(WalkApplication)

int main(int argc, char* argv[]) {
    // No window server (ssh without a session, a container, a CI box with no
    // logged-in user) is a SKIP, not a failure: this gate is about the running
    // app, and there is no app to speak of without somewhere to put a window.
    if (std::getenv("SSH_CONNECTION") != nullptr && std::getenv("DISPLAY") == nullptr) {
        std::printf("MergedWalk SKIPPED - no window server\n");
        return kExitSkip;
    }

    // A watchdog, because the likeliest failure here is a page that never
    // finishes loading — and a hung GUI binary under ctest is a build that hangs
    // forever instead of a gate that says something.
    juce::Timer::callAfterDelay(45000, [] {
        std::printf("MergedWalk FAILED - timed out before the walk completed\n");
        std::fflush(stdout);
        std::exit(1);
    });

    juce::JUCEApplicationBase::createInstance = &juce_CreateApplication;
    const int rc = juce::JUCEApplicationBase::main(argc, (const char**) argv);
    return rc != 0 ? rc : WalkApplication::exitCode;
}
