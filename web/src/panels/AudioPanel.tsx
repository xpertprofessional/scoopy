import { useCallback, useEffect, useState } from "react";
import { COMMANDS, type AudioDevice } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { asBoolean, useSetting } from "../useSetting.ts";
import { channelOptions } from "./audioChannels.ts";
import {
  Button,
  Caption,
  Checkbox,
  FieldRow,
  PanelTitle,
  SectionTitle,
  Select,
} from "../design/controls.tsx";
import "./paintmode.css";

/**
 * Audio settings pane — web port per panels/settings.md §2.
 * Deferred output apply; immediate buffer reopen; deck/send routing only
 * on multi-channel devices (parity with the SwiftUI pane).
 */

type DeviceInfo = ReturnType<typeof COMMANDS.enumerateAudioDevices.result.parse>;

export function AudioPanel({ link }: { link: EngineLink | null }) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [pendingOutput, setPendingOutput] = useState<number | null>(null);
  const [applyState, setApplyState] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [inputChannels, setInputChannels] = useState(0);
  const [showSends34] = useSetting(link, "showSends34", false, asBoolean);

  const refresh = useCallback(() => {
    link
      ?.command("enumerateAudioDevices", {})
      .then((raw) => setInfo(COMMANDS.enumerateAudioDevices.result.parse(raw)))
      .catch(() => {});
  }, [link]);

  useEffect(() => {
    refresh();
    if (!link) return;
    const off = link.onEvent((evt) => {
      const type = (evt as { type?: string })?.type;
      if (type === "device-list-changed" || type === "audio-output-changed") refresh();
    });
    const poll = setInterval(() => {
      link
        .command("getAudioInputStatus", {})
        .then((raw) =>
          setInputChannels(
            (raw as { activeInputChannels?: number })?.activeInputChannels ?? 0,
          ),
        )
        .catch(() => {});
    }, 500);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [link, refresh]);

  if (!info) {
    return (
      <main className="panel paintmode audio-pane">
        <PanelTitle>Audio</PanelTitle>
        <Caption>loading devices…</Caption>
      </main>
    );
  }

  const selectedOutput = info.outputs.find((d) => d.id === info.selectedOutputId);
  const outputChannels = selectedOutput?.outputChannelCount ?? 2;
  const effectiveOutputId = pendingOutput ?? info.selectedOutputId;
  const outputDirty = pendingOutput !== null && pendingOutput !== info.selectedOutputId;
  const selectedInput = info.inputs.find((d) => d.id === info.selectedInputId);

  const deviceOptions = (devices: AudioDevice[]) => [
    { value: 0, label: "System Default" },
    ...devices.map((d) => ({ value: d.id, label: d.name })),
  ];

  const applyOutput = () => {
    if (pendingOutput === null) return;
    setApplyState("busy");
    link
      ?.command("selectAudioOutputDevice", { deviceId: pendingOutput })
      .then((raw) => {
        const ok = (raw as { success?: boolean })?.success === true;
        setApplyState(ok ? "ok" : "fail");
        setPendingOutput(null);
        refresh();
        setTimeout(() => setApplyState("idle"), 4000);
      })
      .catch(() => setApplyState("fail"));
  };

  return (
    <main className="panel paintmode audio-pane">
      <header className="panel-head">
        <PanelTitle>Audio</PanelTitle>
        <Button
          label="Refresh"
          onClick={() => {
            link?.command("refreshAudioDevices", {}).then(refresh).catch(() => {});
          }}
        />
      </header>

      <SectionTitle>Input</SectionTitle>
      <FieldRow label="Input Device">
        <Select
          value={info.selectedInputId}
          options={deviceOptions(info.inputs)}
          onChange={(raw) => {
            link?.command("selectAudioInputDevice", { deviceId: Number(raw) })
              .then(refresh).catch(() => {});
          }}
        />
      </FieldRow>
      <FieldRow label="Channels">
        <Select
          value={info.inputIsStereo ? "stereo" : "mono"}
          options={[
            { value: "mono", label: "Mono" },
            { value: "stereo", label: "Stereo" },
          ]}
          onChange={(raw) => {
            link?.command("setAudioInputChannelConfig", {
              startChannel: info.inputStartChannel,
              stereo: raw === "stereo",
            }).then(refresh).catch(() => {});
          }}
        />
      </FieldRow>
      {selectedInput && selectedInput.inputChannelCount > (info.inputIsStereo ? 2 : 1) && (
        <FieldRow label={info.inputIsStereo ? "Channel Pair" : "Channel"}>
          <Select
            value={info.inputStartChannel}
            options={channelOptions(selectedInput.inputChannelCount, info.inputIsStereo)}
            onChange={(raw) => {
              link?.command("setAudioInputChannelConfig", {
                startChannel: Number(raw),
                stereo: info.inputIsStereo,
              }).then(refresh).catch(() => {});
            }}
          />
        </FieldRow>
      )}
      <Caption>
        <span className="mono">
          {inputChannels > 0
            ? `input open: ${inputChannels} channel${inputChannels === 1 ? "" : "s"}`
            : "no input open"}
        </span>
      </Caption>

      <SectionTitle>Output</SectionTitle>
      <FieldRow label="Output Device">
        <Select
          value={effectiveOutputId}
          options={deviceOptions(info.outputs)}
          onChange={(raw) => setPendingOutput(Number(raw))}
        />
      </FieldRow>
      <FieldRow
        label={
          applyState === "busy" ? "applying…" :
          applyState === "ok" ? "output applied" :
          applyState === "fail" ? "apply FAILED" :
          outputDirty ? "pending" : ""
        }
      >
        <Button label="Apply" disabled={!outputDirty || applyState === "busy"} onClick={applyOutput} />
      </FieldRow>

      <FieldRow label="Buffer Size">
        <Select
          value={info.preferredBufferFrames}
          options={[
            { value: 0, label: "Auto" },
            { value: 128, label: "128" },
            { value: 256, label: "256" },
            { value: 512, label: "512" },
          ]}
          onChange={(raw) => {
            link?.command("setAudioBufferFrames", { frames: Number(raw) })
              .then(refresh).catch(() => {});
          }}
        />
      </FieldRow>

      {selectedOutput?.uid && <PerTrackRouting link={link} deviceUid={selectedOutput.uid} />}

      {outputChannels > 2 && (
        <>
          <SectionTitle>Routing</SectionTitle>
          <RoutingMatrix link={link} device={selectedOutput!} showSends34={showSends34} />
        </>
      )}
    </main>
  );
}

