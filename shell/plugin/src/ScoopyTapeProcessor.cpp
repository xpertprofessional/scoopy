#include "ScoopyTapeProcessor.h"

#include "MergedApp.h" // kScoopySchemaVersion — ONE constant, gated by schema:check
#include "ScoopyTapeEditor.h"
#include "sl_engine.h"

#include <cmath>
#include <cstring>

namespace wizard::plugin {

namespace {

/** Main L/R and nothing else. sl_engine.h §2: "the WASM companion passes
    bus_count = 2 and gets main L/R — v2's stereo behaviour is now simply the
    narrowest call, not a separate shape." An insert effect wants exactly that,
    which is why this product needs no LaneMap at all. */
constexpr uint32_t kMainBusCount = 2;

} // namespace

juce::AudioProcessor::BusesProperties ScoopyTapeProcessor::makeBuses() {
    // An INSERT: one stereo in, one stereo out, both main, both on. ScoopyDeck's
    // input is optional because an instrument makes sound without one; a looper
    // with no input has nothing to loop, so here it is the main bus.
    return BusesProperties()
        .withInput("Input", juce::AudioChannelSet::stereo(), true)
        .withOutput("Output", juce::AudioChannelSet::stereo(), true);
}

ScoopyTapeProcessor::ScoopyTapeProcessor() : juce::AudioProcessor(makeBuses()) {
    // Rate is corrected in prepareToPlay; 44.1k/512 just makes a processor
    // constructed-but-never-prepared (pluginval does this) well-defined.
    engine = sl_engine_create(44100.0, 512, wizard::merged::kScoopySchemaVersion);
    jassert(engine != nullptr);
    jassert(sl_abi_version() == SL_ABI_VERSION);

    // No hidden limiter on a plugin output — the DAW's chain is the protection
    // layer here, same reasoning as D-SL-DECKPLUGIN-01 gave the deck.
    if (engine != nullptr) sl_watchdog_set_enabled(engine, 0);

    // Warm the stretchers inside prepareToPlay rather than behind it: a DAW may
    // roll the transport the instant prepareToPlay returns, and a bus still
    // warming is on its dry path — the loop would play at its own rate for a
    // moment and then snap, which reads as a bug in the sync, not the warm-up.
    if (engine != nullptr) sl_engine_set_sync_stretch_warmup(engine, 1);

    // ⚠️ BIND EVERY TAPE TO ITS OWN CHANNEL. WITHOUT THIS THE PLUGIN IS SILENT.
    //
    // A tape does not render to the main bus; it renders into a CHANNEL, and a
    // fresh channel's source is kind 0 = none (sl_engine.h: "a fresh strip's
    // resting state — not an error"). So §1 shipped a looper that recorded
    // perfectly, reported `looping`, drew its waveform, and put out nothing at
    // all — "no output, stays silent even with recorded content" (real host,
    // 2026-08-02). The routes were never the problem: a fresh engine already
    // wires every channel to main. The SOURCE was simply never set, and the one
    // ABI call that can refuse this was never made, so nothing anywhere had an
    // opportunity to complain.
    //
    // Channel i carries tape i, which is also what makes the face's 8 slot pads
    // address one number instead of two. The app binds per strip as strips are
    // created (PlanePanel.tsx:710); this product's bank is fixed at 8, so the
    // whole map is static and belongs here — on the PROCESSOR, so a DAW playing
    // a project with no editor open still makes sound.
    if (engine != nullptr) {
        const uint32_t n = juce::jmin(sl_tape_count(), sl_channel_count());
        for (uint32_t i = 0; i < n; ++i) {
            constexpr uint32_t kSourceKindTape = 1; // sl_engine.h §4
            const bool bound = sl_channel_set_source(engine, i, kSourceKindTape, i) == 1;
            jassert(bound);
            if (!bound)
                juce::Logger::writeToLog("ScoopyTape: the engine refused to bind tape " +
                                         juce::String((int) i) + " to its channel — that slot "
                                         "will be silent");
        }
    }

    backend = std::make_unique<PluginBackend>(engine, "ScoopyTape");

    // The `hostTransport` broadcast. 40 Hz to match ScoopyDeck's pump, and on
    // the PROCESSOR rather than the editor because §2's capture-length work
    // needs the host's grid whether or not a window is open.
    startTimerHz(40);
}

ScoopyTapeProcessor::~ScoopyTapeProcessor() {
    stopTimer();
    // Same teardown ordering as the app and the deck: hosted-plugin slots die
    // synchronously on the message thread BEFORE the engine that owns them.
    // With no plugin-in-plugin this is the stub's no-op — kept so the ordering
    // survives if that ruling is ever revisited.
    if (engine != nullptr) sl_fx_teardown(engine);
    backend.reset();
    if (engine != nullptr) { sl_engine_destroy(engine); engine = nullptr; }
}

void ScoopyTapeProcessor::prepareToPlay(double sampleRate, int samplesPerBlock) {
    juce::ignoreUnused(samplesPerBlock);
    if (engine == nullptr) return;
    // The D-WZ-RATE-01 rebuild: the engine refuses a rate change while running,
    // so stop → set → start. prepareToPlay is guaranteed non-concurrent with
    // processBlock, which is the "callback detached" precondition it names.
    sl_engine_stop(engine);
    // CHECKED, because the failure is silent and total: a refused rate change
    // leaves everything rendering at the wrong rate — wrong pitch AND wrong
    // tempo — and a failed start is silence.
    const bool rateOk = sl_engine_set_sample_rate(engine, sampleRate) == 1;
    jassert(rateOk);
    const bool startOk = sl_engine_start(engine) == 1;
    jassert(startOk);
    if (!rateOk || !startOk)
        juce::Logger::writeToLog("ScoopyTape: engine refused " + juce::String(sampleRate) +
                                 " Hz (rate " + (rateOk ? "ok" : "FAILED") + ", start " +
                                 (startOk ? "ok" : "FAILED") + ")");

    const auto engineBlock = sl_engine_max_block_frames(engine);
    inScratch.assign((size_t) 2 * engineBlock, 0.0f);
    outScratch.assign((size_t) kMainBusCount * engineBlock, 0.0f);

    // PDC stays at zero for now and that is HONEST, not an omission: §1 renders
    // the tape's varispeed path, which has no group delay. The moment §2 makes
    // timeStretch reachable this needs the deck's mode-scoped updateLatency()
    // treatment — read it from the engine, never hardcode.
    setLatencySamples(0);
}

bool ScoopyTapeProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    // Stereo in, stereo out, nothing else. Mono is deliberately refused rather
    // than half-supported: the tape stores stereo and a mono host layout would
    // silently drop the right channel of every loop.
    if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
    if (layouts.getMainInputChannelSet() != juce::AudioChannelSet::stereo()) return false;
    return true;
}

