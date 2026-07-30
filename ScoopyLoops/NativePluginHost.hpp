// NativePluginHost.hpp
//
// VST3/AU plugin hosting for the FX return slots. This header is deliberately
// JUCE-FREE so it can be included from plain C++ translation units (e.g.
// NativeAudioEngineCore.cpp) as well as Obj-C++ ones. All JUCE usage lives in
// NativePluginHost.mm behind SCOOPY_PLUGIN_HOST.
//
//   * NativePluginScanner — owned by the Obj-C++ bridge. Discovers installed
//     AU + VST3 plugins and caches results as XML. PIMPL hides juce types.
//   * (Phase 2) NativePluginSlot — RT-safe per-return plugin instance host.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace scoopyloops {

// POD description of a discovered plugin, safe to hand across the bridge to
// Swift. `identifier` is juce::PluginDescription::createIdentifierString() and is
// what we persist + use to re-instantiate.
struct ScannedPluginInfo {
    std::string identifier;
    std::string name;
    std::string manufacturer;
    std::string format;        // "AudioUnit" or "VST3"
    std::string version;
    bool        isInstrument = false;
};

// Out-of-process scan worker. Called in the re-launched "--scan-plugin" child
// process: instantiates the one plugin (formatName, fileOrIdentifier) in this
// throwaway process, prints the resulting PluginDescription(s) as XML to stdout,
// and returns an exit code. If the plugin crashes on instantiation, this whole
// child process dies — which is the point: the parent survives. Defined in the
// .mm; declared here (JUCE-free) so the Obj-C++ bridge can call it.
int runPluginScanWorker(const std::string& formatName,
                        const std::string& fileOrIdentifier);

class NativePluginScanner {
public:
    NativePluginScanner();
    ~NativePluginScanner();

    NativePluginScanner(const NativePluginScanner&) = delete;
    NativePluginScanner& operator=(const NativePluginScanner&) = delete;

    // Kick off an asynchronous scan of every enabled format (AU + VST3). The
    // callbacks fire on the JUCE message thread; `progress` receives 0..1 and
    // `completion` fires once at the end. Safe to call from any thread; a no-op
    // if a scan is already running.
    void beginScan(std::function<void(float)> progress,
                   std::function<void()> completion);

    bool isScanning() const noexcept;

    // Thread-safe snapshot of everything discovered so far.
    std::vector<ScannedPluginInfo> results() const;

    // Persisted cache (KnownPluginList XML) so scans are incremental across launches.
    std::string knownPluginListXml() const;
    void restoreFromXml(const std::string& xml);

    // Opaque implementation; the slot loader (Phase 2, in the .mm) reaches the
    // juce::AudioPluginFormatManager / KnownPluginList through here.
    class Impl;
    Impl* impl() noexcept { return impl_.get(); }
    const Impl* impl() const noexcept { return impl_.get(); }

private:
    std::unique_ptr<Impl> impl_;
};

// RT-safe host for a single plugin instance living in one FX return slot. The
// audio thread calls processStereoBlock() (wait-free: it try-locks and falls back
// to passthrough during a swap); loads/unloads happen off the audio thread and
// swap the instance under a short lock. JUCE-free interface (PIMPL).
class NativePluginSlot {
public:
    NativePluginSlot();
    ~NativePluginSlot();

    NativePluginSlot(const NativePluginSlot&) = delete;
    NativePluginSlot& operator=(const NativePluginSlot&) = delete;

    // Non-RT. Engine sample rate + max block size. Call before loading / when the
    // device reconfigures. Safe to call repeatedly.
    void prepare(double sampleRate, int maxBlockSize);

    // Non-RT. Loads a plugin by identifier (resolved via `scanner`) on the JUCE
    // message thread, prepares it, optionally restores `stateBase64`, then swaps
    // it in. `completion(success, displayName)` fires on the message thread.
    void loadAsync(NativePluginScanner& scanner,
                   const std::string& identifier,
                   const std::string& stateBase64,
                   std::function<void(bool success, std::string name)> completion);

    // Non-RT. Removes any loaded plugin.
    void unload();

    // Non-RT, SYNCHRONOUS, main/message thread only. Destroys the editor window and
    // the plugin instance before returning — unlike unload(), which marshals the work
    // via callAsync and so never runs once the message loop is stopping at app quit.
    // Call this during applicationWillTerminate (before shutdownJuce_GUI) so hosted
    // plugins are torn down deterministically and JUCE's leak detector stays quiet.
    void destroyNow();

    bool hasPlugin() const noexcept;
    // AUDIO-THREAD-SAFE loaded probe (P6-3). hasPlugin() takes the slot mutex —
    // correct for control threads, a potential priority inversion on the audio
    // thread (the message thread holds that mutex across a load swap). This one
    // is a plain atomic read: true from the moment a load lands until unload/
    // destroy. Used by the host's send-lane pre-seed to decide, per block,
    // whether a return is actually consuming its send bus.
    bool isLoadedLockFree() const noexcept;
    int  latencySamples() const noexcept;

    // AUDIO THREAD. Processes a stereo block in place (left/right, numFrames).
    // `bpm` / `isPlaying` are forwarded to the plugin via an AudioPlayHead so
    // tempo-syncable plugins lock to the project tempo. Returns true if the plugin
    // produced wet output, false for passthrough (no plugin, or swap in progress).
    bool processStereoBlock(float* left, float* right, int numFrames,
                            double bpm, bool isPlaying) noexcept;

    // Non-RT. Opaque plugin state for persistence, and the loaded plugin's name.
    std::string stateBase64() const;
    std::string loadedName() const;