/**
 * Routing MATRIX (P4-09c2): rows = signals (MAIN / decks / sends), cols =
 * the selected device's hardware channels. Decks pick a stereo pair (cell
 * spans two channels; the 1/2 pair = ride the main mix) or, in MONO mode,
 * a single channel (native mono fold, MIX-NATIVE-2). Sends are mono by
 * definition. MAIN is read-only in v1 — natively pinned to the device's
 * first stereo pair.
 *
 * Never misrepresents routing: a persisted assignment the current device
 * cannot honor (channel out of range) renders dashed/dim with a
 * "folds to MAIN" caption instead of silently pretending it applies.
 */
function RoutingMatrix({
  link,
  device,
  showSends34,
}: {
  link: EngineLink | null;
  device: AudioDevice;
  showSends34: boolean;
}) {
  const chCount = device.outputChannelCount;
  const parseChannels = (raw: unknown) =>
    Array.isArray(raw) ? (raw as number[]) : raw === null ? null : undefined;
  const parseSend = (raw: unknown) =>
    typeof raw === "number" ? raw : Array.isArray(raw) ? ((raw[0] as number) ?? -1) : undefined;

  // Hooks are hoisted (fixed counts) so conflicts can be computed across rows.
  const [deckA, setDeckA] = useSetting<number[] | null>(link, "djDeckA_OutputChannels", null, parseChannels);
  const [deckB, setDeckB] = useSetting<number[] | null>(link, "djDeckB_OutputChannels", null, parseChannels);
  const [deckC, setDeckC] = useSetting<number[] | null>(link, "djDeckC_OutputChannels", null, parseChannels);
  const [send1, setSend1] = useSetting<number>(link, "send1OutputChannels", -1, parseSend);
  const [send2, setSend2] = useSetting<number>(link, "send2OutputChannels", -1, parseSend);
  const [send3, setSend3] = useSetting<number>(link, "send3OutputChannels", -1, parseSend);
  const [send4, setSend4] = useSetting<number>(link, "send4OutputChannels", -1, parseSend);

  const decks = [
    { name: "A" as const, channels: deckA, set: setDeckA },
    { name: "B" as const, channels: deckB, set: setDeckB },
    { name: "C" as const, channels: deckC, set: setDeckC },
  ];
  const sends = [
    { index: 1, channel: send1, set: setSend1 },
    { index: 2, channel: send2, set: setSend2 },
    ...(showSends34
      ? [
          { index: 3, channel: send3, set: setSend3 },
          { index: 4, channel: send4, set: setSend4 },
        ]
      : []),
  ];

  // Occupancy per channel (dedicated deck channels + send channels), for the
  // conflict caption. MAIN (0/1) and ride-main decks don't claim channels.
  const claims = new Map<number, string[]>();
  const claim = (ch: number, who: string) => {
    if (ch < 0 || ch >= chCount) return;
    claims.set(ch, [...(claims.get(ch) ?? []), who]);
  };
  for (const d of decks) {
    const eff = effectiveDeckChannels(d.channels, chCount);
    if (eff) for (const ch of new Set(eff)) claim(ch, `Deck ${d.name}`);
  }
  for (const s of sends) claim(s.channel, `Send ${s.index}`);
  const conflicts = [...claims.entries()].filter(([, who]) => who.length > 1);

  const gridStyle = {
    gridTemplateColumns: `max-content repeat(${chCount}, minmax(0, 1fr))`,
  };

  const writeDeck = (name: "A" | "B" | "C", set: (v: number[] | null) => void) =>
    (next: number[] | null) => {
      set(next);
      link?.command("setDeckOutputChannels", { deck: name, channels: next }).catch(() => {});
    };
  const writeSend = (index: number, set: (v: number) => void) => (ch: number) => {
    set(ch);
    link?.command("setSendOutputChannel", { sendIndex: index, channel: ch }).catch(() => {});
  };

  return (
    <div className="rmx">
      <div className="rmx-grid" style={gridStyle} role="grid" aria-label="Output routing matrix">
        <div className="rmx-row" role="row" style={{ display: "contents" }}>
          <span className="rmx-label" />
          {Array.from({ length: chCount }, (_, ch) => (
            <span key={ch} className="rmx-col-label" role="columnheader">
              {ch + 1}
            </span>
          ))}
        </div>

        {/* MAIN — read-only v1: natively pinned to the device's first pair. */}
        <div role="row" style={{ display: "contents" }}>
          <span className="rmx-label">MAIN</span>
          <span
            className="rmx-cell rmx-main"
            role="gridcell"
            style={{ gridColumn: "2 / span 2" }}
            title="Main mix is pinned to the device's first stereo pair"
          />
          {Array.from({ length: Math.max(0, chCount - 2) }, (_, i) => (
            <span key={i} className="rmx-cell rmx-off" role="gridcell" />
          ))}
        </div>

        {decks.map((d) => (
          <DeckMatrixRow
            key={d.name}
            name={d.name}
            channels={d.channels}
            device={device}
            onWrite={writeDeck(d.name, d.set)}
          />
        ))}

        {sends.map((s) => (
          <div key={s.index} role="row" style={{ display: "contents" }}>
            <span className="rmx-label">SEND {s.index}</span>
            {Array.from({ length: chCount }, (_, ch) => {
              const active = s.channel === ch;
              return (
                <button
                  key={ch}
                  className={`rmx-cell${active ? " rmx-on" : ""}`}
                  role="gridcell"
                  aria-label={`Send ${s.index} to channel ${ch + 1}`}
                  aria-pressed={active}
                  title={active ? "click to clear" : `Send ${s.index} → ${ch + 1}`}
                  onClick={() => writeSend(s.index, s.set)(active ? -1 : ch)}
                />
              );
            })}
          </div>
        ))}
      </div>

      {conflicts.length > 0 && (
        <Caption>
          <span className="mono">
            ⚠︎ shared channels:{" "}
            {conflicts.map(([ch, who]) => `${ch + 1} (${who.join(" + ")})`).join(", ")}
          </span>
        </Caption>
      )}
      <Caption>
        decks: pick L and R independently — same channel = mono fold, adjacent = stereo pair,
        any two = split outs · sends are mono · MAIN rides the mix
      </Caption>
    </div>
  );
}

