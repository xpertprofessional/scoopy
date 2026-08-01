#include "ScoopyPluginProcessor.h"

#include "MergedApp.h" // kScoopySchemaVersion — ONE constant, gated by schema:check
#include "ScoopyPluginEditor.h"
#include "SlWorldApply.h"
#include "sl_engine.h"

#include <cmath>

namespace wizard::plugin {

namespace {

juce::var okEnvelope(juce::var result = juce::var(new juce::DynamicObject())) {
    auto* env = new juce::DynamicObject();
    env->setProperty("ok", true);
    env->setProperty("result", result);
    return juce::var(env);
}

} // namespace

juce::AudioProcessor::BusesProperties ScoopyPluginProcessor::makeBuses() {
    BusesProperties buses;
    // "Record In": the DAW routes anything here and the tape decks record it
    // beat-synced — the deviceInput of a host with no device.
    buses = buses.withInput("Record In", juce::AudioChannelSet::stereo(), true);
    // ALL STEREO — including the mono-lane sends. Logic refuses to lay out a
    // multi-output instrument with a mono aux and the editor comes up empty
    // (see kOutputBuses). The mono lane is mirrored L→R after the render.
    for (int i = 0; i < kNumOutputBuses; ++i)
        buses = buses.withOutput(kOutputBuses[i].name, juce::AudioChannelSet::stereo(),
                                 i == 0); // Main enabled by default; auxes opt-in
    return buses;
}

ScoopyPluginProcessor::ScoopyPluginProcessor()
    : juce::AudioProcessor(makeBuses()) {
    // Rate is corrected in prepareToPlay; 44.1k/512 just makes a processor
    // constructed-but-never-prepared (pluginval does this) well-defined.
    engine = sl_engine_create(44100.0, 512, wizard::merged::kScoopySchemaVersion);
    jassert(engine != nullptr);
    jassert(sl_abi_version() == SL_ABI_VERSION);

    // D-SL-DECKPLUGIN-01: no hidden limiter on a plugin output — the DAW's
    // chain is the protection layer here. The APP keeps its watchdog.
    if (engine != nullptr) sl_watchdog_set_enabled(engine, 0);

    // EVERY RETURN IS EXTERNAL HERE, and this is the line that makes the send
    // buses carry anything at all.
    //
    // The core defaults each return to HOST PLUGIN mode, where the send is fed
    // to a hosted effect and its wet is summed into main. ScoopyDeck hosts no
    // plugins by decision, so that effect can never exist: every send was being
    // consumed by a slot that would stay empty forever, and all four Send output
    // buses read silent with nothing anywhere to say why. In external mode the
    // send leaves on its own lane instead — which is the whole architecture
    // D-SL-DECKPLUGIN-02 · D1 settled on. The DAW track you route it into IS
    // the return, and it is also why `services.externalReturns` is true.
    if (engine != nullptr)
        for (uint32_t r = 1; r <= 4; ++r) sl_return_set_external(engine, r, 1);

    // Warm the stretchers inside prepareToPlay rather than behind it. Set here,
    // BEFORE any configure that matters: a DAW may roll the transport the
    // instant prepareToPlay returns, and a bus still warming is on its dry path
    // — the deck would play at its own tempo for a moment and then snap to the
    // host's, which reads as a bug in the sync rather than in the warm-up.
    if (engine != nullptr) sl_engine_set_sync_stretch_warmup(engine, 1);

    backend = std::make_unique<PluginBackend>(engine, "ScoopyDeck");

    // The pump that must survive a closed editor (tempo follow, transport
    // edges). 40 Hz ≈ the shipping app's 25 ms sync debounce.
    startTimerHz(40);
}

ScoopyPluginProcessor::~ScoopyPluginProcessor() {
    stopTimer();
    // Same teardown law as the app's shutdown(): hosted-plugin slots die
    // synchronously on the message thread BEFORE the engine that owns them.
    // With no plugin-in-plugin this is the stub's no-op — kept anyway so the
    // ordering survives if that ruling is ever revisited.
    if (engine != nullptr) sl_fx_teardown(engine);
    backend.reset();
    if (engine != nullptr) { sl_engine_destroy(engine); engine = nullptr; }
}

void ScoopyPluginProcessor::prepareToPlay(double sampleRate, int samplesPerBlock) {
    juce::ignoreUnused(samplesPerBlock);
    if (engine == nullptr) return;
    // The D-WZ-RATE-01 rebuild, verbatim from SlRenderSink::setSampleRate:
    // the engine refuses a rate change while running, so stop → set → start.
    // prepareToPlay is guaranteed non-concurrent with processBlock, which is
    // the "device callback detached" precondition the contract names.
    sl_engine_stop(engine);
    // CHECKED, because the failure is silent and total: a refused rate change
    // leaves the whole session rendering at the wrong rate — wrong pitch AND
    // wrong tempo — and a failed start is silence. Both return a status
    // precisely so the host can notice, and jassert makes a debug build say so.
    const bool rateOk = sl_engine_set_sample_rate(engine, sampleRate) == 1;
    jassert(rateOk);
    const bool startOk = sl_engine_start(engine) == 1;
    jassert(startOk);
    if (!rateOk || !startOk)
        juce::Logger::writeToLog("ScoopyDeck: engine refused " + juce::String(sampleRate) +
                                 " Hz (rate " + (rateOk ? "ok" : "FAILED") + ", start " +
                                 (startOk ? "ok" : "FAILED") + ")");

    const auto engineBlock = sl_engine_max_block_frames(engine);
    laneMap.prepare(engineBlock);
    inScratch.assign((size_t) 2 * engineBlock, 0.0f);

    reportedMode = -1; // force a re-read: latency is in FRAMES and the rate moved
    updateLatency();
}

/** PDC, mode-scoped on purpose (D-SL-DECKPLUGIN-01).
 *
 * The stretch bus carries its group delay whenever it is engaged, unity ratio
 * included — so a host that reported "actual" latency would flap every time
 * the user nudged the DAW's tempo onto and off the session's, and the DAW
 * would re-compensate mid-performance. Reporting per MODE instead is stable:
 * it changes only when the user switches timePitch/timeStretch/tempoOnly,
 * which is a deliberate act, not a side effect of playing.
 *
 * The cost is honest and bounded: in timeStretch at a unity ratio the deck is
 * bypassed but still reports ~116 ms, so it sits later in the timeline than it
 * strictly needs to. Varispeed and tempoOnly report zero because they have no
 * group delay at all.
 */
void ScoopyPluginProcessor::updateLatency() {
    if (engine == nullptr) return;
    const int mode = sync.currentRecipe().tempoMode;
    if (mode == reportedMode) return;
    reportedMode = mode;

    constexpr int kTempoModeTimeStretch = 1; // sl_engine.h §3
    const int frames =
        mode == kTempoModeTimeStretch
            ? (int) sl_deck_stretch_latency_frames(engine, 0)
            : 0;
    setLatencySamples(frames);
}

bool ScoopyPluginProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
    const auto in = layouts.getMainInputChannelSet();
    if (!in.isDisabled() && in != juce::AudioChannelSet::stereo()) return false;
    // Stereo for every aux, and mono ALSO accepted on the sends whose engine
    // lane is genuinely mono — a host that asks for the narrower shape should
    // get it rather than be refused, which is how the multi-out variant broke.
    for (int i = 1; i < kNumOutputBuses; ++i) {
        const auto set = layouts.getChannelSet(false, i);
        if (set.isDisabled() || set == juce::AudioChannelSet::stereo()) continue;
        if (kOutputBuses[i].monoLane && set == juce::AudioChannelSet::mono()) continue;
        return false;
    }
    return true;
}

