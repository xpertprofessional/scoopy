// P1 SPIKE — does a JUCE WebBrowserComponent host scoopy's real UI?
//
// TEMPORARY. This target exists to answer the four spike questions in
// docs/merge/P1-KICKOFF.md §3 and is deleted once the verdict is written. It is
// NOT the merged shell: it holds a STUB dispatcher (getCapabilities + a fake
// HotFrame), no engine, no device.
//
// It serves scoopy's COMMITTED webdist/ — the same bytes the shipping mac app
// runs — so what boots here is the real UI, not a reduction of it. scoopy's
// engineLink.ts already carries a dormant JuceLink that binds to
// window.__JUCE__.backend (merge P0-A); this is the backend it was waiting for.
//
// Evidence, not impressions: every finding the probe can establish without a
// human (OPFS, key-event fields, drag delivery, second-window boot) is emitted
// as a `slSpikeProbe` event and appended to a JSONL log, so the verdict rests
// on captured facts. Run with --probe to boot, capture, and quit.
#include <juce_gui_extra/juce_gui_extra.h>

#include "WebResources.h"

namespace {

// Must match scoopy web/protocol/schema.ts SCHEMA_VERSION. A mismatch is not
// silent: scoopy's debug panel renders "SCHEMA MISMATCH", which is itself a
// useful spike signal, so this is deliberately a plain constant rather than
// something clever that could paper over drift.
constexpr int kScoopySchemaVersion = 86;

// scoopy web/protocol/schema.ts HOT_FRAME_LENGTH (268 scalars + 16 spectrum).
constexpr int kHotFrameLength = 284;
constexpr int kHotFrameCounter = 0;   // HotFrameLayout.frameCounter
constexpr int kHotFrameOutputPeakL = 5;
constexpr int kHotFrameOutputPeakR = 6;
constexpr int kHotFrameCallbackLoad = 9;

std::optional<juce::WebBrowserComponent::Resource>
provideResource(const juce::String& path) {
    const juce::File root{SCOOPY_WEBDIST_DIR};
    auto payload = wizard::webresources::load(root, path);
    if (!payload.has_value()) return std::nullopt;
    const auto* bytes = static_cast<const std::byte*>(payload->data.getData());
    return juce::WebBrowserComponent::Resource{
        std::vector<std::byte>(bytes, bytes + payload->data.getSize()),
        payload->mimeType,
    };
}

/** Appends one probe record to the JSONL log. The log is the spike's output:
    an agent cannot see the screen (P1-KICKOFF law 5), so anything that is not
    written down here did not happen as far as the verdict is concerned. */
class ProbeLog {
public:
    explicit ProbeLog(const juce::File& fileToUse) : file(fileToUse) {
        file.getParentDirectory().createDirectory();
        file.deleteFile();
    }

    void write(const juce::String& source, const juce::var& payload) {
        auto* o = new juce::DynamicObject();
        o->setProperty("t", static_cast<juce::int64>(juce::Time::getMillisecondCounter()));
        o->setProperty("source", source);
        o->setProperty("payload", payload);
        file.appendText(juce::JSON::toString(juce::var(o), true) + "\n");
    }

