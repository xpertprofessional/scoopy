import { useEffect, useRef, useState } from "react";
import {
  DjUiState,
  ToolbarUiState,
  type FxSlotState,
  type XmixState,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button, GeoRange, Select } from "../design/controls.tsx";
import { DragBox, useLearnMenu, useLearnStatus } from "../design/DragBox.tsx";
import { semanticColor } from "../design/tokens.ts";
import type { LearnTarget } from "../state/midiLearn.ts";
import { ChannelStrip, MicMeter, type ChannelSend } from "./ChannelStrip.tsx";
import { CaptureChannel } from "./CaptureChannel.tsx";
import { inputSourceOptions, inputSourceValue, parseInputSource } from "./audioChannels.ts";
import { WaitingForState } from "./WaitingForState.tsx";
import "./deckmixer.css";

/**
 * Mixer section — unified channel strips (MIXER-CONCEPT.md): decks, mic,
 * and FX returns all render as ChannelStrip blocks so they read as one
 * console.
 *
 * Mixer overhaul (2026-07-14):
 * - TWO ROWS: the channel row on top, the XFADE/X·MIX row full-width below.
 *   The crossfader used to be the rightmost strip of a horizontally-scrolling
 *   row — permanently off-screen at MacBook widths. Now nothing scrolls: every
 *   channel flexes to ONE equal width (equal fader travel = comparable levels)
 *   and the console stretches with the window.
 * - The DECK MASTER SENDS left the deck strips for the master track row
 *   (MasterRow) — the deck header IS the deck's master track, and the vertical
 *   micro-faders were the one control outside the app's slider language. The
 *   INPUT strip keeps its micro-sends (it has no master row to move them to).
 * - The per-channel X-MIX side picker and the carve meter are GONE: sides are
 *   fixed policy (A→a, B→b, rest own — DJModeManager.init) until the X-MIX
 *   matrix lands.
 */

const DECK_NAMES = ["A", "B", "C"] as const;