void ScoopyPluginProcessor::processBlock(juce::AudioBuffer<float>& buffer,
                                         juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;

    // DAW MIDI IN → the ring (see the header). Channel-voice messages only:
    // clock and sysex would flood a 256-slot ring and nothing consumes them.
    //
    // ⚠️ FILTERED ON THE RAW BYTES, NEVER VIA getMessage(). A juce::MidiMessage
    // stores its payload inline only up to 8 bytes and MALLOCS beyond that —
    // so constructing one just to ask what it is allocates on the audio thread
    // for exactly the traffic we are about to discard (a controller's sysex
    // handshake, MTC full-frame, MMC). The filter has to happen before any
    // MidiMessage exists, not after.
    for (const auto meta : midi) {
        if (meta.numBytes < 3) continue;
        const auto* raw = meta.data;
        const auto type = (uint8_t) (raw[0] & 0xF0);
        // note-off / note-on / CC / pitch-bend. 0xF0+ (system) never reaches
        // here because those all fail the type test.
        if (type != 0x80 && type != 0x90 && type != 0xB0 && type != 0xE0) continue;
        const auto w = midiWrite.load(std::memory_order_relaxed);
        // DROP-NEWEST when full. The alternative — overwriting the oldest —
        // would let a stuck controller silently evict the note-offs already
        // queued behind it, and a hung note is worse than a missed CC.
        if (w - midiRead.load(std::memory_order_acquire) >= (uint32_t) kMidiRingSize) break;
        midiRing[w % kMidiRingSize] = {raw[0], raw[1], raw[2]};
        midiWrite.store(w + 1, std::memory_order_release);
    }
    midi.clear(); // MIDI OUT is v2; nothing passes through until then

    sync.capture(getPlayHead(), engine);

    const int numSamples = buffer.getNumSamples();

    // The Dekker half of the render-detach guard (see withRenderDetached in
    // the header comments): announce first, THEN check the mute.
    renderActive.store(true, std::memory_order_seq_cst);
    // `inScratch` empty means prepareToPlay has not sized our buffers. JUCE
    // guarantees it is called first, but a host that renders anyway would
    // otherwise have the engine write 26 lanes into a zero-length scratch
    // vector — an out-of-bounds write on the audio thread, i.e. a crash in
    // someone's session rather than an error we could report.
    if (engine == nullptr || inScratch.empty() ||
        renderMuted.load(std::memory_order_seq_cst) ||
        sl_engine_max_block_frames(engine) == 0) {
        renderActive.store(false, std::memory_order_seq_cst);
        buffer.clear();
        return;
    }

    const int engineBlock = (int) sl_engine_max_block_frames(engine);

    // Input bus (may be disabled → zero channels).
    auto inView = getBusBuffer(buffer, true, 0);
    const int inCh = juce::jmin(2, inView.getNumChannels());

    for (int offset = 0; offset < numSamples;) {
        const int chunk = juce::jmin(numSamples - offset, engineBlock);

        // Copy the input chunk out FIRST: in-place plugin buffers alias
        // Record-In onto Main-out, and the engine writes main while it reads
        // input — the aliasing the device path never had.
        const float* ins[2] = {nullptr, nullptr};
        for (int c = 0; c < inCh; ++c) {
            auto* dst = inScratch.data() + (size_t) c * (size_t) engineBlock;
            std::memcpy(dst, inView.getReadPointer(c) + offset,
                        (size_t) chunk * sizeof(float));
            ins[c] = dst;
        }

        sl_render_io(engine, ins, (uint32_t) inCh,
                     laneMap.build(*this, buffer, offset), laneCount,
                     (uint32_t) chunk);
        // Mirror the mono send lanes into their right channels now the engine
        // has written them, or every send bus is silent on one side.
        laneMap.finish(*this, buffer, offset, chunk);
        offset += chunk;
    }

    renderActive.store(false, std::memory_order_seq_cst);
}

