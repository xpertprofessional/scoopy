import { useCallback, useEffect, useState } from "react";
import {
  COMMANDS,
  type MidiEndpoint,
  type MidiMapping,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
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
 * MIDI settings pane — web port per panels/settings.md §5.
 * Selections persist Swift-side (CONFIRM 2026-07-10). The mappings
 * sub-domain (learn/edit/delete) stays SwiftUI until its own increment —
 * this pane covers devices/sync/clock, the everyday surface.
 */

type MidiInfo = ReturnType<typeof COMMANDS.enumerateMidiEndpoints.result.parse>;

export function MidiPanel({ link }: { link: EngineLink | null }) {
  const [info, setInfo] = useState<MidiInfo | null>(null);
  const [clock, setClock] = useState({ locked: false, bpm: 0, tickCount: 0 });
  const [mappings, setMappings] = useState<MidiMapping[]>([]);

  const refresh = useCallback(() => {
    link
      ?.command("enumerateMidiEndpoints", {})
      .then((raw) => setInfo(COMMANDS.enumerateMidiEndpoints.result.parse(raw)))
      .catch(() => {});
  }, [link]);

  const refreshMappings = useCallback(() => {
    link
      ?.command("getMidiMappings", {})
      .then((raw) =>
        setMappings(COMMANDS.getMidiMappings.result.parse(raw).mappings),
      )
      .catch(() => {});
  }, [link]);

  useEffect(() => {
    refresh();
    refreshMappings();
    if (!link) return;
    const off = link.onEvent((evt) => {
      const type = (evt as { type?: string })?.type;
      if (type === "midi-endpoints-changed") refresh();
      if (type === "midi-mappings-changed") refreshMappings();
    });
    const poll = setInterval(() => {
      link
        .command("getMidiClockStatus", {})
        .then((raw) =>
          setClock(COMMANDS.getMidiClockStatus.result.parse(raw)),
        )
        .catch(() => {});
    }, 500);
    return () => {
      off();
      clearInterval(poll);
    };
  }, [link, refresh, refreshMappings]);

  if (!info) {
    return (
      <main className="panel paintmode">
        <PanelTitle>MIDI</PanelTitle>
        <Caption>loading endpoints…</Caption>
      </main>
    );
  }

  const call = (method: Parameters<EngineLink["command"]>[0], params: unknown) =>
    link?.command(method, params).then(refresh).catch(() => {});

  const endpointOptions = (endpoints: MidiEndpoint[]) => [
    { value: 0, label: "No Device" },
    ...endpoints.map((e) => ({
      value: e.id,
      label: e.isOnline ? e.name : `${e.name} (offline)`,
    })),
  ];

  const devicePicker = (
    label: string,
    role: "cc" | "note" | "clock" | "clockOutput",
    selected: number,
    endpoints: MidiEndpoint[],
    disabled = false,
  ) => (
    <FieldRow label={label}>
      <Select
        value={disabled ? 0 : selected}
        options={endpointOptions(endpoints)}
        onChange={(raw) => call("selectMidiDevice", { role, deviceId: Number(raw) })}
      />
    </FieldRow>
  );

  return (
    <main className="panel paintmode">
      <header className="panel-head">
        <PanelTitle>MIDI</PanelTitle>
        <Button label="Refresh" onClick={() => call("refreshMidiDevices", {})} />
      </header>

      <FieldRow label="Enable MIDI">
        <Checkbox
          checked={info.enabled}
          onChange={(v) => call("setMidiEnabled", { enabled: v })}
        />
      </FieldRow>

      <SectionTitle>Devices</SectionTitle>
      {devicePicker("CC Learn", "cc", info.ccDeviceId, info.sources)}
      {devicePicker("Note Input", "note", info.noteDeviceId, info.sources)}
      {devicePicker("Clock Sync", "clock", info.clockDeviceId, info.sources)}

      <SectionTitle>Sync</SectionTitle>
      <FieldRow label="Sync Mode">
        <Select
          value={info.syncMode}
          options={[
            { value: "internalMaster", label: "Internal / Master" },
            { value: "externalSlave", label: "External / Slave" },
          ]}
          onChange={(raw) => call("setMidiSyncMode", { mode: raw })}
        />
      </FieldRow>
      {info.syncMode === "externalSlave" && (
        <FieldRow label="Slave Transport">
          <Select
            value={info.slaveTransportPolicy}
            options={[
              { value: "fullTransport", label: "Full Transport" },
              { value: "tempoAndPhaseOnly", label: "Tempo + Phase" },
            ]}
            onChange={(raw) => call("setMidiSlaveTransportPolicy", { policy: raw })}
          />
        </FieldRow>
      )}
      {info.syncMode === "internalMaster" &&
        devicePicker("Clock Output", "clockOutput", info.clockOutputId, info.destinations)}

      <Caption>
        <span className="mono">
          {info.syncMode === "externalSlave"
            ? clock.locked
              ? `clock locked · ${clock.bpm.toFixed(1)} BPM · ${clock.tickCount} ticks`
              : "waiting for external clock…"
            : "internal clock master"}
        </span>
      </Caption>

      <SectionTitle>Mappings</SectionTitle>
      {mappings.length === 0 ? (
        <Caption>
          No CC mappings. Learning a new mapping starts from a native
          control (right-click ▸ MIDI Learn) — web-side learn arrives with
          the Phase 3 control library.
        </Caption>
      ) : (
        <>
          {mappings.map((m) => (
            <MappingRow
              key={m.id}
              mapping={m}
              onUpdate={(curve, inverted) =>
                link?.command("updateMidiMapping", { id: m.id, curve, inverted })
                  .then(refreshMappings).catch(() => {})
              }
              onRemove={() =>
                link?.command("removeMidiMapping", { learnId: m.learnId })
                  .then(refreshMappings).catch(() => {})
              }
            />
          ))}
          <FieldRow label="">
            <Button
              label="Clear All"
              onClick={() =>
                link?.command("clearMidiMappings", {})
                  .then(refreshMappings).catch(() => {})
              }
            />
          </FieldRow>
        </>
      )}
    </main>
  );
}

function MappingRow(props: {
  mapping: MidiMapping;
  onUpdate: (curve: MidiMapping["curve"], inverted: boolean) => void;
  onRemove: () => void;
}) {
  const m = props.mapping;
  return (
    <div className="mapping-row">
      <span className="ds-value mapping-target" title={m.learnId}>
        {m.learnId}
      </span>
      <span className="dim ds-value">
        CC{m.ccNumber} ch{m.channel + 1}
      </span>
      <Select
        value={m.curve}
        options={[
          { value: "Linear", label: "Linear" },
          { value: "Exponential", label: "Exp" },
          { value: "Logarithmic", label: "Log" },
          { value: "S-Curve", label: "S" },
        ]}
        onChange={(raw) => props.onUpdate(raw as MidiMapping["curve"], m.inverted)}
      />
      <label className="dim inv-label">
        inv
        <Checkbox
          checked={m.inverted}
          onChange={(v) => props.onUpdate(m.curve, v)}
        />
      </label>
      <Button label="✕" onClick={props.onRemove} />
    </div>
  );
}
