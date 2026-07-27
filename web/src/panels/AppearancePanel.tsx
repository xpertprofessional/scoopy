import { useEffect, useRef, useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import {
  ACTIVE_LOOK_KEY,
  CUSTOM_LOOKS_KEY,
  DEFAULT_TOKENS,
  applyTokens,
  loadAndApplyTokens,
  mergeTokens,
  saveAndApplyTokens,
  type ChromeColors,
  type DesignTokens,
  type MotionTrick,
  type Polarity,
  type SemanticColors,
  type TypeStep,
} from "../design/tokens.ts";
import {
  FACES,
  TYPE_PAIRINGS,
  faceByName,
  isAvailable,
  nameForStack,
} from "../design/typefaces.ts";
import { DEFAULT_LOOK, SHIPPED_LOOKS, lookByName } from "../design/looks.ts";
import {
  Button,
  Caption,
  Checkbox,
  FieldRow,
  PanelTitle,
  ParamRow,
  SectionTitle,
  Select,
} from "../design/controls.tsx";
import { WaveformStudio } from "./WaveformStudio.tsx";
import "./paintmode.css";
import "./appearance.css";

/**
 * Appearance pane = THE live token editor (DESIGN-SYSTEM.md, DS-02).
 * Every edit applies instantly app-wide (CSS vars) and persists under
 * theme.tokens. Scope per 2026-07-10 CONFIRM: minimal tokens + fonts +
 * control design + background image; no per-surface override zoo.
 */

const CHROME_ROLES: { key: keyof ChromeColors; label: string; hint: string }[] = [
  { key: "bg", label: "Background", hint: "app background" },
  { key: "bgRaised", label: "Raised", hint: "control surfaces: sliders, boxes, buttons" },
  { key: "line", label: "Line", hint: "borders, dividers" },
  { key: "text", label: "Text", hint: "labels, values" },
  { key: "textDim", label: "Text dim", hint: "captions, secondary" },
  { key: "accent", label: "Accent", hint: "selection, focus, active — pick yours" },
  { key: "signal", label: "Signal", hint: "meters, playhead" },
  { key: "warn", label: "Warn", hint: "clip warning" },
  { key: "hot", label: "Hot", hint: "record, clip" },
];

/** In derive mode the greys are computed, so only the STATE colours stay manual —
    "clipping" has to shout on any ground, and that is not something a background
    choice gets to decide. */
const DERIVED_ROLES = new Set<keyof ChromeColors>(["signal", "warn", "hot"]);

const SEED_ROLES: { key: "ground" | "ink" | "accent"; label: string; hint: string }[] = [
  { key: "ground", label: "Ground", hint: "the background everything sits on" },
  { key: "ink", label: "Ink", hint: "primary text — the greys are mixes of these two" },
  { key: "accent", label: "Accent", hint: "selection, focus, active" },
];

const MOTION_TRICKS: { key: MotionTrick; label: string; hint: string }[] = [
  { key: "menuEntry", label: "Menus arrive", hint: "scale + fade in; dismiss stays instant" },
  { key: "hoverLift", label: "Hover response", hint: "buttons and boxes answer the pointer" },
  { key: "latchSweep", label: "Latches sweep", hint: "mute / arm / solo fill in, not snap" },
  { key: "panelEntry", label: "Panels fade up", hint: "no flash when a window opens" },
];

/** The numbered families, labelled exactly as the app labels them. */
const SEM_FAMILIES: {
  key: "send" | "mod" | "deck";
  label: string;
  hint: string;
  names: string[];
}[] = [
  {
    key: "send",
    label: "Sends",
    hint: "track send ↔ mixer FX return",
    names: ["S1", "S2", "S3", "S4"],
  },
  {
    key: "mod",
    label: "Modulation",
    hint: "lane ↔ mapped control ↔ sweep band",
    names: ["M1", "M2", "M3", "M4"],
  },
  {
    key: "deck",
    label: "Decks",
    hint: "transport ↔ mixer output ↔ session",
    names: ["A", "B", "C"],
  },
];

/** A user-saved look (TOOL-LOOKS): the whole token set under a chosen name. */
interface CustomLook {
  name: string;
  tokens: DesignTokens;
}

/** Parse the persisted custom-looks JSON defensively — every entry's tokens go
    through mergeTokens so an old or hand-edited save lands on the defaults. */
function parseCustomLooks(raw: unknown): CustomLook[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e): e is { name: string; tokens: unknown } =>
        Boolean(e) && typeof e.name === "string" && e.name.length > 0)
      .map((e) => ({ name: e.name, tokens: mergeTokens(e.tokens ?? {}) }));
  } catch {
    return [];
  }
}