    // Non-RT (marshalled to the JUCE message thread). Open/close the plugin's own
    // editor in a standalone always-on-top window. No-op if the plugin has no editor.
    void openEditor();
    void closeEditor();
    // Non-RT. Show/hide the editor window without destroying it or the plugin instance,
    // so a hidden editor re-shows instantly with state intact. Creates lazily on first show.
    void setEditorVisible(bool visible);

    // Lock-free editor state (P6-4), safe from any thread.
    //
    // ⚠️ THEY ANSWER ABOUT THE WINDOW, NOT ABOUT THE LAST REQUEST, and that is the
    // point. setEditorVisible() marshals its work to the JUCE message thread and
    // returns immediately, so a caller that displayed what it just asked for would
    // light an EDIT lamp over a window that never opened — a plugin with no editor
    // makes `setEditorVisible(true)` a documented no-op, and the user's own click on
    // the window's close box is invisible to the asker entirely. A UI must display
    // these, the same discipline sl_channel_monitor exists for.
    //
    // `editorAvailable()` is false with no plugin loaded, and false for a plugin
    // that has no editor of its own — which is what lets a button be disabled with
    // a reason instead of being offered and doing nothing.
    bool editorAvailable() const noexcept;
    bool editorVisible() const noexcept;

    class Impl;

private:
    std::unique_ptr<Impl> impl_;
};

// RT-safe host for a single INSTRUMENT plugin (MIDI in → audio out) bound to one sequencer
// track. Shares the same plugin lifecycle as NativePluginSlot (load/unload/editor/state on the
// JUCE message thread; try-lock passthrough on the audio thread). Instead of processing an audio
// insert it feeds the plugin a juce::MidiBuffer — drained from a lock-free producer ring AND
// (Phase 3) appended directly on the audio thread — and renders the plugin's instrument output.
// JUCE-free interface (PIMPL). Used only when SCOOPY_PLUGIN_HOST is defined.
class NativeInstrumentSlot {
public:
    NativeInstrumentSlot();
    ~NativeInstrumentSlot();

    NativeInstrumentSlot(const NativeInstrumentSlot&) = delete;
    NativeInstrumentSlot& operator=(const NativeInstrumentSlot&) = delete;

    void prepare(double sampleRate, int maxBlockSize);
    void loadAsync(NativePluginScanner& scanner,
                   const std::string& identifier,
                   const std::string& stateBase64,
                   std::function<void(bool success, std::string name)> completion);
    void unload();
    void destroyNow();

    bool hasPlugin() const noexcept;
    int  latencySamples() const noexcept;

    // CONTROL/MIDI THREAD (non-RT, off the audio thread). Queue a raw MIDI event for delivery to the
    // plugin on the next renderInstrument(). `status` is a full MIDI status byte (incl. channel);
    // `frameOffset` is the sample offset within the next block (clamped at drain). Producers are
    // serialized by a short mutex; the audio-thread consumer drains lock-free. Dropped if the ring
    // is full. NOT for use from the audio thread — Phase 3 sequencer note-gen uses addMidiNow().
    void enqueueMidi(std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                     std::uint32_t frameOffset) noexcept;

    // AUDIO THREAD ONLY. Append a MIDI event directly into the block buffer being assembled for the
    // upcoming renderInstrument() (used by native sequencer note generation, which already runs on
    // the audio thread). Cleared each renderInstrument().
    void addMidiNow(std::uint8_t status, std::uint8_t data1, std::uint8_t data2,
                    std::uint32_t frameOffset) noexcept;

    // AUDIO THREAD ONLY. Monophonic sequencer note: auto-releases the previously held sequencer note
    // on this slot, then (if velocity > 0) starts the new one on `channel`. velocity == 0 just
    // releases. Mirrors a step sequencer driving a synth; prevents hung notes between steps.
    void sequencerNoteNow(std::uint8_t channel, int note, std::uint8_t velocity,
                          std::uint32_t frameOffset) noexcept;
    // AUDIO THREAD ONLY. Release any held sequencer note (transport stop / pattern boundary / seek).
    void releaseSequencerNoteNow(std::uint32_t frameOffset) noexcept;

    // CONTROL or AUDIO THREAD. Queue all-notes-off + all-sound-off on every channel (panic), e.g. on
    // transport stop / seek / pattern switch so the instrument doesn't hang notes.
    void allNotesOff() noexcept;

    // AUDIO THREAD. Drain queued MIDI into a juce::MidiBuffer, run the plugin for numFrames, and
    // WRITE its stereo instrument output to outL/outR (overwrites; does not accumulate). Returns
    // true if the plugin produced output, false (leaving out* untouched) on passthrough (no plugin
    // or swap in progress). bpm/isPlaying drive the AudioPlayHead for tempo-synced instruments.
    bool renderInstrument(float* outL, float* outR, int numFrames,
                          double bpm, bool isPlaying) noexcept;

    std::string stateBase64() const;
    std::string loadedName() const;
    void openEditor();
    void closeEditor();
    void setEditorVisible(bool visible);

    // MAIN/MESSAGE THREAD. The plugin's JUCE program (preset) list — v81 preset stepping.
    // programCount() ≤ 1 means the plugin exposes no stepable list (its own preset browser may
    // still work inside the editor). setProgram clamps into [0, count-1]. While a program
    // switch runs, the audio thread's try-lock render falls back to silence for the block —
    // same policy as a load swap.
    int  programCount() const;
    int  currentProgram() const;
    std::string currentProgramName() const;
    void setProgram(int index);

    class Impl;

private:
    std::unique_ptr<Impl> impl_;
};

} // namespace scoopyloops