// ── Message-thread half ──────────────────────────────────────────────────────

void ScoopyPluginProcessor::pumpHostSync() {
    // Same lock as the state I/O: this path also runs applyWorld and reads
    // `lastWorld`, and the host restores state on a thread of its choosing.
    const juce::ScopedLock sl(stateLock);
    // ⚠️ ONE TEMPO AUTHORITY AT A TIME.
    //
    // With the editor open the WEB owns the sync ratio: djSyncLaw is the
    // golden-pinned law and it knows things this pump does not — the pulse
    // relation, the nudge under a hand, the per-element mode. It computes the
    // ratio against a master tempo that IS the host's (the plugin feeds
    // `hostTransport` into the map's masterBpm) and writes it through slDeck.
    //
    // If this pump also wrote syncRatio, the two would take turns stamping
    // different numbers onto the same deck at 40 Hz — a deck that audibly
    // wobbles between two tempi, from code where each side looks correct
    // alone. So the pump DEFERS while there is an editor, and takes over when
    // there is not: a DAW playing a closed-editor project must still follow
    // its tempo, which is the whole reason this lives on the processor.
    const bool webOwnsTempo = getActiveEditor() != nullptr;
    if (sync.pump(engine, /*writeRatio=*/!webOwnsTempo))
        applyCachedWorld(sync.snapshot().playing);
    // A mode switch arrives through hostSyncConfig, not through the playhead,
    // so PDC is refreshed here rather than in the pump's ratio path.
    updateLatency();
    drainMidi();
}

void ScoopyPluginProcessor::drainMidi() {
    auto* ed = getActiveEditor();
    const auto w = midiWrite.load(std::memory_order_acquire);
    auto r = midiRead.load(std::memory_order_relaxed);
    if (r == w) return;

    // ⚠️ DRAIN EVEN WITH NO EDITOR. The events have nowhere to go — the engine
    // has no MIDI surface — but leaving them queued would mean the ring is
    // already full of stale notes the moment somebody opens the window, and
    // they would all fire at once. Dropping them is the honest behaviour.
    if (ed == nullptr) {
        midiRead.store(w, std::memory_order_release);
        return;
    }

    juce::Array<juce::var> events;
    for (; r != w; ++r) {
        const auto e = midiRing[r % kMidiRingSize];
        auto* o = new juce::DynamicObject();
        o->setProperty("status", (int) (e.status & 0xF0));
        o->setProperty("channel", (int) (e.status & 0x0F));
        o->setProperty("data1", (int) e.data1);
        o->setProperty("data2", (int) e.data2);
        events.add(juce::var(o));
    }
    midiRead.store(w, std::memory_order_release);

    if (emitToEditor == nullptr) return;
    auto* payload = new juce::DynamicObject();
    payload->setProperty("type", "hostMidi");
    payload->setProperty("events", events);
    emitToEditor("slEvent", juce::var(payload));
}