export function AppearancePanel({ link }: { link: EngineLink | null }) {
  const [tokens, setTokens] = useState<DesignTokens>(DEFAULT_TOKENS);
  const [look, setLook] = useState<string>(DEFAULT_LOOK);
  const [customLooks, setCustomLooks] = useState<CustomLook[]>([]);
  const [slotName, setSlotName] = useState("");
  const [bgImage, setBgImage] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAndApplyTokens(link).then((t) => {
      if (!cancelled) setTokens(t);
    });
    // Customs FIRST, then the active-look name — the name may be a custom one.
    link
      ?.command("getSetting", { key: CUSTOM_LOOKS_KEY })
      .then((raw) => {
        const customs = parseCustomLooks((raw as { value?: unknown })?.value);
        if (!cancelled) setCustomLooks(customs);
        return link.command("getSetting", { key: ACTIVE_LOOK_KEY }).then((rawLook) => {
          if (cancelled) return;
          const name = (rawLook as { value?: unknown })?.value;
          if (
            typeof name === "string" &&
            (lookByName(name) || customs.some((c) => c.name === name))
          ) {
            setLook(name);
          }
        });
      })
      .catch(() => {});
    link
      ?.command("getBackgroundImage", {})
      .then((raw) => {
        if (cancelled) return;
        setBgImage((raw as { dataUrl?: string | null })?.dataUrl ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [link]);

  // Live-apply immediately; debounce persistence so drags don't spam.
  const update = (next: DesignTokens) => {
    setTokens(next);
    applyTokens(next);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveAndApplyTokens(link, next);
    }, 300);
  };

  /** Load a whole look (shipped or saved). Everything below the switcher then
      edits FROM it — a look is a starting point, not a lock. */
  const applyLook = (name: string) => {
    const custom = customLooks.find((c) => c.name === name);
    const next = custom?.tokens ?? lookByName(name)?.tokens;
    if (!next) return;
    setLook(name);
    update(next);
    link?.command("setSetting", { key: ACTIVE_LOOK_KEY, value: name }).catch(() => {});
  };

  const persistCustomLooks = (next: CustomLook[]) => {
    setCustomLooks(next);
    link
      ?.command("setSetting", { key: CUSTOM_LOOKS_KEY, value: JSON.stringify(next) })
      .catch(() => {});
  };

  /** Save the CURRENT token state under the typed name. Same name = overwrite
      (that is how a slot gets updated); shipped names are refused upstream. */
  const saveCurrentAsLook = () => {
    const name = slotName.trim();
    if (name === "" || lookByName(name)) return;
    const entry: CustomLook = { name, tokens };
    persistCustomLooks([...customLooks.filter((c) => c.name !== name), entry]);
    setSlotName("");
    setLook(name);
    link?.command("setSetting", { key: ACTIVE_LOOK_KEY, value: name }).catch(() => {});
  };

  /** Delete the selected saved look. The tokens on screen stay — deleting a
      slot must never restyle the app out from under you. */
  const deleteCurrentLook = () => {
    if (!customLooks.some((c) => c.name === look)) return;
    persistCustomLooks(customLooks.filter((c) => c.name !== look));
    setLook("(edited)");
  };

  // A look is just its tokens, so sharing one is copying JSON. No format, no
  // export dialog, no file — the clipboard IS the interchange.
  const exportLook = () => {
    void navigator.clipboard.writeText(JSON.stringify(tokens, null, 2));
  };

  const importLook = () => {
    void navigator.clipboard
      .readText()
      .then((text) => {
        // mergeTokens is the gate: a hand-edited or older look lands on the
        // defaults rather than leaving holes that render as fallbacks.
        update(mergeTokens(JSON.parse(text)));
        setLook("(pasted)");
      })
      .catch(() => {});
  };

  const setType = (step: keyof DesignTokens["type"], patch: Partial<TypeStep>) =>
    update({ ...tokens, type: { ...tokens.type, [step]: { ...tokens.type[step], ...patch } } });

  // ONE catalogue, BOTH roles. Two lists was the bug: the prose face reaches only
  // captions + panel titles (the app is mono-dominant), so a prose-only picker
  // could never actually show you a typeface.
  const valuesFace = faceByName(nameForStack(tokens.fontMono));
  const proseFace = faceByName(nameForStack(tokens.fontUI));

  /** The pairing the two faces currently spell, or "Custom" once you mix freely. */
  const pairing =
    TYPE_PAIRINGS.find((p) => p.values === valuesFace?.name && p.prose === proseFace?.name)?.name ??
    "Custom";
  const pairingNote =
    TYPE_PAIRINGS.find((p) => p.name === pairing)?.note ?? "your own mix of the two faces below";

  const applyPairing = (name: string) => {
    const p = TYPE_PAIRINGS.find((x) => x.name === name);
    const values = p && faceByName(p.values);
    const prose = p && faceByName(p.prose);
    if (!values || !prose) return;
    update({ ...tokens, fontMono: values.stack, fontUI: prose.stack });
  };

  /** A face this machine cannot render falls back SILENTLY — the picker would look
      broken. Say so in the option instead of hiding it.

      "Custom" is prepended only when the current stack ISN'T one of ours (a pasted
      look, a hand-edited theme): a select whose value is absent from its options
      renders blank, which reads as "no font". */
  const faceOptions = (current: string, warnProportional: boolean) => {
    const opts = FACES.map((f) => {
      const missing = !isAvailable(f.stack);
      // On the values role, a proportional face means the digits are different
      // widths — a column of numbers will JITTER as it counts. State the cost;
      // don't remove the option.
      const jitters = warnProportional && !f.mono;
      const suffix = missing ? " — not installed" : jitters ? " · digits jitter" : "";
      return { value: f.name, label: `${f.name}${suffix}` };
    });
    return current === "Custom" ? [{ value: "Custom", label: "Custom" }, ...opts] : opts;
  };

  const setChrome = (key: keyof ChromeColors, value: string) =>
    update({ ...tokens, chrome: { ...tokens.chrome, [key]: value } });

  const setSemantic = (patch: Partial<SemanticColors>) =>
    update({ ...tokens, semantic: { ...tokens.semantic, ...patch } });

  const setSemanticEntry = (family: "send" | "mod" | "deck", i: number, hex: string) => {
    const next = [...tokens.semantic[family]];
    next[i] = hex;
    setSemantic({ [family]: next });
  };

  /** Mirror the background tokens to the native window layer (the renderer).
      Token persistence still rides `update`; this is the live-apply half. */
  const pushBackgroundStyle = (bg: DesignTokens["background"]) => {
    link
      ?.command("setBackgroundStyle", {
        opacityPct: Math.round(bg.imageOpacity * 100),
        mode: bg.imageMode,
        tileSizing: bg.tileSizing,
        tileScalePct: Math.round(bg.tileScalePct),
        tileCountPerRow: Math.round(bg.tileCountPerRow),
        motion: bg.motion,
        shakeEnabled: bg.shakeEnabled,
        shakeIntensityPct: Math.round(bg.shakeIntensityPct),
      })
      .catch(() => {});
  };

  const updateBackground = (patch: Partial<DesignTokens["background"]>) => {
    const background = { ...tokens.background, ...patch };
    update({ ...tokens, background });
    pushBackgroundStyle(background);
  };

  const chooseBackground = () => {
    link
      ?.command("chooseImageFile", { purpose: "background" })
      .then((raw) => {
        const dataUrl = (raw as { dataUrl?: string | null })?.dataUrl;
        if (dataUrl) setBgImage(dataUrl);
      })
      .catch(() => {});
  };

  const clearBackground = () => {
    link?.command("clearBackgroundImage", {}).catch(() => {});
    setBgImage(null);
  };

  // BG-FIX: no inline preview here any more. The image is painted by the NATIVE
  // window layer behind every (transparent) webview — this panel included — so
  // the previous panel-local CSS preview would render the picture twice.
  return (
    <main className="panel paintmode appearance">
      <PanelTitle>Appearance</PanelTitle>
      <Caption>
        Live token editor — every change applies app-wide instantly and is
        saved. One accent, semantic roles only.
      </Caption>

      <SectionTitle>Look</SectionTitle>
      <Caption>
        A look is the whole token set at once. Switch to compare, then edit from
        there — everything below is the look you have loaded.
      </Caption>
      <FieldRow label="Look">
        <span className="dim role-hint">
          {lookByName(look)?.blurb ??
            (customLooks.some((c) => c.name === look) ? "your saved look" : "edited")}
        </span>
        <Select
          value={look}
          options={[
            ...SHIPPED_LOOKS.map((l) => ({ value: l.name, label: l.name })),
            ...customLooks.map((c) => ({ value: c.name, label: `★ ${c.name}` })),
            // A select whose value is absent from its options renders blank.
            ...(lookByName(look) || customLooks.some((c) => c.name === look)
              ? []
              : [{ value: look, label: look }]),
          ]}
          onChange={applyLook}
        />
      </FieldRow>
      <FieldRow label="Save as look">
        <span className="dim role-hint">the current state, under your name</span>
        <input
          type="text"
          className="mono look-name-input"
          placeholder="name…"
          value={slotName}
          maxLength={24}
          onChange={(e) => setSlotName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveCurrentAsLook();
          }}
        />
        <Button
          label="Save"
          onClick={saveCurrentAsLook}
          disabled={slotName.trim() === "" || Boolean(lookByName(slotName.trim()))}
        />
        <Button
          label="Delete"
          onClick={deleteCurrentLook}
          disabled={!customLooks.some((c) => c.name === look)}
        />
      </FieldRow>
      <FieldRow label="Share">
        <span className="dim role-hint">a look is just JSON — copy it out, paste one in</span>
        <Button label="Copy" onClick={exportLook} />
        <Button label="Paste" onClick={importLook} />
      </FieldRow>

      <SectionTitle>Colors</SectionTitle>
      <Caption>
        Derive mode sets the greys from three seeds — a ground, an ink, and an
        accent — with fixed steps between them. It is how a new palette becomes a
        ten-second job instead of nine careful edits, and it is what makes a light
        look a re-skin rather than a rewrite: every step mixes the ground TOWARD
        the ink, so "raised" is lighter on black and darker on paper by itself.
      </Caption>
      <FieldRow label="Derive greys">
        <span className="dim role-hint">off = set all nine by hand</span>
        <Checkbox
          checked={tokens.seeds.enabled}
          onChange={(v) => update({ ...tokens, seeds: { ...tokens.seeds, enabled: v } })}
        />
      </FieldRow>
      <FieldRow label="Polarity">
        <span className="dim role-hint">also sets native scrollbars + form controls</span>
        <Select
          value={tokens.polarity}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onChange={(v) => update({ ...tokens, polarity: v as Polarity })}
        />
      </FieldRow>
      {tokens.seeds.enabled &&
        SEED_ROLES.map((role) => (
          <FieldRow key={role.key} label={role.label}>
            <span className="dim role-hint">{role.hint}</span>
            <input
              type="color"
              className="color-swatch"
              value={tokens.seeds[role.key]}
              onChange={(e) =>
                update({ ...tokens, seeds: { ...tokens.seeds, [role.key]: e.target.value } })
              }
            />
          </FieldRow>
        ))}
      {CHROME_ROLES.filter((r) => !tokens.seeds.enabled || DERIVED_ROLES.has(r.key)).map(
        (role) => (
          <FieldRow key={role.key} label={role.label}>
            <span className="dim role-hint">{role.hint}</span>
            <input
              type="color"
              className="color-swatch"
              value={tokens.chrome[role.key]}
              onChange={(e) => setChrome(role.key, e.target.value)}
            />
          </FieldRow>
        ),
      )}

      <SectionTitle>Shape</SectionTitle>
      <Caption>
        One number owns every corner in the app — the grid cells included. 0 is
        the sharp digital identity; raise it and the whole app softens together.
      </Caption>
      <ParamRow
        label="Corner radius"
        value={tokens.shape.radiusPx}
        display={`${tokens.shape.radiusPx}px`}
        min={0}
        max={12}
        step={1}
        onChange={(v) => update({ ...tokens, shape: { ...tokens.shape, radiusPx: v } })}
      />
      <ParamRow
        label="Hairline"
        value={tokens.shape.hairlinePx}
        display={`${tokens.shape.hairlinePx}px`}
        min={0.5}
        max={2}
        step={0.5}
        onChange={(v) => update({ ...tokens, shape: { ...tokens.shape, hairlinePx: v } })}
      />
      <ParamRow
        label="Depth"
        value={tokens.elevation.ambientAlpha}
        display={tokens.elevation.ambientAlpha === 0 ? "flat" : tokens.elevation.ambientAlpha.toFixed(2)}
        min={0}
        max={0.7}
        step={0.02}
        onChange={(v) => update({ ...tokens, elevation: { ambientAlpha: v } })}
      />

      <SectionTitle>Surface</SectionTitle>
      <Caption>
        Grain gives the background tooth — a flat near-black bands on an 8-bit
        panel and reads as a void. Chrome ink is how present the grid's own
        furniture is; it never touches the waveforms or the meters, so turning it
        down for a light ground cannot dim the audio.
      </Caption>
      <ParamRow
        label="Grain"
        value={tokens.surface.grainAlpha}
        display={tokens.surface.grainAlpha === 0 ? "off" : `${Math.round(tokens.surface.grainAlpha * 100)}%`}
        min={0}
        max={0.2}
        step={0.01}
        onChange={(v) => update({ ...tokens, surface: { ...tokens.surface, grainAlpha: v } })}
      />
      <ParamRow
        label="Chrome ink"
        value={tokens.surface.chromeInk}
        display={`${Math.round(tokens.surface.chromeInk * 100)}%`}
        min={0.3}
        max={1.5}
        step={0.05}
        onChange={(v) => update({ ...tokens, surface: { ...tokens.surface, chromeInk: v } })}
      />

      <SectionTitle>Motion</SectionTitle>
      <Caption>
        Soft touch, chrome only. Nothing on the audio path animates and nothing
        animates during a drag. Set the scale to 0 and the app goes fully instant
        — the transport's own pulses keep running, because those are readouts, not
        decoration.
      </Caption>
      <ParamRow
        label="Motion"
        value={tokens.motion.scale}
        display={
          tokens.motion.scale === 0 ? "off" : tokens.motion.scale === 1 ? "crisp" : `${tokens.motion.scale.toFixed(1)}×`
        }
        min={0}
        max={2}
        step={0.1}
        onChange={(v) => update({ ...tokens, motion: { ...tokens.motion, scale: v } })}
      />
      {MOTION_TRICKS.map((t) => (
        <FieldRow key={t.key} label={t.label}>
          <span className="dim role-hint">{t.hint}</span>
          <Checkbox
            checked={tokens.motion.tricks[t.key]}
            onChange={(v) =>
              update({
                ...tokens,
                motion: { ...tokens.motion, tricks: { ...tokens.motion.tricks, [t.key]: v } },
              })
            }
          />
        </FieldRow>
      ))}

      <SectionTitle>Semantic Colors</SectionTitle>
      <Caption>
        Identity colors for numbered assignments, so two controls far apart read
        as connected — send 3 and mixer FX3, an M2 band and the M2 lane, a deck
        and its output box. Sends own a cool arc, modulators a warm one: they
        share a track row, so they can never be confused.
      </Caption>
      <FieldRow label="Semantic colors">
        <span className="dim role-hint">off = plain chrome, as before</span>
        <Checkbox
          checked={tokens.semantic.enabled}
          onChange={(v) => setSemantic({ enabled: v })}
        />
      </FieldRow>
      <div className={tokens.semantic.enabled ? undefined : "sem-off"}>
        <ParamRow
          label="Strength"
          value={tokens.semantic.strengthPct}
          display={`${tokens.semantic.strengthPct}%`}
          min={0}
          max={100}
          step={1}
          onChange={(v) => setSemantic({ strengthPct: v })}
        />
        {SEM_FAMILIES.map((fam) => (
          <FieldRow key={fam.key} label={fam.label}>
            <span className="dim role-hint">{fam.hint}</span>
            <span className="sem-palette">
              {tokens.semantic[fam.key].map((hex, i) => (
                <span key={i} className="sem-swatch">
                  <span className="dim sem-swatch-name">{fam.names[i]}</span>
                  <input
                    type="color"
                    className="color-swatch"
                    aria-label={`${fam.label} ${fam.names[i]}`}
                    value={hex}
                    onChange={(e) => setSemanticEntry(fam.key, i, e.target.value)}
                  />
                </span>
              ))}
            </span>
          </FieldRow>
        ))}
        <FieldRow label="Mute group">
          <span className="dim role-hint">MUTE latch ↔ its member tracks</span>
          <input
            type="color"
            className="color-swatch"
            aria-label="Mute group"
            value={tokens.semantic.muteGroup}
            onChange={(e) => setSemantic({ muteGroup: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="">
          <Button
            label="Reset palettes"
            onClick={() =>
              setSemantic({
                send: DEFAULT_TOKENS.semantic.send,
                mod: DEFAULT_TOKENS.semantic.mod,
                deck: DEFAULT_TOKENS.semantic.deck,
                muteGroup: DEFAULT_TOKENS.semantic.muteGroup,
              })
            }
          />
        </FieldRow>
      </div>

      <SectionTitle>Track Color</SectionTitle>
      <FieldRow label="Universal color">
        <span className="dim role-hint">all tracks use ONE color (test the look)</span>
        <Checkbox
          checked={tokens.trackColor.universalEnabled}
          onChange={(v) =>
            update({ ...tokens, trackColor: { ...tokens.trackColor, universalEnabled: v } })
          }
        />
        <input
          type="color"
          className="color-swatch"
          value={tokens.trackColor.universalHex}
          onChange={(e) =>
            update({ ...tokens, trackColor: { ...tokens.trackColor, universalHex: e.target.value } })
          }
        />
      </FieldRow>

      <SectionTitle>Type</SectionTitle>
      <Caption>
        A typeface is judged in company, not alone — a pairing sets both faces at
        once. Anything greyed out is not installed on this machine and would fall
        back silently, so it is shown rather than hidden.
      </Caption>
      <FieldRow label="Pairing">
        <span className="dim role-hint">{pairingNote}</span>
        <Select
          value={pairing}
          options={[
            ...(pairing === "Custom" ? [{ value: "Custom", label: "Custom" }] : []),
            ...TYPE_PAIRINGS.map((p) => ({ value: p.name, label: p.name })),
          ]}
          onChange={applyPairing}
        />
      </FieldRow>
      <FieldRow label="Labels + values">
        <span className="dim role-hint">{valuesFace?.note ?? "the app's dominant voice"}</span>
        <Select
          value={nameForStack(tokens.fontMono)}
          options={faceOptions(nameForStack(tokens.fontMono), true)}
          onChange={(name) => {
            const f = faceByName(name);
            if (f) update({ ...tokens, fontMono: f.stack });
          }}
        />
      </FieldRow>
      <FieldRow label="Prose + titles">
        <span className="dim role-hint">{proseFace?.note ?? "captions and the display step"}</span>
        <Select
          value={nameForStack(tokens.fontUI)}
          options={faceOptions(nameForStack(tokens.fontUI), false)}
          onChange={(name) => {
            const f = faceByName(name);
            if (f) update({ ...tokens, fontUI: f.stack });
          }}
        />
      </FieldRow>

      <Caption>
        The display step is the app's one typographic voice — panel titles, and
        nothing else. Every other step is 10–11px, and no typeface says anything at
        11px, so this is the size at which you actually judge the choice above.
      </Caption>
      <ParamRow
        label="Display size"
        value={tokens.type.display.sizePx}
        display={`${tokens.type.display.sizePx}px`}
        min={11}
        max={34}
        step={1}
        onChange={(v) => setType("display", { sizePx: v })}
      />
      <ParamRow
        label="Display weight"
        value={tokens.type.display.weight}
        display={`${tokens.type.display.weight}`}
        min={200}
        max={800}
        step={100}
        onChange={(v) => setType("display", { weight: v })}
      />
      <ParamRow
        label="Display tracking"
        value={tokens.type.display.trackingEm}
        display={`${tokens.type.display.trackingEm.toFixed(2)}em`}
        min={-0.02}
        max={0.3}
        step={0.01}
        onChange={(v) => setType("display", { trackingEm: v })}
      />
      <FieldRow label="Display case">
        <span className="dim role-hint">uppercase reads as a nameplate; sentence case as a word</span>
        <Checkbox
          checked={tokens.type.display.uppercase}
          onChange={(v) => setType("display", { uppercase: v })}
        />
      </FieldRow>
      <FieldRow label="Display face">
        <span className="dim role-hint">mono keeps the pure-data identity; prose gives it a voice</span>
        <Select
          value={tokens.type.display.family}
          options={[
            { value: "ui", label: "Prose" },
            { value: "mono", label: "Mono" },
          ]}
          onChange={(v) => setType("display", { family: v as "mono" | "ui" })}
        />
      </FieldRow>

      <ParamRow
        label="Label size"
        value={tokens.type.label.sizePx}
        display={`${tokens.type.label.sizePx}px`}
        min={9}
        max={16}
        step={1}
        onChange={(v) =>
          update({
            ...tokens,
            type: {
              ...tokens.type,
              label: { ...tokens.type.label, sizePx: v },
              value: { ...tokens.type.value, sizePx: v },
            },
          })
        }
      />

      <SectionTitle>Controls</SectionTitle>
      <ParamRow
        label="Bar height"
        value={tokens.control.slider.barHeightPx}
        display={`${tokens.control.slider.barHeightPx}px`}
        min={10}
        max={32}
        step={1}
        onChange={(v) =>
          update({
            ...tokens,
            control: { ...tokens.control, slider: { ...tokens.control.slider, barHeightPx: v } },
          })
        }
      />
      <ParamRow
        label="Fill strength"
        value={tokens.control.slider.fillMixPct}
        display={`${tokens.control.slider.fillMixPct}%`}
        min={20}
        max={100}
        step={1}
        onChange={(v) =>
          update({
            ...tokens,
            control: { ...tokens.control, slider: { ...tokens.control.slider, fillMixPct: v } },
          })
        }
      />
      <ParamRow
        label="Row height"
        value={tokens.control.density.rowHeightPx}
        display={`${tokens.control.density.rowHeightPx}px`}
        min={20}
        max={40}
        step={1}
        onChange={(v) =>
          update({
            ...tokens,
            control: { ...tokens.control, density: { ...tokens.control.density, rowHeightPx: v } },
          })
        }
      />
      <ParamRow
        label="Drag sensitivity"
        value={tokens.control.dragBox.dragSensitivity}
        display={`${tokens.control.dragBox.dragSensitivity.toFixed(2)}×`}
        min={0.25}
        max={3}
        step={0.05}
        onChange={(v) =>
          update({
            ...tokens,
            control: { ...tokens.control, dragBox: { ...tokens.control.dragBox, dragSensitivity: v } },
          })
        }
      />
      <FieldRow label="Drag-box double-click reset">
        <Checkbox
          checked={tokens.control.dragBox.doubleClickReset}
          onChange={(v) =>
            update({
              ...tokens,
              control: { ...tokens.control, dragBox: { ...tokens.control.dragBox, doubleClickReset: v } },
            })
          }
        />
      </FieldRow>

      <WaveformStudio link={link} tokens={tokens} update={update} />

      <SectionTitle>Background Image</SectionTitle>
      <Caption>
        Painted once, natively, behind every panel — the pages go glass while an
        image is live. Opacity is the veil: lower = more ground, less picture.
      </Caption>
      <FieldRow label="Image">
        <Button label="Choose…" onClick={chooseBackground} />
        <Button label="Remove" onClick={clearBackground} disabled={!bgImage} />
      </FieldRow>
      <FieldRow label="Mode">
        <Select
          value={tokens.background.imageMode}
          options={[
            { value: "fill", label: "Fill (crop)" },
            { value: "fit", label: "Fit (letterbox)" },
            { value: "stretch", label: "Stretch" },
            { value: "tile", label: "Tile" },
            { value: "tileMirror", label: "Tile · mirrored" },
          ]}
          onChange={(v) =>
            updateBackground({ imageMode: v as DesignTokens["background"]["imageMode"] })
          }
        />
      </FieldRow>
      <ParamRow
        label="Image opacity"
        value={tokens.background.imageOpacity}
        display={`${(tokens.background.imageOpacity * 100).toFixed(0)}%`}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => updateBackground({ imageOpacity: v })}
      />
      {(tokens.background.imageMode === "tile" ||
        tokens.background.imageMode === "tileMirror") && (
        <>
          <FieldRow label="Tile size by">
            <span className="dim role-hint">
              count = repeat the image N times across the width
            </span>
            <Select
              value={tokens.background.tileSizing}
              options={[
                { value: "scale", label: "Scale (% of image)" },
                { value: "count", label: "Count (tiles across)" },
              ]}
              onChange={(v) =>
                updateBackground({
                  tileSizing: v as DesignTokens["background"]["tileSizing"],
                })
              }
            />
          </FieldRow>
          {tokens.background.tileSizing === "scale" ? (
            <ParamRow
              label="Tile size"
              value={tokens.background.tileScalePct}
              display={`${tokens.background.tileScalePct.toFixed(0)}%`}
              min={25}
              max={400}
              step={5}
              onChange={(v) => updateBackground({ tileScalePct: v })}
            />
          ) : (
            <ParamRow
              label="Tiles across"
              value={tokens.background.tileCountPerRow}
              display={`${tokens.background.tileCountPerRow.toFixed(0)}×`}
              min={1}
              max={16}
              step={1}
              onChange={(v) => updateBackground({ tileCountPerRow: Math.round(v) })}
            />
          )}
        </>
      )}
      <FieldRow label="Motion">
        <Select
          value={tokens.background.motion}
          options={[
            { value: "none", label: "Still" },
            { value: "drift", label: "Drift (slow pan)" },
            { value: "breathe", label: "Breathe (slow zoom)" },
          ]}
          onChange={(v) =>
            updateBackground({ motion: v as DesignTokens["background"]["motion"] })
          }
        />
      </FieldRow>
      <FieldRow label="Bass shake">
        <Button
          label={tokens.background.shakeEnabled ? "On" : "Off"}
          active={tokens.background.shakeEnabled}
          onClick={() => updateBackground({ shakeEnabled: !tokens.background.shakeEnabled })}
        />
      </FieldRow>
      {tokens.background.shakeEnabled && (
        <ParamRow
          label="Shake intensity"
          value={tokens.background.shakeIntensityPct}
          display={`${tokens.background.shakeIntensityPct.toFixed(0)}%`}
          min={0}
          max={100}
          step={5}
          onChange={(v) => updateBackground({ shakeIntensityPct: v })}
        />
      )}

      <SectionTitle>Reset</SectionTitle>
      <FieldRow label="">
        <Button
          label="Reset all tokens to defaults"
          onClick={() => {
            update(DEFAULT_TOKENS);
            pushBackgroundStyle(DEFAULT_TOKENS.background);
          }}
        />
      </FieldRow>

      <SectionTitle>Preview</SectionTitle>
      <ParamRow
        label="Sample param"
        value={0.62}
        display="≈240 ms"
        min={0}
        max={1}
        step={0.01}
        onChange={() => {}}
      />
      <div className="preview-row">
        <Button label="Button" onClick={() => {}} />
        <Button label="Active" active onClick={() => {}} />
        <span className="ds-value">1.00</span>
        <span className="dim ds-value">value</span>
      </div>
    </main>
  );
}