    juce::File path() const { return file; }

private:
    juce::File file;
};

/** Injected before any page script, after window.__JUCE__.backend exists.

    Everything here reports through ONE fire-and-forget event (`slSpikeProbe`)
    rather than a native function: a probe must never be able to hang the page
    it is measuring, and an unresolved promise would do exactly that. */
juce::String probeUserScript(const juce::String& panel) {
    return juce::String(R"JS(
(() => {
  const send = (kind, data) => {
    try { window.__JUCE__.backend.emitEvent("slSpikeProbe", { kind, ...data }); } catch (e) {}
  };

  // The panel this webview is: scoopy reads window.__slPanel first (App.tsx),
  // which is how the mac shell gives each WKWebView its identity. The
  // multi-window question is whether that still works when the webviews are
  // JUCE DocumentWindows instead.
  window.__slPanel = "__PANEL__";

  // Q4 — OPFS. scoopy's browser companion keeps its library in OPFS, so
  // whether the JUCE webview has it decides if that code path survives the
  // merge or needs a native replacement.
  (async () => {
    const hasApi = typeof navigator?.storage?.getDirectory === "function";
    let opened = false, wrote = false, err = "";
    try {
      if (hasApi) {
        const dir = await navigator.storage.getDirectory();
        opened = !!dir;
        // Availability is not usability: a handle that cannot take a write is
        // no use to a sample library, so the probe actually writes.
        const fh = await dir.getFileHandle("spike-probe.txt", { create: true });
        const w = await fh.createWritable();
        await w.write("probe");
        await w.close();
        wrote = (await (await fh.getFile()).text()) === "probe";
        await dir.removeEntry("spike-probe.txt").catch(() => {});
      }
    } catch (e) { err = String(e && e.message ? e.message : e); }
    send("opfs", { hasApi, opened, wrote, err });
  })();

  // Q4b — OPFS writes OFF the main thread. WebKit ships createSyncAccessHandle
  // only inside a Worker, so "createWritable is missing" does not yet mean
  // "this webview cannot persist a library" — it means the main thread cannot.
  // Which of those two is true decides whether scoopy's OPFS library survives
  // the merge or has to be replaced by native file access.
  (async () => {
    let workerOk = false, syncWrote = false, err = "";
    try {
      // Per-panel filename: every webview in this app shares ONE origin and so
      // ONE OPFS store, and two sync access handles on one file is an error by
      // design. A shared name would report that contention as "OPFS is broken".
      const src = `self.onmessage = async () => {
        try {
          const dir = await navigator.storage.getDirectory();
          const fh = await dir.getFileHandle("spike-worker-__PANEL__.txt", { create: true });
          const h = await fh.createSyncAccessHandle();
          h.write(new TextEncoder().encode("probe"), { at: 0 });
          h.flush();
          const out = new Uint8Array(5);
          h.read(out, { at: 0 });
          h.close();
          await dir.removeEntry("spike-worker-__PANEL__.txt").catch(() => {});
          self.postMessage({ ok: new TextDecoder().decode(out) === "probe", err: "" });
        } catch (e) { self.postMessage({ ok: false, err: String((e && e.message) || e) }); }
      };`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      workerOk = true;
      const res = await new Promise((ok, fail) => {
        w.onmessage = (ev) => ok(ev.data);
        w.onerror = (e) => fail(new Error("worker error: " + e.message));
        setTimeout(() => fail(new Error("worker timeout")), 4000);
        w.postMessage("go");
      });
      syncWrote = res.ok; err = res.err;
      w.terminate();
    } catch (e) { err = String((e && e.message) || e); }
    send("opfs-worker", { workerOk, syncWrote, err });
  })();

  // Q1 — key-event fidelity. The Serato layout needs three things a webview
  // can each fail independently: event.code (physical key, so the binding
  // survives a non-US layout), event.repeat (auto-repeat must not retrigger a
  // cue), and matched keydown/keyup (a held key is a state, not an edge).
  const held = new Set();
  window.addEventListener("keydown", (e) => {
    held.add(e.code);
    send("keydown", {
      code: e.code, key: e.key, keyCode: e.keyCode, repeat: e.repeat,
      ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey,
      held: [...held], defaultPrevented: e.defaultPrevented,
    });
  }, true);
  window.addEventListener("keyup", (e) => {
    held.delete(e.code);
    send("keyup", { code: e.code, key: e.key, held: [...held] });
  }, true);

  // Q3 — drag-in. Logged from the WEB side; the native window logs the same
  // drop from the JUCE side. Which of the two fires (or neither) is the whole
  // answer: if the webview swallows the drag, a native FileDragAndDropTarget
  // never sees it and file drop has to be solved inside the page.
  for (const type of ["dragenter", "dragover", "drop"]) {
    window.addEventListener(type, (e) => {
      if (type === "dragover" || type === "drop") e.preventDefault();
      const items = e.dataTransfer ? [...e.dataTransfer.items].map((i) => i.kind + ":" + i.type) : [];
      const files = e.dataTransfer && e.dataTransfer.files
        ? [...e.dataTransfer.files].map((f) => f.name) : [];
      send("web-" + type, { items, files });
    }, true);
  }

  // The five JuceLink lanes, counted from the WEB side. The native side can
  // only prove it SENT; a lane is not wired until the page says it ARRIVED.
  const lanes = { slHotFrame: 0, slEvent: 0, slUiState: 0 };
  let firstFrameLen = -1, lastFrameCounter = -1, uiStateTopic = "", eventType = "";
  try {
    window.__JUCE__.backend.addEventListener("slHotFrame", (f) => {
      lanes.slHotFrame++;
      if (firstFrameLen < 0) firstFrameLen = Array.isArray(f) ? f.length : -2;
      if (Array.isArray(f)) lastFrameCounter = f[0];
    });
    window.__JUCE__.backend.addEventListener("slEvent", (e) => {
      lanes.slEvent++; eventType = (e && e.type) || "";
    });
    window.__JUCE__.backend.addEventListener("slUiState", (p) => {
      lanes.slUiState++; uiStateTopic = (p && p.topic) || "";
    });
    // Reverse lane (web → native): the coalesced param write. Proving it needs
    // a write to actually leave the page, so the probe sends one itself.
    window.__JUCE__.backend.emitEvent("slParam", { p: "deckVolume", deck: 0, v: 0.42 });
  } catch (e) {}
  setTimeout(() => send("lanes", {
    ...lanes, firstFrameLen, lastFrameCounter, uiStateTopic, eventType,
  }), 3000);

  // Boot facts: proof the page is the real bundle, talking to a real backend.
  window.addEventListener("error", (e) => send("pageerror", { message: String(e.message) }));
  window.addEventListener("unhandledrejection", (e) =>
    send("rejection", { reason: String(e.reason && e.reason.message ? e.reason.message : e.reason) }));
  const boot = () => send("boot", {
    panel: window.__slPanel,
    href: location.href,
    hasJuceBackend: typeof window.__JUCE__?.backend?.emitEvent === "function",
    ua: navigator.userAgent,
    // Did React actually mount? An empty #root means the bundle loaded and
    // then died, which looks identical to "it works" from the native side.
    rootChildren: document.getElementById("root")?.childElementCount ?? -1,
    crossOriginIsolated: window.crossOriginIsolated,
    hasAudioWorklet: typeof AudioWorklet !== "undefined",
  });
  if (document.readyState === "complete") setTimeout(boot, 500);
  else window.addEventListener("load", () => setTimeout(boot, 500));
})();
)JS").replace("__PANEL__", panel);
}

} // namespace

