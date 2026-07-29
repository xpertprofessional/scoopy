/**
 * P3-C1 — the compose window's ADDRESS, as it rides `__slPanelArg`.
 *
 * The shell's user-script sanitizer keeps exactly `A–Za–z0–9_-`
 * (MergedMain.cpp:150-152), which is precisely the unpadded base64url
 * alphabet — so a base64url-encoded JSON travels the existing injection with
 * zero shell changes. Padding (`=`) would be EATEN by the sanitizer, so the
 * codec is strictly unpadded; session names are arbitrary unicode, so the
 * JSON goes through UTF-8 bytes, not raw `btoa`.
 */

export type ComposeArg = { deck: number; session: string }

export function encodeComposeArg(arg: ComposeArg): string {
  const bytes = new TextEncoder().encode(JSON.stringify(arg))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeComposeArg(raw: string | undefined | null): ComposeArg | null {
  if (!raw) return null
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ComposeArg>
    if (typeof parsed.deck !== 'number' || typeof parsed.session !== 'string') return null
    return { deck: parsed.deck, session: parsed.session }
  } catch {
    // A malformed address must read as "unaddressed", never crash the window.
    return null
  }
}