export function DeckMixerPanel({ link }: { link: EngineLink | null }) {
  const [state, setState] = useState<ToolbarUiState | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("toolbar", (raw) => {
      const parsed = ToolbarUiState.safeParse(raw);
      if (parsed.success) setState(parsed.data);
    });
    link.command("getUiState", { topic: "toolbar" }).catch(() => {});
    return off;
  }, [link]);

  // Two rows now — the host frame cannot know the stack's height (it was sized
  // for the one-row console), and overflow is CLIPPED with no error. Measure
  // the real content and let the host follow (the TransportPanel pattern).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !link) return;
    let last = 0;
    const report = () => {
      const h = Math.ceil(el.scrollHeight);
      if (h > 0 && h !== last) {
        last = h;
        link.command("setPanelHeight", { heightPx: h }).catch(() => {});
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [link, state === null]);

  if (!state) {
    return <WaitingForState topics={["toolbar"]} className="mixer-stack mono dim" />;
  }

  const patch = (next: Partial<ToolbarUiState>) => setState({ ...state, ...next });
  const deckCount = state.deckCEnabled ? 3 : 2;
  // Solo is per-family: a soloed deck silences the other decks, a soloed FX
  // return silences the other returns. When either family has a solo up, its
  // non-soloed members recede (ChannelStrip.soloDimmed) so the console visibly
  // collapses to what you are actually hearing.
  const anyDeckSolo = state.deckSoloed.some(Boolean);
  const anySendSolo = state.fxSlots.some((s) => s.soloed);
  // Columns follow the real FX-bus count (2, or 4 with showSends34).
  const buses = state.fxSlots.map((_, i) => i + 1);

  /** INPUT → any FX bus. All 4 are live since MIX-NATIVE-3 widened the core. */
  const micSends = (): ChannelSend[] =>
    buses.map((b) => {
      const key = `send${b}` as "send1" | "send2" | "send3" | "send4";
      return {
        value: state.mic[key],
        label: `Input send to FX${b}`,
        onChange: (v: number) => {
          patch({ mic: { ...state.mic, [key]: v } });
          link?.paramWrite("micSendLevel", v, undefined, b);
        },
      };
    });

  return (
    <main className="mixer-stack" ref={rootRef}>
      <div className="mixer">
        {/* Console utility block — global mixer controls, not a channel. Same
            block shell as the strips so it sits on the console grid; holds I/O
            (device picker + routing matrix in a floating window, MIX-R5).

            THE CPU METER IS GONE FROM HERE (P11-5), relocated rather than
            cloned — the rule `uiOwnership.test.ts` exists to enforce. Its home
            is the plane's MASTER BAR now, as `DSP n%`, because this surface is
            one P3-P1 retired from the panels menu: `deckmixer` is not in
            `PANEL_MENU_SURFACES` and it hangs on "waiting for state" in the
            merged host. The audio thread's load was measurable, published and
            pinned by a ctest, and the only door to it was behind a door that
            does not open. */}
        <section className="channel channel-utility">
          <div className="ch-top">
            <span className="ch-label-only">MIXER</span>
          </div>

          <div className="ch-bottom">
            <Button
              label="I/O"
              title="Audio device & routing…"
              onClick={() => link?.command("openAudioRoutingWindow", {}).catch(() => {})}
            />
          </div>
        </section>

        {/* CAPTURE (CAP-3) — the recorder's one home. It sits in the console's
            global zone beside I/O because it is not a source: it records whatever
            the rest of the console adds up to. */}
        <CaptureChannel link={link} />

        {DECK_NAMES.slice(0, deckCount).map((name, d) => (
          <ChannelStrip
            key={`deck-${name}`}
            label={`DECK ${name}`}
            identity={semanticColor("deck", d)}
            soloDimmed={anyDeckSolo && !(state.deckSoloed[d] ?? false)}
            level={{
              value: state.deckVolume[d] ?? 0.8,
              min: 0,
              max: 1,
              onChange: (v) => {
                patch({ deckVolume: state.deckVolume.map((x, i) => (i === d ? v : x)) });
                link?.paramWrite("deckVolume", v, d);
              },
            }}
            muted={{
              on: state.deckMuted[d] ?? false,
              onToggle: () => {
                const next = !(state.deckMuted[d] ?? false);
                patch({ deckMuted: state.deckMuted.map((x, i) => (i === d ? next : x)) });
                link?.paramWrite("deckMuted", next ? 1 : 0, d);
              },
            }}
            soloed={{
              on: state.deckSoloed[d] ?? false,
              onToggle: () => {
                const next = !(state.deckSoloed[d] ?? false);
                patch({ deckSoloed: state.deckSoloed.map((x, i) => (i === d ? next : x)) });
                link?.paramWrite("deckSoloed", next ? 1 : 0, d);
              },
            }}
            bottom={
              state.outputPairs.length > 0 ? (
                (() => {
                  // Guard: if the persisted channel pair maps to no current
                  // device stereo pair (device changed, mono/odd channel), the
                  // Select would silently show the first option — a routing lie.
                  // Fall back to "OUT MAIN" (-1) so the control never misrepresents.
                  const first = state.deckOutputChannels[d]?.[0] ?? -1;
                  const value = state.outputPairs.some((p) => p.first === first) ? first : -1;
                  return (
                    <Select
                      value={value}
                      options={[
                        { value: -1, label: "OUT MAIN" },
                        ...state.outputPairs.map((p) => ({ value: p.first, label: `OUT ${p.label}` })),
                      ]}
                      onChange={(raw) => {
                        const first = Number(raw);
                        const channels = first === -1 ? null : [first, first + 1];
                        patch({
                          deckOutputChannels: state.deckOutputChannels.map((c, i) => (i === d ? channels : c)),
                        });
                        link?.command("setDeckOutputChannels", { deck: name, channels }).catch(() => {});
                      }}
                    />
                  );
                })()
              ) : (
                <span className="ch-out dim mono">OUT MAIN</span>
              )
            }
          />
        ))}

        {/* INPUT (mic/line). Bottom row is the SOURCE picker — which hardware
            input — matching every other channel. MON rides up top: it's a
            listen/cue control (does the live input reach the output at all),
            not a mute and not a solo — sends flow with MON off. */}
        <ChannelStrip
          label="INPUT"
          meter={<MicMeter link={link} />}
          sends={micSends()}
          level={{
            value: state.mic.gain,
            min: 0,
            max: 1,
            onChange: (v) => {
              patch({ mic: { ...state.mic, gain: v } });
              link?.paramWrite("micGain", v);
            },
          }}
          muted={{
            on: state.mic.muted,
            onToggle: () => {
              const next = !state.mic.muted;
              patch({ mic: { ...state.mic, muted: next } });
              link?.paramWrite("micMuted", next ? 1 : 0);
            },
          }}
          aux={{
            // "M" is taken by mute, and "MON" was wide enough to eat the fader's
            // room. MN = monitor; the tooltip carries the meaning.
            label: "MN",
            title: "Monitor: hear the live input through the output",
            on: state.mic.monitorOn,
            onToggle: () => {
              const next = !state.mic.monitorOn;
              patch({ mic: { ...state.mic, monitorOn: next } });
              link?.paramWrite("micMonitorOn", next ? 1 : 0);
            },
          }}
          bottom={<InputSourcePicker link={link} state={state} onLocal={patch} />}
        />

        {state.fxSlots.map((slot, i) => (
          <FxChannel
            key={`fx-${i + 1}`}
            link={link}
            slot={slot}
            returnIndex={i + 1}
            anySendSolo={anySendSolo}
            outputPairs={state.outputPairs}
            onLocal={(p) =>
              patch({ fxSlots: state.fxSlots.map((s, j) => (j === i ? { ...s, ...p } : s)) })
            }
          />
        ))}
      </div>

      {/* XFADE / X·MIX — one full-width horizontal row BELOW the channels. It
          was the rightmost strip of a scrolling row, i.e. invisible until you
          scrolled for it — a crossfader you cannot see is a crossfader you
          cannot perform on. Same writes, same owners (uiOwnership pins them
          to this file); the fader keeps its native-parity MIDI-learn (the BAR
          itself is the learn target, DJModeView:1640) and its inert-dim while
          disengaged (decks play at their own volume, toolbar.md §6). */}
      <XfadeRow link={link} state={state} onLocal={patch} />
    </main>
  );
}

