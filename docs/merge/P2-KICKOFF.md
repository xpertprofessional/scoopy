# P2 kickoff — the merged strip-suite: implementation plan

*Written 2026-07-25 at the close of the design phase. This is the brief for the
implementation session. Read alongside the design docs it consolidates:
`STRIP-MODEL.md`, `LOOPER-DESIGN.md`, `ROUTING-MATRIX.md`, `SL-ABI-V3.md`, and
memory `merge-mission`. Supersedes P1-KICKOFF's framing ("host scoopy's UI in
wizard's shell") — see P1-STATUS's MISSION section.*

## Mission (confirmed with the user)

Merge wizard and scoopy into **one native+web app, scoopy leading** (its native
engine + web UI; Swift carved off; wizard's engine is the donor). Wizard
contributes its **strip/map plane**, its **recording/looper** and a **master
sync/tempo section**, built **into scoopy's web UI**. The browser companion
survives separately. This is NOT wizard hosting scoopy — it is the two apps
merging their **strips and decks**.

## The product, in one picture

A **plane** (replacing scoopy's DJ deck view; compose view untouched) of
**strips**. A strip = a uniform **channel** + composable **elements**:

- **Channel** (always): level · **4 FX sends** · **master DSP (DRV)** ·
  **transport + time-stretch** (scoopy's per-deck transport, now every strip's) ·
  output · **record-arm**. Record is one tap on the channel bus, identical for
  every source.
- **Elements** (added on demand): **Grid** (a scoopy session — sequenced) ·
  **Tape** (a wizard deck — continuous: record/scrub/varispeed/loop/overdub) ·
  **Input** (live, full channel incl. sends). A **file player is a tape from a
  file**. So: two content engines (grid + tape) + input.
- Strips start **empty**; **presets** ("looper strip", "deck strip") keep it fast.
- **Multiple decks/sessions coexist, each its own BPM**, any lockable to a master.
- The **routing matrix** patches anything→anything (device inputs, any app's
  audio via the virtual device, FX returns, strip outputs) in real time,
  click-free.

## Two engines, and their status

- **Grid (SL-ABI-V3 §6) — BUILT.** Multi-deck sessions, per-deck BPM, master sync
  (`sl_deck_set_tempo_sync`), add/drop a deck (`sl_deck_clear`), the whole v3 ABI
  (identity/render/snapshots/params/HotFrame), rendering through AudioIO. All
  headless-tested (ctest ~50). Exposes scoopy's DJ-mode multi-deck; the pinned
  core is untouched.
- **Tape (SL-ABI-V3 §5) — BUILT 2026-07-25.** Wizard's `wz_deck_*` transplanted
  as **`sl_tape_*`** (the rename is recorded in SL-ABI-V3 §5: §6 had already
  spent `sl_deck_*` on grid decks): chunked planar storage, seqlock loop, scrub
  mailbox, overdub SUM/REPLACE, insert splice, record service, 256 MB cap, Law
  C-2 stamps, C-3 handoff. 21/21 entry points carried, gated by `tape:check`.
  Eight fixtures (wizard's own deck tests re-pointed, plus a new mix-record one).

  **The (a)/(b) fork resolved to (b) — port into `slengine`.** Reading the donor
  settled it: `deck.h` includes nothing but libstdc++, the deck passes already
  render into their own scratch, and the only couplings were the ramp constant,
  a sample clock and the drain ring. (a) links fine — `render_sink_test` already
  proves it — but would have left **two world/RCU authorities and two topology
  models** in the shipped product, which is a conceptual cost, not a build one.
  `slengine/src/sl_tape.cpp` depends on no core header and no third-party lib.

  Two things the "1:1" framing had hidden, both now handled: the donor could only
  record **device input channels**, so the strip model's "capture this bus" needed
  a record-source KIND designed in up front (retrofitting would have meant
  touching the Law C-3 handoff); and the render became **five phases**, because a
  source has to be captured where it exists — which is what makes a mix take
  sample-exact against its own stamp instead of ~10 ms early.

## Implementation order (proposed)

1. **§5 tape-deck engine — ✅ DONE 2026-07-25.** Fork resolved to (b); wizard's
   decks ported into `slengine` as `sl_tape_*`; 21/21 entry points carried under
   the symmetric `tape:check` gate; the monotonic sample clock (Law C-2's root)
   added; nine fixtures green — the eight tape ones plus `sl_take_drain_test`,
   which pins the **stamp chain in the file bytes** (two staggered takes, delta
   read back out of each WAV's `bext` TimeReference).
   `RecordService` is now engine-agnostic behind `TakeDrainSource`, mirroring the
   `RenderSink` seam, so one take-writing implementation serves wizard's decks
   and the merged engine's tapes and `wz_record` links neither engine.
   **Correction to the record:** `docs/specs/pd-global-record-as-strip.md` §4
   reported the C-2 stamp chain severed (every take shipping `TimeReference = 0`).
   That was true when written on 2026-07-24 and has since been fixed —
   `Service::endTake` applies `setStartEngineSample` before close, and
   `recorder_drain_test` covers it. The new fixture extends that cover to the
   merged engine and to the on-disk bytes.
2. **The channel — ✅ DONE 2026-07-25.** `sl_channel_*` over the ABI: level, the
   4 sends, mute, and the record tap. Ramped on the one 10 ms constant and
   SNAPPING at the target, so a channel parked at unity multiplies by exactly
   1.0 and the tapes' bit-exact paths survive it (the eight tape fixtures now
   run through a channel and still assert exact sample values).
   `slengine/src/sl_channel.{h,cpp}` + `sl_channel_test`.

   **THE FINDING: the channel is a PROJECTION, not a second mixer.** A grid deck
   already HAS a channel inside the core — `crossfaderGain`/`deckGain` are its
   level, `setDeckMasterSend` its sends, `deckMasterDrive_[deck]` its drive. A
   tape had none. So "one uniform channel" means ONE SURFACE, TWO BACKINGS:
   implemented in this tier for tapes, forwarded onto the core's live setters
   for grid decks. A fresh gain stage in front of a deck the core already mixed
   would multiply a gain twice — inaudible until someone moves a fader and the
   wrong amount happens. Binding also releases the previously-bound deck back to
   the world's defaults, because `setDeckGainOverride` stands until superseded
   and would otherwise pin an abandoned deck at a departed strip's level.

   **Also corrected:** the core's four send buses are MONO lanes
   (`AudioLane::send1..send4` are consecutive singles), not stereo pairs. The
   first cut assumed pairs, which would have written a channel's right side into
   the next channel's send bus. Channels now fold to mono into a send, and the
   lane map is derived from the enum rather than transcribed.

   The `channelBus` record source deferred from step 1 is now live: a take
   captures that strip's post-level, post-mute output — the tap point
   ROUTING-MATRIX settled on, and the thing that makes "record the input" and
   "record the deck output" literally one operation.

   **DRV deferred, deliberately (user, 2026-07-25).** It is NOT session-level
   today: the core holds one `NativeMasterDrive` per deck with independent ADAA
   history, parameterised from that deck's own snapshot — so a grid strip
   already has a private drive. The two gaps are that tapes have none (purely
   additive later, at the per-strip processing point the channel now
   establishes) and that the params are snapshot-fed rather than live (a
   republish per knob drag — a smoothness question, fixable with the same
   epoch-gated override pattern the channel's level already uses). On cost:
   instance count is nearly free at `masterClipperOversample = 0` (ADAA); it is
   2×/4× oversampling that is expensive, so the eventual policy is "strips run
   ADAA, oversampling is opt-in or master-only" — which needs no new machinery,
   since oversample is already a per-instance parameter. When the schema lands,
   give the channel a `drive` field from the start even while only grid strips
   honour it, so tapes gaining drive costs no migration.
3. **Routing — ✅ CORE DONE 2026-07-25** (`sl_route_*`, `sl_route_test`).
   Strip→strip patching with the scheduling rule the plan decided:

   - **Forward routes render in DEPENDENCY ORDER** (Kahn at edit time, walked
     per block), so a chain A→B→C adds **zero** latency. The fixture proves it
     with an impulse and asserts which SAMPLE it lands on — the rejected
     "everything one block late" design is indistinguishable on one hop and only
     diverges once you chain, which is exactly why it needed a test that chains.
   - **A cycle is refused at edit time** unless the caller consents by asking for
     a `feedback` edge, which then reads the source's PREVIOUS block. Proven to
     be exactly one block: the same impulse arrives twice, one block apart, with
     no tail (it delays, it does not regenerate).
   - **Every route gain is ramped** — patching fades in, unpatching fades out and
     the slot is dropped only once it reaches zero. Verified click-free (no
     sample step above the ramp bound) in both directions.
   - A strip hears its **element plus everything routed into it**, which is why a
     live-input element needs no separate code path: it is a route with no
     element beside it.

   Sanitizer-clean at -O0 over 400 blocks with a live feedback loop and an
   unpatch mid-flight.

   **Semantic worth knowing:** a route taps the source channel's output, which is
   POST-level and POST-mute — the same tap point the record bus uses. Muting a
   strip therefore silences its routed copies too. That is correct (a route
   carries what the strip contributes) but it surprised the first two versions of
   the fixture, so it is written down here.

3b. **The watchdog (guard G1) — ✅ DONE 2026-07-25** (`sl_watchdog_*`,
   `sl_watchdog_test`). A leaky-RMS detector + ramped limiter on the main pair.

   **Why the merged engine needed its own, and it is not the one wizard had:**
   the strip channels sum in AFTER `core.render`, so scoopy's master clipper is
   already behind them. Every tape and every routed copy reaches the lanes with
   nothing in the way.

   **The finding that cost a design change:** an output limiter CANNOT bound an
   internal feedback loop. A strip→strip loop closes at the channel outputs and
   never passes through the main bus, so the internal signal reaches infinity
   first — and limiting infinity is infinity. Wizard's watchdog genuinely did
   bound its loop, but only because that loop ran THROUGH the limited output
   bus; inheriting that reasoning here would have shipped a guard that watches
   the wrong point. So there are now TWO bounds, at the two places they belong:

   - a **numerical ceiling on every channel output** (+72 dBFS, and non-finite
     becomes silence) — where feedback loops actually close, so divergence and
     NaN propagation are structurally impossible. Far above anything musical or
     any fixture value, so it colours nothing.
   - the **RMS limiter on main** — the audible protection and the lamp.

   Verified: a consented feedback edge at round-trip gain 1.5 over 400 blocks
   stays finite and settles to exactly 1.0 with the limiter at 1e-4; sanitizer-
   clean at gain 2.0 over 2000 blocks (2^2000 unbounded). Normal full-scale
   material passes BIT-EXACT and a lone 8.0 transient does not trip it — RMS not
   peak, per D-WZ-WATCHDOG-01.

   **Two known limitations, both tuning rather than mechanism.** A fast internal
   runaway overshoots before the 250 ms detector catches it (~860 peak in the
   gain-2.0 stress) — exactly what pd-modular-routing §2.2 predicted: "+6 dBFS /
   250 ms is a guard against a slow external loop, not a fast internal one".
   And release after a severe runaway takes several seconds, because the mean
   square has ~16 time constants to fall. The output is HELD, never muted,
   throughout both.

3c. **Typed route endpoints — ✅ DONE 2026-07-25.** The Route model widened from
   channel→channel to typed `{kind, index, sub}` endpoints, so the matrix is
   genuinely any-source → any-destination:

   - **sources:** `channelOut` · `channelSend` (channel + send 0..3) ·
     `deviceInput` (L/R input channels) · `fxReturn` (the core's wet lane).
   - **destinations:** `channelIn` · `sendBus` (mono) · `main`.

   **Sends are routable (decision 5) via `channelSend`.** The channel still owns
   the send's LEVEL; the route owns where it GOES. So send 3 can feed another
   strip's input and drive its looper instead of an effect — the case the user
   asked for — and riding the send fader still moves it, because the level
   never left the channel. A send tap is channel-sourced, so it constrains the
   render order exactly like an output tap: the fixture asserts the feeding
   strip renders first, or the copy would be a block old.

   **A device input is just a route into a strip**, which is why the "input
   element" needs no special case anywhere: a strip with no element and one
   input route simply hears that input.

   **The default wiring is now REAL ROUTES**, installed at configure: every
   channel → main, every send → its matching FX bus (8 × 5 = 40 of 128 slots).
   A fresh engine is wired straight through the way a mixer's channel 1 is
   wired to jack 1, but the matrix can show those cables and a document can
   re-point them — nothing is a hidden special case in the mixer any more.
   `sl_route_clear_all` + `sl_route_install_defaults` are what a document load
   uses so a loaded patch is exactly what was saved, not the saved patch
   layered over the boot defaults.

   Only ordering rules changed with it: a route constrains the render order
   only when it is channel-sourced AND channel-destined. A device input or FX
   return is already present when the block starts, and a send bus or main is a
   terminus nothing reads back — neither orders anything.

   62/62 green after the widening, and one bug it caught: a test that hardcoded
   route ids 0/1 was unpatching DEFAULT routes once the defaults existed.
4. **The plane UI in scoopy's web** — bring wizard's `plane/` (Plane/Strip) into
   scoopy's web (apps/scoopy, writable home), a strip hosting grid/tape/input
   elements on the channel, driven by the engine. Master-tempo control; sync
   toggles; carve-loop→grid-track. Plane patching + the matrix grid as the two
   routing views. (Web build → `bundle:mac` → re-vendor → `WizardMerged` → run.)
5. **Persistence — the DOCUMENT is done 2026-07-25** (`apps/scoopy/web/src/
   persist/mapDocument.{ts,test.ts}`, 10 tests; that repo's suite 1083/1083).

   `.scoopyMap`'s envelope + document, on wizard's discipline: strict Zod,
   SCHEMA_VERSION with named per-version migrations, and a NEWER document
   REFUSED loudly rather than partially loaded (partially loading then
   re-saving destroys what the newer build knew). It models what the engine can
   actually do today — strips with elements, channel state, the routing graph
   and master tempo. FX plugin slots, output map, devices and embedded sessions
   are deliberately still absent: a persisted field with nothing behind it is
   the document equivalent of dead ABI.

   Three things it pins that were only prose before:
   - **`routes[]` carries the `feedback` flag per cable.** Two routes differing
     only in that bit differ by a whole block of latency, so a loader that
     defaulted it would silently change how a patch sounds. Tested directly.
   - **The lane budget is enforced at load** (decision 6): a map that overspends
     is refused WITH THE COUNT, rather than loading a strip the engine cannot
     render and leaving the user staring at something that makes no sound.
     4 stereo decks and 3 grids + 2 mono tapes are both tested as admissible.
   - **Round-trip is deep-equality**, because a save/load that quietly drops one
     cable is the failure that only shows up on stage.

   **Apply + capture — ✅ DONE 2026-07-25** (`persist/mapApply.{ts,test.ts}`,
   13 tests; scoopy's suite 1096/1096, wizard's 62/62).

   `planApply(map)` is a PLANNER, not a caller: it returns an ordered list of
   engine ops. Three reasons, and the first is the one that matters — the
   ORDERING RULES are the load-bearing part, and a pure function lets them be
   tested exhaustively with no engine, device or shell. (Also: the
   `sl_route_*`/`sl_channel_*` surface is not on the SLP wire yet, so a module
   that called `link.command('routeAdd', …)` today would be calling a method
   that does not exist. And it keeps wizard's law: TS owns the document, the
   engine follows.) When the wire lands, applying is a `for` loop over the list.

   The rules it pins, each a bug if broken:
   - **`routeClearAll` first, always** — including for an EMPTY map, or "load an
     empty map" silently means "keep whatever was patched".
   - **Bind the channel source before writing level/sends**, because binding to
     a grid deck projects those onto the core's per-deck controls; values
     written first land on the old deck.
   - **Routes last**, after all channel state.
   - **An unsynced deck gets ratio 1.0, not silence** — omitting the call leaves
     it carrying a ratio from a previously loaded map, i.e. a stretched deck
     with nothing in the document explaining it.
   - **A null sub encodes as 0xFFFFFFFF, never 0** — 0 is a real send index and
     a real input channel.

   `captureRoutes(live)` reads the graph back out, so a save records what
   EXISTS rather than what the UI believes it issued (those drift the moment
   anything edits routing outside the document's view). It skips a cable whose
   kind this build cannot name rather than guessing — a newer build's cable
   must not be silently rewritten into something else.

   **The take library — ✅ DONE 2026-07-25** (`persist/takeLibrary.{ts,test.ts}`,
   15 tests; scoopy 1111/1111, wizard 62/62).

   STRIP-MODEL names this and nothing implemented it: "the FULL take stays in
   the take library, reloadable into a tape later". It is what makes "carve
   frees the tape" non-destructive — the tape LAYER is cleared, the audio is
   not. It carries:

   - **Sidecar parsing.** ⚠️ A HAND-MIRRORED BOUNDARY, and the one place the
     "never hand-mirror a mapping" law cannot be honoured: the `.wav.json` is a
     hand-rolled printf in `host/src/WavWriter.cpp::writeSidecar` with no schema
     to generate from. Mitigated by pinning a byte sample copied verbatim from
     that format string, so a C++ rename fails a test instead of silently
     returning nothing for every take. Verified further by parsing sidecars an
     actual run of `sl_take_drain_test` produced.
   - **Law C-2 alignment** (`alignmentSamples` / `alignmentSeconds`) — the payoff
     for one monotonic clock, and the first code anywhere to actually USE the
     stamp: drop every take at 0:00 in a DAW, offset each by this, and the
     session reproduces. Signed, because the origin is whichever take the user
     aligned against, not necessarily the earliest.
   - **Resolution that preserves.** A reference the library cannot find reports
     the ref rather than dropping it — pd-strip-anatomy's "audio missing" keeps
     the strip, the reference and the record button, because recording over a
     dead reference is a repair. Dropping it would destroy the only record of
     what the strip was meant to play.
   - **The carve invariant**, tested: a scrubbable tape and a grid track carved
     from it reference the SAME take, so a session never duplicates audio.
   - `unreferencedTakes` is explicitly for SHOWING what is reclaimable, never
     for deleting: after a carve a take is unreferenced by design and may be
     exactly what the user reloads next.

   **Host-side take enumeration — ✅ DONE 2026-07-25** (`host/src/TakeScan.
   {h,cpp}`, `take_scan_test`; wizard 63/63).

   `RecordService::takes()` only knows what THIS process recorded, so reopening
   a session tomorrow could not find yesterday's takes. `scanTakes(dir)` closes
   that: it is what makes "reloadable into a tape later" survive a restart
   rather than only a run.

   **It deliberately does NOT parse the sidecar** — it returns the raw JSON and
   lets the document layer parse it, because that layer already owns the schema
   (strict zod). A second parser in C++ would be a second definition of a format
   that is already a hand-mirrored boundary. Enumeration is the host's job;
   interpretation is the document's.

   Two behaviours worth keeping:
   - **A .wav with no sidecar is still returned.** A crash between closing the
     audio and writing the json produces exactly the take a user most wants
     back; dropping it at the scan would hide it forever.
   - **A sidecar with no .wav is not a take** — metadata for audio that no
     longer exists would resolve to nothing.
   Order is chronological for free: `deck<N>_<epochMs>.wav` sorts
   lexicographically into recording order.

   **THE CHAIN IS NOW PROVEN END TO END, ACROSS BOTH LANGUAGES.** A real run of
   `sl_take_drain_test` wrote two staggered takes; the scanner found both in
   order; the TS parser read their sidecars; and `alignmentSamples` recovered
   **25,088 samples** of separation — the engine's monotonic clock, through the
   WAV's `bext` TimeReference, through the sidecar, through the C++ scanner,
   into the take library. That is Law C-2 doing the job it exists for, verified
   on real bytes rather than fixtures at every hop.

   **Still to do:** the SLP wire methods that turn mapApply's op list into
   calls (they need a `protocol/schema.ts` change, which is hash-pinned into
   the merged repo — so it wants a deliberate re-vendor rather than a drive-by).

3i. **The host tier under TSan — 23 races → 0, 2026-07-25.** Extended the
   three-thread harness to `RecordService` + `SlTakeDrainSource` driving the
   real engine: audio thread rendering, service thread allocating/draining,
   message thread cycling takes. 23 reports, three distinct causes:

   - **The Law C-2 stamp itself was racy.** `recStartSample` is written by the
     RENDER (only it knows the exact block capture began on) and read by the
     control thread — `recordStop` returns it, and it becomes the take's
     `TimeReference` and sidecar. A plain `uint64_t`. Not a crash: a take that
     claims the wrong position in the session, which is the precise failure the
     entire stamp chain exists to prevent. Now atomic.
   - **`recordStart` (message thread) raced `recordService` (service thread)**
     over the chunk vector — two NON-AUDIO threads with nothing between them, so
     a record-start could clear and re-reserve the very vector the service
     thread was pushing into. Now serialised by a mutex the RENDER never takes,
     so there is still no lock on the audio thread.
   - **`reset()` clobbered render-owned scalars** (`playhead`, `smRate`,
     `cueFrame`) from the control thread while the render was still advancing
     the playhead of the loop being recorded over. Moved to `resetPlayState()`,
     called by the render at arm pickup — which is also the moment they actually
     need to be zero. `channels` became atomic for the same reason.

   **A regression I caused, caught by re-running an older harness.** The retire
   fix (3e) moves each `unique_ptr` out of `chunks`, which leaves NULLS in the
   live vector — so `rec_race` began SEGV-ing on a null deref where it had
   previously been clean. Fixing use-after-free had turned it into
   use-after-null. Guarded in `sample()`/`appendFrame()`/`mixFrame()`: one block
   of silence is the right answer for a tape whose material is being replaced.

   **⚠️ HONEST LIMITATION, not closed.** That guard makes the window survivable,
   not absent: the vector is still structurally modified while the render
   indexes it. Closing it properly means the render ADOPTING new storage via an
   atomic pointer rather than the control thread mutating shared storage. That
   is a design change, so it is written down here rather than done unattended.

   Verified: host 0 races, engine 0 races, 63/63, and the ASan harnesses at
   ~1,000,000 blocks per run against 3,000 record-starts.

3h. **Route slot reuse raced the render — FOUND AND FIXED 2026-07-25**
   (systematic TSan sweep). On the DOCUMENT-LOAD path, which is the one
   `mapApply::planApply` drives.

   Built a three-thread harness over the public C ABI in the shape the app runs
   it — audio thread rendering, message thread editing, service thread
   allocating ahead and draining. Idle editing was clean; adding the document-
   load operation (`sl_route_clear_all` + `sl_route_install_defaults` while
   audio runs) produced **6 race reports**. Two distinct causes:

   - `installDefaultRoutes` wrote `smGain` and `isDefault` AFTER `addRoute` had
     published the slot, so a render that had already picked the route up was
     gliding the same field. Fixed by routing both through
     `addRouteInternal(..., instant, markDefault)`, so every field is written
     before the `active.store(release)` that publishes it. 6 → 3.
   - The deeper one: `clearRoutes()` frees every slot IMMEDIATELY (a load wipes
     the patch), which deliberately breaks the acquire/release handshake — so a
     slot could be re-filled by the control thread while the render was still
     inside `pour()` gliding that slot's ramp. Fixed by making `Route::smGain`
     atomic. Relaxed ordering suffices: nothing is published through it, and the
     worst interleaving leaves a freshly-patched cable one block off its ramp,
     which then glides to the right place. **Zero per-sample cost** — `pour()`
     loads it once, glides a LOCAL, and stores once.

   0 races across three runs (~1,800 blocks each), 62/62.

3g. **The chunk vector reallocated under the render — FOUND AND FIXED
   2026-07-25** (bug-hunt sweep). A data race in the hot recording path.

   `ensureCapacity()` grew the chunk list with `push_back` on the SERVICE
   thread, by design, while the render reads `chunks[ci]` — that concurrency is
   the whole point (allocate ahead so the RT append never allocates). But there
   was no `reserve`, so push_back past capacity MOVES the array of unique_ptrs
   and frees the old one, which is the very array the render indexes through.

   The donor's comment — carried over verbatim — says "chunk pointers never
   move… no reallocation". That is true of the TapeChunk OBJECTS, which are
   heap-allocated and stable. It was never true of the std::vector holding
   them, and the comment made the gap easy to miss.

   Fixed by reserving the whole take up front, in reset(), where the list is
   empty and `chunkCount` is already 0 so no render can be walking it — the
   file's length for a load, the record cap for a capture. ensureCapacity() now
   also REFUSES to grow past the reservation rather than reallocating; if that
   were ever hit, recording stops at the allocated bound, the same graceful stop
   the 256 MB cap produces.

   **Worth knowing how this was confirmed.** AddressSanitizer did NOT catch it —
   three runs of the pre-fix code completed cleanly, because the realloc has to
   land inside a few-instruction window. Crash-detection is the wrong instrument
   for a race. ThreadSanitizer named it immediately: a write from
   `__push_back_slow_path` (the reallocating path) against the render's read.
   Pre-fix 1 race, post-fix 0. 62/62 throughout.

3f. **A rate change ate the user's patch — FOUND AND FIXED 2026-07-25**
   (bug-hunt sweep). Silent data loss, no crash, no test failure.

   `ChannelBank::configure()` ended with `clearRoutes(); installDefaultRoutes();`
   — and configure runs on every rate change, which `SlRenderSink::setSampleRate`
   performs on EVERY device open (the D-WZ-RATE-01 stop → set → start rebuild).
   So building a patch and then plugging in a different audio interface threw
   the entire patchbay away and wired everything back to main, with nothing to
   see but the sound changing.

   The tell was an asymmetry already in the code: `TapeBank::configure` goes out
   of its way to preserve tape MATERIAL across a rate change ("a rate change must
   not silently discard a take") and the very next line dropped the wiring.
   Sizing buffers and owning the document are different jobs.

   Fixed: configure() sizes buffers and recomputes the render order, nothing
   else. The boot wiring is installed ONCE, explicitly, from `sl_engine_create`.

   The new fixture was verified to bite by restoring the original code exactly:
   it then fails at `sl_route_active(r, mine) == 1` — the user's own cable, gone
   after a rate change — and passes with the fix. 62/62, TSan clean.

   Also fixed alongside: `Watchdog::setEnabled` cleared `limiterGain_`,
   `meanSquare_` and `holdRemaining_` from the CONTROL thread while a running
   `process()` owns them. The clearing moved into `process()`, on the thread
   that owns them; setEnabled now touches only atomics.

3e. **Use-after-free on the audio thread — FOUND AND FIXED 2026-07-25**
   (bug-hunt sweep). The most serious defect found this session.

   `Tape::reset()` called `chunks.clear()` — freeing the storage — and only
   THEN published `chunkCount = 0`. The render's `sample()`/`appendFrame()`
   bounds-check against `chunkCount` and then dereference `chunks[ci]`, so a
   render that read the stale non-zero count went on to touch freed memory.
   Inherited from the donor, which had the same order.

   Reachable by an ordinary gesture: `recordStart()` resets, and recording over
   a loop that is currently PLAYING is a normal thing to do.

   Fixed with two changes, both load-bearing:
   - **publish `chunkCount = 0` FIRST**, so a render arriving after it sees no
     chunks and returns silence without touching the storage; and
   - **retire rather than free** — the chunks move to a `retired_` list, because
     a render already PAST the bounds check still holds a pointer. It then reads
     one block of stale audio (harmless) instead of a dangling pointer (not).
     The list is freed on the next reset, once the block counter shows the audio
     thread has moved on. Control-thread-only, so it needs no lock of its own.

   Measured both ways, because a fix that guards nothing is worth knowing about:
   with the old ordering the same test **SEGVs on the render thread inside
   `captureFrom`**; with the fix it survives **490,326 blocks against 3,000
   record-starts, AddressSanitizer clean**. 62/62 throughout.

3d. **Render-order race — FOUND AND FIXED 2026-07-25** (bug-hunt sweep).

   The published render order was eight separate atomics, written one at a time
   by `rebuildOrder` on the control thread and read one at a time by the render.
   The code's own comment argued no seqlock was needed because "a stale order is
   harmless (it is still a valid permutation)" — **that reasoning covers
   staleness and nothing else.** Eight separate stores can be read half-old and
   half-new, and a TORN order is not a permutation: it can name one channel
   twice and omit another. The duplicate renders twice and sums into main twice
   (double level, routes poured twice); the omitted one keeps last block's
   output and never pours its routes. Re-patching while audio runs is the
   NORMAL case for a patchbay, so this was reachable in ordinary use.

   Measured, not theorised: a standalone repro of the old scheme tore on
   **99,451 of 209,635 reads (47%)**. Fixed by packing the whole order into ONE
   atomic (8 channels × 4 bits in a uint64), so the render sees either the
   entire old order or the entire new one. Read once before the walk — re-reading
   per slot would reintroduce the tearing.

   Verified: 62/62; a new fixture asserts the order is a permutation across 64
   topologies; and a threaded stress (control thread issuing 20,000 re-patches
   against a live render) observed 0 torn orders in 6,078 blocks, ThreadSanitizer
   clean.

Engine + headless-testable work (1–3) comes first; the plane UI (4) is GUI,
verified by running `WizardMerged`, and is collaborative on look/feel.

## Laws / constraints to hold

- **scoopy's core is the ONE writable engine home** (`apps/scoopy`, hash-pinned
  into the merge via engine.lock) until the P3 flip. Merged-repo engine work
  lives in the wizard-owned `slengine` tier; core changes go to `apps/scoopy`.
- **Never hand-mirror a mapping** — generate it from the pinned authority with a
  check gate (track-params, HotFrame, worldmap all do this; the tape ABI's keyed
  surface should too).
- **RT-safe + click-free**: route/world changes are atomic RCU swaps + ramps;
  no locks or allocation on the audio thread.
- **Keep every scoopy grid power and every wizard tape power intact** — the merge
  adds a channel + plane around them, it does not reduce either.
- **Reuse signed wizard decisions** (D-WZ-VDEV-01 virtual device, D-WZ-OVERDUB-01
  destructive overdub, D-WZ-GREC-01 global record, D-WZ-RATE-01 rate rebuild).
- **GUI is verified by a human run-pass** (kickoff law 5) — the agent cannot see
  the screen.

## Decisions taken at P2 planning (2026-07-25, with the user)

1. **Routing = ordered + explicit feedback edges.** Toposort at publish; acyclic
   strip→strip chains are zero-latency; only a cycle-closing route becomes a
   one-block feedback edge, created muted, its +ms shown. Amends
   `ROUTING-MATRIX.md`, which had said everything is one block late — that
   contradicted the signed `pd-modular-routing.md` analysis (accumulating latency
   and silent comb filtering once chaining exists).
2. **3 grid decks for P2** — scoopy's pinned core `kMaxDecks = 3` stands. Tapes
   are an independent space of 8.
3. **Sample clock only; §7 transport deferred.** Capture is immediate (wizard's
   proven behaviour); quantized capture arrives with the transport. Master tempo
   already works via TS-owned BPM → `sl_deck_set_tempo_sync`.
4. **Sends are individually routable.** Channel owns the send LEVEL, the routing
   document owns its DESTINATION (default: send *n* → FX *n*). Stored in the map.
5. **Deck count via a lane budget.** The mixer's content budget is **8 mono lanes
   (4 stereo)**: a grid deck is inherently stereo and costs 2; a tape may be mono
   (1) or stereo (2). **FX returns sit OUTSIDE the budget** as fixed
   infrastructure — 4 stereo aux returns — otherwise adding an FX would silently
   cost a deck. Enforced at the document/publish level, not in engine array
   sizes, so the policy stays cheap to tune. It also describes P2's reality for
   free: 3 pinned grid decks = 6 lanes, leaving 2 mono tape lanes.

### Sub-questions resolved
- **Overdub:** reuse D-WZ-OVERDUB-01 unchanged (destructive SUM/REPLACE, every
  pass still draining to its own stamped take). Built. One addition: a
  mix-sourced overdub is **refused** rather than layering a stale block.
- **Send/record tap point:** the record tap is the strip's **channel output**
  (post-DRV, post-level), dry of the global FX returns; sends post-fader by
  default. Full reasoning in `ROUTING-MATRIX.md`.
- **Loop-length ↔ tempo quantize on capture:** deferred with §7 (decision 3).
- **Master-bpm + tempo ramp:** plane-owned number driving per-deck sync ratios,
  with the core's `rateMorphFrames` / `masterTempoRampSeconds` for the glide.

## Reflection prompt for the new session

Before building, re-read this + the three design docs and sanity-check: does the
"channel + composable elements" strip model + two-engine (grid/tape) split still
hold against the mission, and does the §5 (a)/(b) engine-integration fork have a
clear winner once wizard's deck internals are re-read? Then start at
implementation step 1.