/** One spike window: a DocumentWindow whose content is the whole scoopy UI.
    Two of these is the multi-window question (Q2) in its simplest honest form —
    scoopy's panels are independent React roots, so a second window is a second
    page with its own backend, not a second view of one page. */
class SpikeWindow final : public juce::DocumentWindow,
                          public juce::FileDragAndDropTarget,
                          private juce::Timer {
public:
    SpikeWindow(const juce::String& panel, ProbeLog& logToUse, juce::Point<int> topLeft)
        : juce::DocumentWindow("Spike · " + panel, juce::Colours::black,
                               juce::DocumentWindow::allButtons),
          probe(logToUse),
          panelName(panel) {
        webView = std::make_unique<juce::WebBrowserComponent>(
            juce::WebBrowserComponent::Options{}
                .withNativeIntegrationEnabled()
                .withResourceProvider(provideResource)
                .withUserScript(probeUserScript(panel))
                .withNativeFunction(
                    "slCommand",
                    [this](const juce::Array<juce::var>& args,
                           juce::WebBrowserComponent::NativeFunctionCompletion complete) {
                        const auto method = args.size() > 0 ? args[0].toString() : juce::String();
                        complete(stubReply(method));
                    })
                // Coalesced live control writes, web → native. Logged so the
                // spike can show the param lane is real, not just wired.
                .withEventListener("slParam", [this](juce::var payload) {
                    if (++paramWrites <= 20) probe.write("slParam/" + panelName, payload);
                })
                .withEventListener("slSpikeProbe", [this](juce::var payload) {
                    probe.write(panelName, payload);
                }));

        setUsingNativeTitleBar(true);
        setContentNonOwned(webView.get(), false);
        setResizable(true, false);
        setTopLeftPosition(topLeft.x, topLeft.y);
        setSize(1100, 720);
        setVisible(true);
        webView->goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
        startTimerHz(30);

        // The two push lanes scoopy's UI subscribes to but which nothing in the
        // boot path would otherwise exercise. Sent once the page has mounted —
        // an event emitted before the listener exists proves nothing.
        juce::Timer::callAfterDelay(1500, [this] {
            if (webView == nullptr) return;
            auto* evt = new juce::DynamicObject();
            evt->setProperty("type", "settingChanged");
            evt->setProperty("key", "spike.probe");
            webView->emitEventIfBrowserIsVisible("slEvent", juce::var(evt));

            auto* st = new juce::DynamicObject();
            st->setProperty("hasImage", false);
            auto* ui = new juce::DynamicObject();
            ui->setProperty("topic", "background");
            ui->setProperty("state", juce::var(st));
            webView->emitEventIfBrowserIsVisible("slUiState", juce::var(ui));
        });
    }

    ~SpikeWindow() override { stopTimer(); }

    void closeButtonPressed() override {
        juce::JUCEApplication::getInstance()->systemRequestedQuit();
    }

    // Q3, native half. If these fire, JUCE sees the drag and a native handler
    // is available; if only the web half fires, the page owns file drop.
    bool isInterestedInFileDrag(const juce::StringArray&) override { return true; }
    void filesDropped(const juce::StringArray& files, int, int) override {
        auto* o = new juce::DynamicObject();
        juce::Array<juce::var> arr;
        for (const auto& f : files) arr.add(f);
        o->setProperty("kind", "native-filesDropped");
        o->setProperty("files", juce::var(arr));
        probe.write(panelName, juce::var(o));
    }

private:
    /** The stub. `getCapabilities` is answered for real because the whole UI
        gates on it; everything else fails honestly. scoopy's boot path catches
        its own rejections (tokens, midi-learn, scene-pins and capabilities all
        swallow errors), so an honest failure is what a not-yet-built command
        should look like — never a fake success that would make the spike
        report a working app that cannot exist yet. */
    juce::var stubReply(const juce::String& method) {
        if (++commandCount <= 40) {
            auto* rec = new juce::DynamicObject();
            rec->setProperty("kind", "slCommand");
            rec->setProperty("method", method);
            probe.write(panelName, juce::var(rec));
        }
        auto* env = new juce::DynamicObject();
        if (method == "getCapabilities") {
            auto* caps = new juce::DynamicObject();
            caps->setProperty("schemaVersion", kScoopySchemaVersion);
            caps->setProperty("pluginHosting", false);
            caps->setProperty("fileSystem", false);
            caps->setProperty("midiHardware", false);
            caps->setProperty("audioDeviceSelection", false);
            caps->setProperty("returnFx", false);
            env->setProperty("ok", true);
            env->setProperty("result", juce::var(caps));
        } else {
            env->setProperty("ok", false);
            env->setProperty("error", "spike stub: " + method + " is not implemented");
        }
        return juce::var(env);
    }

    /** The fake HotFrame: a real-shaped 284-slot frame at 30 Hz, with a moving
        counter and a slow sine on the output meters so a live UI is visibly
        live rather than merely painted. */
    void timerCallback() override {
        ++frameCounter;
        juce::Array<juce::var> values;
        values.ensureStorageAllocated(kHotFrameLength);
        for (int i = 0; i < kHotFrameLength; ++i) values.add(0.0);
        const auto phase = static_cast<double>(frameCounter) * 0.05;
        values.set(kHotFrameCounter, static_cast<double>(frameCounter));
        values.set(kHotFrameOutputPeakL, 0.5 + 0.45 * std::sin(phase));
        values.set(kHotFrameOutputPeakR, 0.5 + 0.45 * std::sin(phase * 1.3));
        values.set(kHotFrameCallbackLoad, 0.2);
        webView->emitEventIfBrowserIsVisible("slHotFrame", juce::var(values));
    }

    ProbeLog& probe;
    juce::String panelName;
    int commandCount = 0;
    int paramWrites = 0;
    juce::int64 frameCounter = 0;
    std::unique_ptr<juce::WebBrowserComponent> webView;
};