/**
 * The crossfader row. ENGAGE is a real toggle (MIX-R4) — crossfader ducking is
 * an explicit opt-in: while disengaged every deck plays at its own volume, so
 * the fader itself stays inert (native parity, toolbar.md §6). X·MIX rides the
 * fader it shapes (P6-10): X·MIX *is* the crossfader (workflow law) — moving
 * the fader carves each side where the OPPOSITE side's spectrum has energy, so
 * the incoming track eats the outgoing one instead of merely fading past it.
 */
function XfadeRow({
  link,
  state,
  onLocal,
}: {
  link: EngineLink | null;
  state: ToolbarUiState;
  onLocal: (p: Partial<ToolbarUiState>) => void;
}) {
  // Native makes the crossfader BAR itself learnable (DJModeView:1640). Learn
  // stays available while disengaged — you map the CC in setup, when the fader
  // is inert; refusing then would be the wrong moment.
  const learn: LearnTarget = { kind: "singleton", learnId: "dj_crossfader" };
  const learnMenu = useLearnMenu(learn);
  const learnTint = useLearnStatus(learn);
  return (
    <div className="xfade-row">
      <span className="ch-label-only">XFADE</span>
      <span
        className={`ch-level xf-fader${learnTint}${state.crossfaderEngaged ? "" : " ch-level-inert"}`}
        onContextMenu={learnMenu}
      >
        <GeoRange
          label="XFADE"
          value={state.crossfaderPosition}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => {
            if (!state.crossfaderEngaged) return;
            onLocal({ crossfaderPosition: v });
            link?.paramWrite("crossfaderPosition", v);
          }}
        />
      </span>
      <Button
        label="ENGAGE"
        active={state.crossfaderEngaged}
        title={
          state.crossfaderEngaged
            ? "Decks follow their crossfader side (A left, B right)"
            : "Crossfader is inert — decks play at their own volume"
        }
        onClick={() => {
          const next = !state.crossfaderEngaged;
          onLocal({ crossfaderEngaged: next });
          link?.paramWrite("crossfaderEngaged", next ? 1 : 0);
        }}
      />
      <XmixControls link={link} />
    </div>
  );
}

/**
 * X·MIX character (P6-10) — the crossfader's own controls, so they live on the
 * crossfader's row. Reads the `dj` topic (DJModeManager owns the state; the
 * P6-01 golden fixtures guard the math these values feed).
 */
