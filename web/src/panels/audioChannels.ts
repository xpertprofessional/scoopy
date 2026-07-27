/**
 * Hardware input-channel option helpers, shared by the Audio pane and the
 * mixer's INPUT strip (MIX-R3) so the two surfaces can never drift on what a
 * given device offers.
 *
 * Channels are 0-indexed on the wire (`setAudioInputChannelConfig.startChannel`,
 * `AudioDeviceManager.selectedInputStartChannel`) and 1-indexed in labels.
 */

/** Mono channels, or stereo pairs, for a device with `total` input channels. */
export function channelOptions(total: number, stereo: boolean) {
  if (!stereo) {
    return Array.from({ length: total }, (_, i) => ({ value: i, label: `${i + 1}` }));
  }
  const options: { value: number; label: string }[] = [];
  for (let ch = 0; ch + 1 < total; ch += 2) {
    options.push({ value: ch, label: `${ch + 1}/${ch + 2}` });
  }
  return options;
}

/**
 * One flat list of every input source a device offers — stereo pairs AND mono
 * channels — for the mixer's single INPUT picker. The strip has room for one
 * control, not the Audio pane's mono/stereo + channel pair; encoding the mode
 * into the option value keeps it to one "which input?" question.
 *
 * Value form: `"s:<startChannel>"` (stereo pair) | `"m:<channel>"` (mono).
 */
export type InputSourceOption = { value: string; label: string };

export function inputSourceOptions(total: number): InputSourceOption[] {
  return [
    ...channelOptions(total, true).map((o) => ({ value: `s:${o.value}`, label: `IN ${o.label}` })),
    ...channelOptions(total, false).map((o) => ({ value: `m:${o.value}`, label: `IN ${o.label} MONO` })),
  ];
}

/** Encode the current selection into an `inputSourceOptions` value. */
export function inputSourceValue(startChannel: number, stereo: boolean): string {
  return `${stereo ? "s" : "m"}:${startChannel}`;
}

/** Decode a picked option back into the `setAudioInputChannelConfig` params. */
export function parseInputSource(raw: string): { startChannel: number; stereo: boolean } {
  const [mode, ch] = raw.split(":");
  return { startChannel: Number(ch), stereo: mode === "s" };
}