void ScoopyPluginProcessor::withRenderDetached(const std::function<void()>& fn) {
    // Dekker pair with processBlock: raise the mute, wait out any render
    // already in flight (≤ one host block), then the swap runs against a
    // detached render — the sl_engine.h §5 precondition a plugin cannot meet
    // by stopping a device it does not own.
    renderMuted.store(true, std::memory_order_seq_cst);
    while (renderActive.load(std::memory_order_seq_cst))
        juce::Thread::sleep(1);
    fn();
    renderMuted.store(false, std::memory_order_seq_cst);
}

/** PHASE, not just tempo.
 *
 * Following the host's tempo only gets you half of "in sync": a deck that
 * always starts at step 0 whenever the DAW happens to hit play runs at the
 * right speed but sits at a fixed offset from the host's bar grid — its beats
 * land between the DAW's beats, forever, and no amount of tempo matching
 * closes that gap.
 *
 * The engine already carries the fix: a world publish takes `startStep`, and
 * the step clock is 4 steps to the quarter note (framesPerStep = sr·60/(bpm·4),
 * NativeAudioEngineCore.cpp). So the host's PPQ position names the step the
 * deck should come in on, and the deck lands ON the grid instead of beside it.
 *
 * ⚠️ Precision is bounded by the pump, not by this arithmetic. The transport
 * edge is noticed on the ~40 Hz message pump, so the start can be up to ~25 ms
 * late — the deck is on the right STEP but can be slightly behind the host's
 * sample-exact boundary. Closing that needs the launch decision to happen
 * inside the audio callback (an `sl_deck_request_launch_at`-shaped ABI add);
 * measured and written up rather than assumed — see plugin_processor_test §2e.
 */
uint64_t ScoopyPluginProcessor::armHostQuantizedLaunch(double quantumBeats) {
    if (engine == nullptr) return 0;
    // A non-positive or non-finite quantum is a division by nothing, not
    // "launch now" — refused, the discipline the rest of this surface uses.
    if (!(quantumBeats > 0.0) || !std::isfinite(quantumBeats)) return 0;

    const auto s = sync.snapshot();
    // The ENGINE's rate, not `getSampleRate()`. The latter is set by JUCE's
    // format wrapper, not by our own prepareToPlay — so it reads 0 in any
    // context that drives the processor directly (every headless gate, and
    // pluginval's harness), and the arm would refuse for a reason that has
    // nothing to do with the host's grid. The engine's rate is the one we
    // configured and is authoritative wherever the deck can make a sound.
    const double sr = sl_engine_sample_rate(engine);
    // No playhead, a stopped host, or a tempo we cannot trust: there is no grid
    // to land on. Refuse rather than invent one — the caller launches now, which
    // is the honest behaviour when there is nothing to wait for.
    if (!s.valid || !s.playing || !(s.bpm > 0.0) || !(sr > 0.0)) return 0;

    // The next boundary STRICTLY ahead, so arming while sitting exactly on one
    // does not fire in the past — a fraction of a beat of latency beats a
    // launch that resolves behind the playhead.
    const double grid = std::floor(s.ppq / quantumBeats) + 1.0;
    const double targetPpq = grid * quantumBeats;

    // ppq → seconds → frames, through the SAME anchor `capture()` recorded, so
    // the age of the snapshot cannot skew the result.
    const double beatsAway = targetPpq - s.ppq;
    const double framesAway = beatsAway * (60.0 / s.bpm) * sr;
    if (!std::isfinite(framesAway) || framesAway < 0.0) return 0;

    const auto target = s.engineTime + static_cast<uint64_t>(std::llround(framesAway));
    if (target == 0) return 0; // the ABI's "nothing armed" sentinel
    sl_deck_request_launch_at_frame(engine, 0, target);
    return target;
}