class SpikeApplication final : public juce::JUCEApplication {
public:
    const juce::String getApplicationName() override { return "ScoopySpike"; }
    const juce::String getApplicationVersion() override { return "0.0.1"; }

    void initialise(const juce::String& commandLine) override {
        const auto logFile =
            juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                .getChildFile("wizard-spike-probe.jsonl");
        probe = std::make_unique<ProbeLog>(logFile);

        auto* start = new juce::DynamicObject();
        start->setProperty("kind", "spike-start");
        start->setProperty("webdist", SCOOPY_WEBDIST_DIR);
        start->setProperty("webdistExists",
                           juce::File{SCOOPY_WEBDIST_DIR}.getChildFile("index.html").existsAsFile());
        start->setProperty("commandLine", commandLine);
        probe->write("app", juce::var(start));

        // The second window is the multi-window probe, not decoration: it is a
        // separate page (its own React root, its own JuceLink) and the question
        // is whether two of them coexist with live backends.
        windows.push_back(std::make_unique<SpikeWindow>("debug", *probe, juce::Point<int>{60, 60}));
        if (!commandLine.contains("--single-window"))
            windows.push_back(std::make_unique<SpikeWindow>("grid", *probe, juce::Point<int>{220, 220}));

        // --probe: boot, let the page settle, write the log, quit. This is what
        // makes the spike's answers reproducible instead of anecdotal.
        if (commandLine.contains("--probe")) {
            // A human pass needs the window to stay up long enough to press
            // keys and drag a file into it, so the dwell is a parameter.
            const auto seconds =
                commandLine.contains("--probe-seconds=")
                    ? commandLine.fromFirstOccurrenceOf("--probe-seconds=", false, false)
                          .initialSectionContainingOnly("0123456789")
                          .getIntValue()
                    : 8;
            juce::Timer::callAfterDelay(seconds * 1000, [] {
                juce::JUCEApplication::getInstance()->systemRequestedQuit();
            });
        }
    }

    void shutdown() override {
        if (probe != nullptr) {
            auto* end = new juce::DynamicObject();
            end->setProperty("kind", "spike-end");
            probe->write("app", juce::var(end));
        }
        windows.clear();
        probe.reset();
    }

private:
    std::unique_ptr<ProbeLog> probe;
    std::vector<std::unique_ptr<SpikeWindow>> windows;
};

START_JUCE_APPLICATION(SpikeApplication)
