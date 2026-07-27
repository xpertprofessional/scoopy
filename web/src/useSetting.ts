import { useCallback, useEffect, useState } from "react";
import type { EngineLink } from "./engineLink.ts";

/**
 * React binding for one UserDefaults-backed setting over the SLP
 * getSetting/setSetting Commands. Optimistic local state; the stored
 * value loads once on mount. `parse` guards the untyped wire value.
 */
export function useSetting<T>(
  link: EngineLink | null,
  key: string,
  fallback: T,
  parse: (raw: unknown) => T | undefined,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    link
      .command("getSetting", { key })
      .then((raw) => {
        if (cancelled) return;
        const wrapped = raw as { value?: unknown };
        const parsed = parse(wrapped?.value);
        if (parsed !== undefined) setValue(parsed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, key]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      link?.command("setSetting", { key, value: next }).catch(() => {});
    },
    [link, key],
  );

  return [value, update];
}

export const asNumber = (raw: unknown): number | undefined =>
  typeof raw === "number" ? raw : undefined;

export const asString = (raw: unknown): string | undefined =>
  typeof raw === "string" ? raw : undefined;

export const asBoolean = (raw: unknown): boolean | undefined =>
  typeof raw === "boolean" ? raw : undefined;