int ScoopyPluginProcessor::hostAlignedStartStep() const {
    const auto s = sync.snapshot();
    if (!s.valid || !sync.currentRecipe().syncEnabled) return 0;

    auto* obj = lastWorld.getDynamicObject();
    if (obj == nullptr) return 0;
    const auto* tracks = obj->getProperty("tracks").getArray();
    if (tracks == nullptr || tracks->isEmpty()) return 0;

    // The pattern's length in steps: the longest track wins, so a session with
    // ragged track lengths still wraps on the bar the user sees.
    int stepCount = 0;
    for (const auto& t : *tracks)
        if (const auto* steps = t.getProperty("steps", juce::var()).getArray())
            stepCount = juce::jmax(stepCount, steps->size());
    if (stepCount <= 0) return 0;

    constexpr double kStepsPerQuarter = 4.0; // 16ths — the engine's own step law
    const double stepPos = s.ppq * kStepsPerQuarter;
    // Negative PPQ is legal (a DAW pre-roll / count-in), so floor + a positive
    // modulo rather than a truncating cast, which would mirror around zero.
    const auto floored = (int64_t) std::floor(stepPos);
    const auto wrapped = ((floored % stepCount) + stepCount) % stepCount;
    return (int) wrapped;
}

void ScoopyPluginProcessor::applyCachedWorld(bool playing) {
    auto* obj = lastWorld.getDynamicObject();
    if (obj == nullptr || engine == nullptr) return; // nothing published yet — nothing to start
    auto copy = obj->clone();
    copy->setProperty("isPlaying", playing);
    // Only on the way IN: a stop does not need a position, and writing one
    // would move the playhead under a user who is about to hit play again.
    if (playing) {
        lastStartStep = hostAlignedStartStep();
        copy->setProperty("startStep", lastStartStep);
    }
    wizard::sl::applyWorld(engine, juce::var(copy.release()));
}