void ScoopyTapeProcessor::processBlock(juce::AudioBuffer<float>& buffer,
                                       juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;
    midi.clear(); // declared for forward-compat (see the header); nothing reads it in §1

    sync.capture(getPlayHead(), engine);

    const int numSamples = buffer.getNumSamples();

    // The Dekker half of the render-detach guard: announce first, THEN check
    // the mute.
    renderActive.store(true, std::memory_order_seq_cst);
    // Empty scratch means prepareToPlay has not sized our buffers. JUCE
    // guarantees it runs first, but a host that renders anyway would otherwise
    // have the engine write into a zero-length vector — an out-of-bounds write
    // on the audio thread, i.e. a crash in someone's session.
    if (engine == nullptr || inScratch.empty() || outScratch.empty() ||
        renderMuted.load(std::memory_order_seq_cst) ||
        sl_engine_max_block_frames(engine) == 0) {
        renderActive.store(false, std::memory_order_seq_cst);
        // NOT buffer.clear() — this is an INSERT. Killing the track's audio
        // because our engine is not ready would be the loudest possible way to
        // fail; passing the signal through untouched is the quiet one.
        return;
    }

    const int engineBlock = (int) sl_engine_max_block_frames(engine);
    const int inCh = juce::jmin(2, buffer.getNumChannels());

    for (int offset = 0; offset < numSamples;) {
        const int chunk = juce::jmin(numSamples - offset, engineBlock);

        // Copy the input chunk out FIRST: an insert's buffer is in-place, so
        // the channels we are about to write ARE the channels the engine reads.
        const float* ins[2] = {nullptr, nullptr};
        for (int c = 0; c < inCh; ++c) {
            auto* dst = inScratch.data() + (size_t) c * (size_t) engineBlock;
            std::memcpy(dst, buffer.getReadPointer(c) + offset,
                        (size_t) chunk * sizeof(float));
            ins[c] = dst;
        }

        float* outs[kMainBusCount];
        for (uint32_t b = 0; b < kMainBusCount; ++b)
            outs[b] = outScratch.data() + (size_t) b * (size_t) engineBlock;

        sl_render_io(engine, ins, (uint32_t) inCh, outs, kMainBusCount, (uint32_t) chunk);

        // DRY + ENGINE, and the dry is what makes this an insert rather than a
        // replacement. Drop it and a looper on a track silences that track
        // whenever no loop is playing, which is not what inserting an effect
        // means anywhere else in a DAW.
        //
        // ⚠️ §2 INHERITS A QUESTION HERE. The engine opens the channel MONITOR
        // itself at sl_tape_record_start when the source is a device input
        // (D-WZ-MON-01) and closes it at the Law C-3 handoff (D-WZ-MON-02) — so
        // once §1 grows a record verb, the input is carried BOTH by that
        // monitor and by this sum, and it doubles for exactly the length of a
        // take. Nothing records in §1, so the monitor never opens and the sum
        // is correct today; the fix belongs with the verb that breaks it.
        for (int c = 0; c < juce::jmin((int) kMainBusCount, buffer.getNumChannels()); ++c)
            juce::FloatVectorOperations::add(buffer.getWritePointer(c) + offset,
                                             outs[c], chunk);

        offset += chunk;
    }

    renderActive.store(false, std::memory_order_seq_cst);
}