function XmixControls({ link }: { link: EngineLink | null }) {
  const [x, setX] = useState<XmixState | null>(null);

  useEffect(() => {
    if (!link) return;
    const off = link.onUiState("dj", (raw) => {
      const parsed = DjUiState.safeParse(raw);
      if (parsed.success) setX(parsed.data.xmix);
    });
    link.command("getUiState", { topic: "dj" }).catch(() => {});
    return off;
  }, [link]);

  if (!x) return null;
  const local = (p: Partial<XmixState>) => setX({ ...x, ...p });

  return (
    <div className={`xmix-controls${x.enabled ? "" : " off"}`}>
      <Button
        label="X·MIX"
        active={x.enabled}
        title="Complementary spectral carve: the incoming track eats the outgoing"
        onClick={() => {
          local({ enabled: !x.enabled });
          link?.paramWrite("xmixEnabled", x.enabled ? 0 : 1);
        }}
      />
      <label className="xmix-field" title="How deep the fader carves each side">
        <span className="mono dim">CARVE</span>
        <DragBox
          id="xmix/strength"
          value={x.strength}
          display={`${Math.round(x.strength * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.75}
          onChange={(v) => {
            local({ strength: v });
            link?.paramWrite("xmixStrength", v);
          }}
        />
      </label>
      <Button
        label="FULLER"
        active={x.fullerCurve}
        title="Both decks stay near full level through the travel — the carve does the separating"
        onClick={() => {
          local({ fullerCurve: !x.fullerCurve });
          link?.paramWrite("xmixFullerCurve", x.fullerCurve ? 0 : 1);
        }}
      />
      <Button
        label="SHIMMER"
        active={x.shimmer}
        title="Carved bands ring back through resonant bandpasses instead of just ducking"
        onClick={() => {
          local({ shimmer: !x.shimmer });
          link?.paramWrite("xmixShimmer", x.shimmer ? 0 : 1);
        }}
      />
      <label className="xmix-field" title="How hot the carved bands ring back">
        <span className="mono dim">AMT</span>
        <DragBox
          id="xmix/shimmerAmount"
          value={x.shimmerAmount}
          display={`${Math.round(x.shimmerAmount * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          defaultValue={0.7}
          onChange={(v) => {
            local({ shimmerAmount: v });
            link?.paramWrite("xmixShimmerAmount", v);
          }}
        />
      </label>
    </div>
  );
}

/**
 * INPUT source picker (MIX-R3) — the INPUT strip's bottom row, the input-side
 * twin of the deck OUT picker. ONE control answers "which hardware input?":
 * stereo pairs and mono channels in a single list (the strip has no room for
 * the Audio pane's separate mono/stereo + channel selects).
 */
function InputSourcePicker({
  link,
  state,
  onLocal,
}: {
  link: EngineLink | null;
  state: ToolbarUiState;
  onLocal: (patch: Partial<ToolbarUiState>) => void;
}) {
  const options = inputSourceOptions(state.inputChannelCount);
  const fallback = options[0];
  if (!fallback) {
    return <span className="ch-out dim mono">NO INPUT</span>;
  }

  // Same guard as the deck OUT picker: if the persisted selection doesn't exist
  // on the current device, a Select would silently show option 0 — a routing
  // lie. Fall back explicitly to the first real source instead.
  const current = inputSourceValue(state.mic.inputStartChannel, state.mic.inputIsStereo);
  const value = options.some((o) => o.value === current) ? current : fallback.value;

  return (
    <Select
      value={value}
      options={options}
      onChange={(raw) => {
        const { startChannel, stereo } = parseInputSource(raw);
        onLocal({ mic: { ...state.mic, inputStartChannel: startChannel, inputIsStereo: stereo } });
        link?.command("setAudioInputChannelConfig", { startChannel, stereo }).catch(() => {});
      }}
    />
  );
}

/**
 * FX return channel (mixer overhaul). EVERY control is inline now, in fixed
 * row order — the floating FX window shrank to just the plugin scanner:
 *
 *   1 (top)    return volume · M · S
 *   2 (mid)    HOST/EXT · PRE/POST
 *   3 (mid)    plugin picker · VIEW        (host mode only)
 *   4 (bottom) output picker               (the shared routing baseline)
 *
 * The strip is the control surface; the window is only how you CHOOSE a
 * plugin. The old ⋯ overflow button is gone with the controls it hid.
 */
function FxChannel(props: {
  link: EngineLink | null;
  slot: FxSlotState;
  returnIndex: number;
  /** A solo is up on some FX return — recede this one unless it is the soloed one. */
  anySendSolo: boolean;
  outputPairs: ToolbarUiState["outputPairs"];
  onLocal: (p: Partial<FxSlotState>) => void;
}) {
  const { link, slot, returnIndex: r, outputPairs } = props;

  const openWindow = () =>
    link?.command("openFxSlotWindow", { returnIndex: r }).catch(() => {});
  const fxOp = (op: string, extra: Record<string, unknown> = {}) =>
    link?.command("fxSlot", { returnIndex: r, op, ...extra }).catch(() => {});

  // A send routes to ONE mono hardware channel (native `sendsOutputChannels`),
  // so the options are individual channels, not stereo pairs.
  const channels = outputPairs.flatMap((p) => [p.first, p.first + 1]);
  // Same "never misrepresent routing" guard as the deck OUT picker.
  const channelValue = channels.includes(slot.outputChannel) ? slot.outputChannel : -1;

  const isHostWithPlugin = slot.mode === "host" && slot.pluginName !== null;
  // Entering EXT needs a spare hardware output; without one the toggle is
  // genuinely impossible, so DISABLE it with a reason rather than let it
  // silently do nothing (which is exactly how it read before).
  const canGoExternal = slot.mode === "external" || channels.length > 0;

  const mid = (
    <>
      <div className="ch-mode">
        <Button
          label={slot.mode === "host" ? "HOST" : "EXT"}
          disabled={!canGoExternal}
          title={
            !canGoExternal
              ? "No spare hardware outputs on this device — assign one in Audio & Routing"
              : slot.mode === "host"
                ? "Hosting a plugin — switch to an external hardware send"
                : "External hardware send — switch back to a hosted plugin"
          }
          onClick={() => fxOp("toggleMode")}
        />
        <Button
          label={slot.postFader ? "POST" : "PRE"}
          title={
            slot.postFader
              ? "Post-fader: the send level follows the source track's volume fader"
              : "Pre-fader: the send ignores the source track's volume fader"
          }
          onClick={() => {
            props.onLocal({ postFader: !slot.postFader });
            fxOp("togglePostFader");
          }}
        />
      </div>
      {slot.mode === "host" && (
        <div className="ch-plugin">
          <button
            className="ds-button ch-source"
            title={slot.pluginName ?? "Choose a plugin"}
            onClick={openWindow}
          >
            {slot.pluginName ?? "no plugin"}
          </button>
          <Button
            label="VIEW"
            active={slot.editorVisible}
            disabled={slot.pluginName === null}
            title={
              slot.pluginName === null
                ? "No plugin loaded"
                : `Toggle the plugin's editor window (F${r})`
            }
            onClick={() => {
              props.onLocal({ editorVisible: !slot.editorVisible });
              fxOp("toggleEditor");
            }}
          />
        </div>
      )}
    </>
  );

  // Bottom = the ROUTING row, on the same baseline as every channel's picker.
  // HOST: where does the wet RETURN go — MAIN or the send's dedicated hardware
  // channel (idempotent setHostOutput, Select semantics). EXT: which hardware
  // channel carries the send out of the box.
  const bottom =
    slot.mode === "host" ? (
      slot.externalAvailable && slot.channelLabel !== null ? (
        <Select
          value={slot.hostToHardware ? 1 : 0}
          options={[
            { value: 0, label: "OUT MAIN" },
            { value: 1, label: `OUT ${slot.channelLabel}` },
          ]}
          onChange={(raw) => {
            const toHardware = Number(raw) === 1;
            props.onLocal({ hostToHardware: toHardware });
            fxOp("setHostOutput", { value: toHardware });
          }}
        />
      ) : (
        <span className="ch-out dim mono" title="No dedicated send channel on this device — the wet return feeds the main mix">
          OUT MAIN
        </span>
      )
    ) : (
      <Select
        value={channelValue}
        options={[
          { value: -1, label: "OUT —" },
          ...channels.map((c) => ({ value: c, label: `OUT ${c + 1}` })),
        ]}
        onChange={(raw) => {
          const channel = Number(raw);
          props.onLocal({ outputChannel: channel });
          link?.command("setSendOutputChannel", { sendIndex: r, channel }).catch(() => {});
        }}
      />
    );

  return (
    <ChannelStrip
      label={`FX${r}`}
      // The return wears the SAME color as the send that feeds it: FX3 here and
      // every track's S3 slider are one signal path, so they are one color.
      identity={semanticColor("send", r - 1)}
      soloDimmed={props.anySendSolo && !slot.soloed}
      level={
        isHostWithPlugin
          ? {
              value: slot.returnLevel,
              min: 0,
              max: 2,
              onChange: (v) => {
                props.onLocal({ returnLevel: v });
                link?.paramWrite("returnVolume", v, undefined, r);
              },
            }
          : null
      }
      // All four returns mute now: 1/2 via their session ReturnTrack, 3/4 via
      // the app-global AudioDeviceManager mute (they have no ReturnTrack —
      // which is why this button used to exist only on FX1/2).
      muted={{
        on: slot.muted,
        onToggle: () => {
          props.onLocal({ muted: !slot.muted });
          link?.paramWrite("returnMuted", slot.muted ? 0 : 1, undefined, r);
        },
      }}
      soloed={{
        on: slot.soloed,
        onToggle: () => {
          props.onLocal({ soloed: !slot.soloed });
          link?.paramWrite("sendSoloed", slot.soloed ? 0 : 1, undefined, r);
        },
      }}
      mid={mid}
      bottom={bottom}
    />
  );
}