/** The channels a deck actually claims on this device, or null = rides MAIN. */
function effectiveDeckChannels(channels: number[] | null, chCount: number): number[] | null {
  if (!channels || channels.length === 0) return null;
  if (channels.some((c) => c < 0 || c >= chCount)) return null; // fold-to-MAIN
  if (channels.length === 2 && channels[0] === 0 && channels[1] === 1) return null; // IS main
  return channels;
}

function DeckMatrixRow({
  name,
  channels,
  device,
  onWrite,
}: {
  name: "A" | "B" | "C";
  channels: number[] | null;
  device: AudioDevice;
  onWrite: (next: number[] | null) => void;
}) {
  const chCount = device.outputChannelCount;
  const folds = channels !== null && channels.some((c) => c < 0 || c >= chCount);
  const eff = effectiveDeckChannels(channels, chCount); // [a,b] valid dedicated, or null
  // Rides the MAIN mix when explicitly null, when it IS the main pair, or when a saved
  // routing can't be honored on this device (eff === null but not a fold-note case).
  const ridesMain = channels === null || (!folds && eff === null);
  // Current per-lane channels (independent). eff is [a,b] for a dedicated deck; a legacy
  // 1-element [ch] means both sides on ch (mono).
  const lCh = eff ? eff[0]! : null;
  const rCh = eff ? (eff.length === 2 ? eff[1]! : eff[0]!) : null;

  // Writes preserve the OTHER lane from the RAW stored channels (not eff), so routing a lane
  // to channel 0/1 — which overlaps the main pair — never loses the sibling lane's value.
  const rawA = channels && channels.length >= 1 ? channels[0]! : null;
  const rawB =
    channels && channels.length === 2 ? channels[1]! : channels && channels.length === 1 ? channels[0]! : null;
  const setLane = (lane: "L" | "R", ch: number) => {
    if (lane === "L") {
      const other = rawB ?? (ch + 1 < chCount ? ch + 1 : ch); // seed a stereo pair from MAIN
      onWrite([ch, other]);
    } else {
      const other = rawA ?? (ch - 1 >= 0 ? ch - 1 : ch);
      onWrite([other, ch]);
    }
  };

  const laneRow = (lane: "L" | "R", cur: number | null) => (
    <div role="row" style={{ display: "contents" }}>
      <span className="rmx-label">
        {lane === "L" ? (
          <>
            DECK {name}
            <button
              className={`rmx-mode${ridesMain ? " rmx-on" : ""}`}
              title="ride the MAIN mix (both sides)"
              aria-label={`Deck ${name} ride main mix`}
              aria-pressed={ridesMain}
              onClick={() => onWrite(null)}
            >
              MAIN
            </button>
          </>
        ) : (
          <span className="rmx-sublabel">R</span>
        )}
        {lane === "L" && <span className="rmx-sublabel">L</span>}
      </span>
      {Array.from({ length: chCount }, (_, ch) => {
        const active = !ridesMain && !folds && cur === ch;
        const mono = lCh !== null && lCh === rCh; // both lanes on one channel
        return (
          <button
            key={ch}
            className={`rmx-cell${active ? " rmx-on" : ""}${folds ? " rmx-fold" : ""}`}
            role="gridcell"
            aria-label={`Deck ${name} ${lane} to channel ${ch + 1}`}
            aria-pressed={active}
            title={
              active
                ? mono
                  ? "mono fold (both sides here)"
                  : `Deck ${name} ${lane} → ${ch + 1}`
                : `Deck ${name} ${lane} → ${ch + 1}`
            }
            onClick={() => setLane(lane, ch)}
          />
        );
      })}
      {lane === "R" && folds && (
        <span className="rmx-fold-note" style={{ gridColumn: `2 / span ${chCount}` }}>
          saved routing not on this device — folds to MAIN
        </span>
      )}
    </div>
  );

  return (
    <>
      {laneRow("L", lCh)}
      {laneRow("R", rCh)}
    </>
  );
}

function PerTrackRouting({ link, deviceUid }: { link: EngineLink | null; deviceUid: string }) {
  const [byDevice, setByDevice] = useSetting<Record<string, boolean>>(
    link, "perTrackOutputRoutingByDevice", {},
    (raw) => (typeof raw === "object" && raw !== null ? (raw as Record<string, boolean>) : undefined),
  );
  const enabled = byDevice[deviceUid] === true;
  return (
    <FieldRow label="Per-track output routing (1/2)">
      <Checkbox
        checked={enabled}
        onChange={(next) => {
          setByDevice({ ...byDevice, [deviceUid]: next });
          link?.command("setPerTrackOutputRouting", { enabled: next, deviceUid }).catch(() => {});
        }}
      />
    </FieldRow>
  );
}

