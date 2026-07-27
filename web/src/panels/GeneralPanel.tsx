import type { EngineLink } from "../engineLink.ts";
import { asString, useSetting } from "../useSetting.ts";
import {
  Button,
  Caption,
  FieldRow,
  PanelTitle,
  Select,
} from "../design/controls.tsx";
import "./paintmode.css";

/** General settings pane — web port per panels/settings.md §1. */
export function GeneralPanel({ link }: { link: EngineLink | null }) {
  const [folder, setFolder] = useSetting(link, "recordingsFolder", "", asString);
  const [sort, setSort] = useSetting(link, "fileBrowserSortOption", "Name", asString);

  const choose = () => {
    link
      ?.command("chooseDirectory", { purpose: "recordings" })
      .then((raw) => {
        const path = (raw as { path?: string | null })?.path;
        if (path) setFolder(path); // Swift already persisted path + bookmark
      })
      .catch(() => {});
  };

  return (
    <main className="panel paintmode">
      <PanelTitle>General</PanelTitle>

      <FieldRow label="Recordings Folder">
        <Button label="Choose…" onClick={choose} />
      </FieldRow>
      <Caption>
        <span className="mono path-display">
          {folder || "~/Music/ScoopyLoops Recordings (default)"}
        </span>
      </Caption>

      <FieldRow label="Sort Folder By">
        <Select
          value={sort}
          options={[
            { value: "Name", label: "Name" },
            { value: "Date Modified", label: "Date Modified" },
          ]}
          onChange={setSort}
        />
      </FieldRow>
    </main>
  );
}