juce::var ScoopyPluginProcessor::dispatchFromUi(const juce::String& method,
                                                const juce::var& params) {
    // It journals samples and caches `lastWorld` — the same state the host can
    // be restoring on another thread. Same lock as the state I/O.
    const juce::ScopedLock sl(stateLock);
    // hostSyncConfig: the web tier's resolved sync recipe (djSyncLaw stays the
    // tempo authority — this is its OUTPUT, not a second law). Not in
    // SlDispatch: the app host has no recipe sink, and a v0 method the schema
    // does not know yet stays out of the gated surface until v1 adds it.
    if (method == "hostSyncConfig") {
        auto r = sync.currentRecipe();
        if (params.hasProperty("sessionBpm")) r.sessionBpm = (double) params["sessionBpm"];
        if (params.hasProperty("tempoMode")) r.tempoMode = (int) params["tempoMode"];
        if (params.hasProperty("pulseMultiplier")) r.pulseMultiplier = (double) params["pulseMultiplier"];
        if (params.hasProperty("syncEnabled")) r.syncEnabled = (bool) params["syncEnabled"];
        if (params.hasProperty("followTransport")) r.followTransport = (bool) params["followTransport"];
        // 0 = follow the host's tempo; positive = the user's internal master (D2).
        if (params.hasProperty("masterBpm")) r.masterBpm = (double) params["masterBpm"];
        sync.setRecipe(r);

        // REPLY WITH THE EFFECTIVE RECIPE, so the call doubles as a read.
        // The editor mounts with its own defaults, but the recipe may have been
        // RESTORED from the DAW project a moment earlier (it rides the state
        // chunk) — without a way to read it back, opening the window would
        // quietly stamp `followTransport: true` over a project saved with the
        // internal clock. Sending `{}` is therefore a pure read.
        auto* out = new juce::DynamicObject();
        out->setProperty("sessionBpm", r.sessionBpm);
        out->setProperty("tempoMode", r.tempoMode);
        out->setProperty("pulseMultiplier", r.pulseMultiplier);
        out->setProperty("syncEnabled", r.syncEnabled);
        out->setProperty("followTransport", r.followTransport);
        out->setProperty("masterBpm", r.masterBpm);
        return okEnvelope(juce::var(out));
    }

    // pluginSession: which document THIS instance holds. Written when the page
    // opens one, read back on boot so a reloaded project restores the same
    // session rather than manufacturing an Untitled over it. `{}` is a pure
    // read, same contract as hostSyncConfig.
    if (method == "pluginSession") {
        if (params.hasProperty("name")) sessionName = params["name"].toString();
        auto* out = new juce::DynamicObject();
        // Explicit null rather than an omitted key: "this instance has never
        // held a session" is a state the page must be able to tell apart from
        // "the reply was malformed", because the two want opposite behaviour.
        out->setProperty("name", sessionName.isEmpty() ? juce::var() : juce::var(sessionName));
        return okEnvelope(juce::var(out));
    }

    // deckLaunch: arm a launch on the HOST's grid (D-SL-DECKPLUGIN-03, step 3).
    //
    // `quantumBeats` is the musical boundary to land on — 4 = a bar of 4/4.
    // Replies with the absolute engine frame armed, or 0 when there was no grid
    // to land on (no playhead, a stopped host, a nonsense quantum). ZERO IS NOT
    // AN ERROR: it means "nothing to wait for", and the caller should let the
    // deck play now rather than leave it held forever — the distinction the
    // web's own `armOrPlay` already draws four different ways.
    if (method == "deckLaunch") {
        const double beats = params.hasProperty("quantumBeats")
                                 ? (double) params["quantumBeats"]
                                 : 0.0;
        auto* out = new juce::DynamicObject();
        // A double, not an int64: JSON has no 64-bit integer and juce::var's
        // int is 32-bit — a frame counter overflows that in ~12 hours at 48k.
        // Doubles carry frame counts exactly to 2^53, which is 5700 years.
        out->setProperty("frame", (double) armHostQuantizedLaunch(beats));
        return okEnvelope(juce::var(out));
    }

    // editorSize: the web tier telling us PERF was armed or released, so the
    // WINDOW can change shape with the view (§5). The sizes themselves live
    // here rather than in the page because they must survive a closed editor —
    // they ride the state chunk, like the sync recipe above.
    //
    // `{}` is a pure read, same contract as hostSyncConfig.
    if (method == "editorSize") {
        // EXPLICIT SIZE from the page's own grip. The second half of the resize
        // answer: the reclaimed corner is the platform-standard affordance, but
        // a host that refuses to let a plugin window grow leaves it inert, and
        // some do. This path goes through `setSize` on the editor, which the
        // wrapper honours in more hosts than a user-drag on the corner does.
        // Clamped to the editor's own limits so the page cannot ask for a
        // window the constrainer will refuse and end up with nothing happening.
        //
        // ⚠️ There was briefly a `perform` arm here that swapped between two
        // remembered sizes on the PERF edge. Removed 2026-08-01: PERF is a
        // POINTER MODE for locator dragging, and arming a gesture must not move
        // the user's window.
        if (params.hasProperty("width") && params.hasProperty("height")) {
            editorW = juce::jlimit(720, 3000, (int) params["width"]);
            editorH = juce::jlimit(480, 2000, (int) params["height"]);
            if (resizeEditor) resizeEditor(editorW, editorH);
        }
        auto* out = new juce::DynamicObject();
        out->setProperty("width", editorW);
        out->setProperty("height", editorH);
        return okEnvelope(juce::var(out));
    }

    // Journal every sample the UI registers, so the project can rebuild itself
    // with no editor running (see CachedSample in the header).
    if (method == "slWorld" &&
        params.getProperty("action", juce::var()).toString() == "registerSample")
        captureSample(params);

    // Cache every published world: transport follow re-applies it with
    // isPlaying flipped, and the session's own bpm is the sync denominator.
    const bool isWorldPublish =
        method == "worldPublish" ||
        (method == "slWorld" && params.getProperty("action", juce::var()).toString() == "publish");
    if (isWorldPublish) {
        const auto world = params.getProperty("world", juce::var());
        if (world.getDynamicObject() != nullptr) {
            lastWorld = world;
            const double bpm = (double) world.getProperty("bpm", 0.0);
            if (bpm > 0.0) {
                auto r = sync.currentRecipe();
                r.sessionBpm = bpm;
                sync.setRecipe(r);
            }
        }
    }

    return wizard::sl::dispatch(method, params, backend->settings, engine,
                                &backend->services);
}

// ── The replay journal ──────────────────────────────────────────────────────

void ScoopyPluginProcessor::captureSample(const juce::var& params) {
    const auto id = params.getProperty("id", juce::var()).toString();
    const auto* left = params.getProperty("left", juce::var()).getArray();
    if (id.isEmpty() || left == nullptr || left->isEmpty()) return;

    CachedSample s;
    s.id = id;
    s.rate = (double) params.getProperty("sampleRate", 48000.0);
    s.left.reserve((size_t) left->size());
    for (const auto& v : *left) s.left.push_back((float) (double) v);
    if (const auto* right = params.getProperty("right", juce::var()).getArray();
        right != nullptr && right->size() == left->size()) {
        s.right.reserve((size_t) right->size());
        for (const auto& v : *right) s.right.push_back((float) (double) v);
    }

    // Re-registering an id REPLACES it, matching the engine's own semantics —
    // otherwise a kit swap would grow the project file without bound.
    for (auto& existing : samples)
        if (existing.id == s.id) { existing = std::move(s); return; }
    samples.push_back(std::move(s));
}

