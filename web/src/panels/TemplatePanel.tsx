import type { EngineLink } from "../engineLink.ts";
import { asBoolean, asNumber, asString, useSetting } from "../useSetting.ts";
import {
  Button,
  Caption,
  Checkbox,
  FieldRow,
  PanelTitle,
  Select,
  Stepper,
} from "../design/controls.tsx";
import "./paintmode.css";

/**
 * Session Template pane — web port per panels/settings.md §6.
 * Sample-mode raw values: 0 = REG, 3 = OWN (mainSelectableModes).
 */
export function TemplatePanel({ link }: { link: EngineLink | null }) {
  const [tracks, setTracks] = useSetting(link, "templateTrackCount", 8, asNumber);
  const [steps, setSteps] = useSetting(link, "templateStepCount", 16, asNumber);
  const [scenes, setScenes] = useSetting(link, "templateSceneCount", 1, asNumber);
  const [mode, setMode] = useSetting(link, "templateSamplerMode", 0, asNumber);
  const [bpm, setBpm] = useSetting(link, "templateMasterBPM", 120, asNumber);
  const [useKit, setUseKit] = useSetting(link, "templateUseDefaultKit", true, asBoolean);
  const [kitFolder, setKitFolder] = useSetting(link, "defaultKitFolder", "", asString);

  const chooseKit = () => {
    link
      ?.command("chooseDirectory", { purpose: "defaultKit" })
      .then((raw) => {
        const path = (raw as { path?: string | null })?.path;
        if (path) setKitFolder(path);
      })
      .catch(() => {});
  };

  return (
    <main className="panel paintmode">
      <PanelTitle>Session Template</PanelTitle>
      <Caption>Defaults for newly created sessions.</Caption>

      <FieldRow label="Tracks">
        <Stepper value={tracks} min={1} max={32} onChange={setTracks} />
      </FieldRow>
      <FieldRow label="Steps per Track">
        <Stepper value={steps} min={1} max={128} onChange={setSteps} />
      </FieldRow>
      <FieldRow label="Pattern Scenes">
        <Stepper value={scenes} min={1} max={6} onChange={setScenes} />
      </FieldRow>

      <FieldRow label="Sample Mode">
        <Select
          value={mode}
          options={[
            { value: 0, label: "REG (regular)" },
            { value: 3, label: "OWN (owner)" },
          ]}
          onChange={(raw) => setMode(Number(raw))}
        />
      </FieldRow>

      <FieldRow label="Master BPM">
        <Stepper value={bpm} min={20} max={300} onChange={setBpm} />
      </FieldRow>

      <FieldRow label="Kit Folder">
        <Button label="Choose…" onClick={chooseKit} />
        <Button label="Clear" onClick={() => setKitFolder("")} />
      </FieldRow>
      <Caption>
        <span className="mono path-display">
          {kitFolder || "Built-in kit (bundle resources)"}
        </span>
      </Caption>

      <FieldRow label="Load default kit samples">
        <Checkbox checked={useKit} onChange={setUseKit} />
      </FieldRow>

      <Caption>
        <span className="mono">
          New session: {tracks} tracks × {steps} steps, {scenes} scene
          {scenes === 1 ? "" : "s"}, {mode === 0 ? "REG" : "OWN"}, {bpm} BPM
          {useKit ? ", default kit" : ""}
        </span>
      </Caption>
    </main>
  );
}