/** Detach the render, run `fn`, reattach. For verbs that reallocate storage the
    render walks (sl_tape_load / sl_tape_insert). Message thread only. */
void ScoopyTapeProcessor::withRenderDetached(const std::function<void()>& fn) {
    renderMuted.store(true, std::memory_order_seq_cst);
    // Spin until any in-flight block has left. Bounded in practice by one
    // buffer period; a host that never calls back leaves us muted, which is
    // silence rather than a torn read of a buffer being freed underneath it.
    while (renderActive.load(std::memory_order_seq_cst)) {
        juce::Thread::sleep(1);
    }
    fn();
    renderMuted.store(false, std::memory_order_seq_cst);
}

juce::AudioProcessorEditor* ScoopyTapeProcessor::createEditor() {
    return new ScoopyTapeEditor(*this);
}

void ScoopyTapeProcessor::timerCallback() {
    if (emitToEditor == nullptr) return;
    const auto snap = sync.snapshot();
    // Change-detected: a parked host should cost nothing, and the page redraws
    // on the HotFrame anyway.
    if (snap.playing == lastTransport.playing && snap.valid == lastTransport.valid &&
        std::abs(snap.bpm - lastTransport.bpm) <= 1e-6)
        return;
    lastTransport = snap;

    auto* payload = new juce::DynamicObject();
    payload->setProperty("type", "hostTransport");
    payload->setProperty("playing", snap.playing);
    payload->setProperty("bpm", snap.bpm);
    payload->setProperty("ppq", snap.ppq);
    payload->setProperty("valid", snap.valid);
    emitToEditor("slEvent", juce::var(payload));
}

juce::var ScoopyTapeProcessor::dispatchFromUi(const juce::String& method,
                                              const juce::var& params) {
    const juce::ScopedLock sl(stateLock);
    return wizard::sl::dispatch(method, params, backend->settings, engine,
                                &backend->services);
}

/** ⚠️ §1 PERSISTS NOTHING, DELIBERATELY, AND SAYS SO RATHER THAN FAKING IT.
 *
 *  A2/A4/A6 put the 8-snapshot bank, its presets and the embed-under-cap rule
 *  in §3, and that is where the chunk format is designed — extending
 *  ScoopyDeck's (gzip · magic · version · JSON header · float32 PCM in header
 *  order · parse-into-locals-and-commit-only-on-success). Writing a
 *  placeholder format now would mean §3 either breaks it or inherits it, and
 *  an EMPTY chunk is unambiguous to a later reader in a way a stub is not: a
 *  project saved today restores as "no snapshots", which is exactly true.
 *
 *  The cost is stated plainly: a DAW project saved with §1 gives back a plugin
 *  with no audio in it. §3 closes this, and until it does the door is "it
 *  loads and passes audio", not "it remembers". */
void ScoopyTapeProcessor::getStateInformation(juce::MemoryBlock& destData) {
    destData.reset();
}

void ScoopyTapeProcessor::setStateInformation(const void* data, int sizeInBytes) {
    juce::ignoreUnused(data, sizeInBytes);
}

} // namespace wizard::plugin

// The JUCE plugin wrapper's entry point. ⚠️ ScoopyPluginProcessor.cpp defines
// one too, and the two would be a duplicate symbol if a single target ever
// compiled both — nothing does, and nothing should: each product's target lists
// exactly its own processor (see ../CMakeLists.txt).
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new wizard::plugin::ScoopyTapeProcessor();
}