void ScoopyPluginProcessor::replayJournal() {
    if (engine == nullptr) return;
    // ORDER MATTERS: a world naming a sample the engine has not been given
    // renders silence that looks exactly like a broken engine, so every sample
    // goes in first.
    for (const auto& s : samples)
        sl_engine_register_sample(engine, s.id.toRawUTF8(), s.left.data(),
                                  s.right.empty() ? nullptr : s.right.data(),
                                  (uint32_t) s.left.size(), s.rate);
    if (lastWorld.getDynamicObject() != nullptr)
        wizard::sl::applyWorld(engine, lastWorld);
    updateLatency();
}

// ── State: a binary chunk, gzipped ──────────────────────────────────────────
//
// NOT JSON end to end. The world and the recipe are JSON (small, and readable
// in a crash dump), but sample PCM is written as raw float32: as JSON numbers
// the same audio costs roughly ten bytes of text per four bytes of sound, and
// the user asked for self-contained projects — which only stays reasonable if
// the audio is stored as audio.

namespace {
constexpr const char* kChunkMagic = "SCDK";
constexpr int kChunkVersion = 2; // 1 was v0's plain-JSON, world+recipe only
} // namespace

void ScoopyPluginProcessor::getStateInformation(juce::MemoryBlock& destData) {
    const juce::ScopedLock sl(stateLock); // see setStateInformation
    auto* index = new juce::DynamicObject();
    {
        juce::Array<juce::var> list;
        for (const auto& s : samples) {
            auto* e = new juce::DynamicObject();
            e->setProperty("id", s.id);
            e->setProperty("frames", (int) s.left.size());
            e->setProperty("stereo", !s.right.empty());
            e->setProperty("rate", s.rate);
            list.add(juce::var(e));
        }
        index->setProperty("samples", list);
    }
    index->setProperty("world", lastWorld);
    const auto& r = sync.currentRecipe();
    auto* recipe = new juce::DynamicObject();
    recipe->setProperty("sessionBpm", r.sessionBpm);
    recipe->setProperty("tempoMode", r.tempoMode);
    recipe->setProperty("pulseMultiplier", r.pulseMultiplier);
    recipe->setProperty("syncEnabled", r.syncEnabled);
    recipe->setProperty("followTransport", r.followTransport);
    recipe->setProperty("masterBpm", r.masterBpm);
    index->setProperty("recipe", juce::var(recipe));

    // THE WINDOW IS FURNITURE. A DAW project reopened should give back the
    // editor the user arranged, not the built-in default (§5). Both modes'
    // sizes travel, plus which one was showing.
    auto* win = new juce::DynamicObject();
    win->setProperty("w", editorW);
    win->setProperty("h", editorH);
    index->setProperty("window", juce::var(win));

    // The document's IDENTITY, so a reloaded project reopens the session it was
    // playing instead of an empty Untitled over the top of it.
    index->setProperty("sessionName", sessionName);
    index->setProperty("masterLevel", sl_master_level(engine));

    const auto header = juce::JSON::toString(juce::var(index), true);
    const auto headerUtf8 = header.toRawUTF8();
    const auto headerBytes = (int) header.getNumBytesAsUTF8();

    juce::MemoryBlock raw;
    {
        juce::MemoryOutputStream out(raw, false);
        out.write(kChunkMagic, 4);
        out.writeInt(kChunkVersion);
        out.writeInt(headerBytes);
        out.write(headerUtf8, (size_t) headerBytes);
        // PCM follows in the header's sample order — the index carries the
        // lengths, so the reader never has to guess where one ends.
        for (const auto& s : samples) {
            out.write(s.left.data(), s.left.size() * sizeof(float));
            if (!s.right.empty()) out.write(s.right.data(), s.right.size() * sizeof(float));
        }
    }

    destData.reset();
    {
        juce::MemoryOutputStream compressed(destData, false);
        juce::GZIPCompressorOutputStream gzip(compressed);
        gzip.write(raw.getData(), raw.getSize());
    }
}

void ScoopyPluginProcessor::setStateInformation(const void* data, int sizeInBytes) {
    if (data == nullptr || sizeInBytes <= 0) return;

    // ⚠️ THE HOST CALLS THIS ON ITS OWN THREAD, not the message thread — the
    // VST3 and AU wrappers both pass it straight through. Meanwhile the 40 Hz
    // pump may be mid-`applyWorld` on the same deck: two interleaved world
    // builds corrupt it, and `lastWorld` is a juce::var whose assignment can
    // tear or release its DynamicObject under a concurrent reader. One lock,
    // held by both, is enough — neither path is realtime.
    const juce::ScopedLock sl(stateLock);

    juce::MemoryBlock raw;
    {
        juce::MemoryInputStream in(data, (size_t) sizeInBytes, false);
        juce::GZIPDecompressorInputStream gzip(in);
        juce::MemoryOutputStream out(raw, false);
        out.writeFromInputStream(gzip, -1);
    }
    if (raw.getSize() < 12) return;

    juce::MemoryInputStream in(raw, false);
    char magic[4] = {};
    in.read(magic, 4);
    if (juce::String(magic, 4) != kChunkMagic) return; // not ours — never guess
    const int version = in.readInt();
    // Newer = written by a plugin we do not understand. Zero/negative = not a
    // version we ever wrote, so it is corruption wearing our magic.
    if (version <= 0 || version > kChunkVersion) return;
    const int headerBytes = in.readInt();
    // Bound against what is LEFT, not the total. Checking the total lets a
    // truncated chunk through: setSize does not zero, read fills only what
    // exists, and the JSON parser then reads uninitialised heap.
    if (headerBytes <= 0 || headerBytes > in.getNumBytesRemaining()) return;

    juce::MemoryBlock headerBlock;
    headerBlock.setSize((size_t) headerBytes, /*initialiseToZero=*/true);
    in.read(headerBlock.getData(), headerBytes);
    const auto header = juce::JSON::parse(
        juce::String::fromUTF8((const char*) headerBlock.getData(), headerBytes));
    if (header.getDynamicObject() == nullptr) return;

    // ⚠️ PARSE INTO LOCALS, COMMIT ONLY ON SUCCESS.
    //
    // The first cut committed `lastWorld` and the recipe up front and bailed
    // mid-way through the sample list on a garbled chunk. That left the
    // instance holding a world naming samples it never received — silent —
    // AND the host's next save wrote the truncated sample set back over the
    // user's project. A partial restore that then overwrites the original is
    // worse than refusing outright, which is what this does now.
    std::vector<CachedSample> parsed;
    if (const auto* list = header.getProperty("samples", juce::var()).getArray()) {
        for (const auto& entry : *list) {
            CachedSample s;
            s.id = entry.getProperty("id", juce::var()).toString();
            const auto frames = (int64_t) (int) entry.getProperty("frames", 0);
            const bool stereo = (bool) entry.getProperty("stereo", false);
            s.rate = (double) entry.getProperty("rate", 48000.0);
            if (s.id.isEmpty() || frames <= 0) return; // garbled — keep what we had

            // 64-bit throughout: `frames` is attacker-controlled and a 32-bit
            // multiply could wrap and defeat the bounds check below.
            const int64_t need = frames * (int64_t) sizeof(float) * (stereo ? 2 : 1);
            if (in.getNumBytesRemaining() < need) return;
            s.left.resize((size_t) frames);
            in.read(s.left.data(), (int) (frames * (int64_t) sizeof(float)));
            if (stereo) {
                s.right.resize((size_t) frames);
                in.read(s.right.data(), (int) (frames * (int64_t) sizeof(float)));
            }
            parsed.push_back(std::move(s));
        }
    }

    // Past every refusal — commit.
    samples = std::move(parsed);
    lastWorld = header.getProperty("world", juce::var());

    if (const auto recipe = header.getProperty("recipe", juce::var());
        recipe.getDynamicObject() != nullptr) {
        HostSyncRecipe r;
        r.sessionBpm = (double) recipe.getProperty("sessionBpm", 0.0);
        r.tempoMode = (int) recipe.getProperty("tempoMode", 1);
        r.pulseMultiplier = (double) recipe.getProperty("pulseMultiplier", 1.0);
        r.syncEnabled = (bool) recipe.getProperty("syncEnabled", true);
        r.followTransport = (bool) recipe.getProperty("followTransport", true);
        // Absent in a v1/v2 chunk written before D2 → 0 → follow the host, which
        // is what those projects were actually doing.
        r.masterBpm = (double) recipe.getProperty("masterBpm", 0.0);
        sync.setRecipe(r);
    }

    // Absent in a chunk written before §5 → zeros → "never set", which restores
    // the built-in default rather than collapsing the window to nothing.
    if (const auto win = header.getProperty("window", juce::var());
        win.getDynamicObject() != nullptr) {
        editorW = (int) win.getProperty("w", 0);
        editorH = (int) win.getProperty("h", 0);
    }
    sessionName = header.getProperty("sessionName", juce::var()).toString();

    if (engine != nullptr)
        sl_master_set_level(engine, (double) header.getProperty("masterLevel", 1.0));

    // MAKE SOUND. The editor may never open; this is the whole point of the
    // journal, and the reason the samples travel in the chunk.
    replayJournal();
}

juce::AudioProcessorEditor* ScoopyPluginProcessor::createEditor() {
    return new ScoopyPluginEditor(*this);
}

} // namespace wizard::plugin

// The JUCE plugin wrapper's entry point.
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new wizard::plugin::ScoopyPluginProcessor();
}
