// Link and navigation policy (v1.0.29).
//
// Links come from the bundled benefit data, from refresh files, from what the
// user types and from data files the user imports. Only ordinary web links may
// be opened. Anything else (file:, javascript:, data:, ms-msdt:, a custom app
// protocol, a Windows path) could open or run something on the computer, so it
// is never handed to the operating system and never shown as a clickable link.
//
// This module has no Node or Electron dependencies so the window code, the
// data layer and the pages can all share it.

/** Longest link accepted. Real benefit pages are far shorter. */
export const MAX_LINK_LENGTH = 2048;

/** True for an absolute http:// or https:// link with a host name and no embedded user name or password. */
export function isSafeWebLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === '' || v.length > MAX_LINK_LENGTH || v !== value) return false;
  // Control characters and spaces never belong in a link and are used to hide the real target.
  if (/[\u0000-\u0020\u007f-\u009f]/.test(v)) return false;
  if (!/^https?:\/\//i.test(v)) return false;
  let url: URL;
  try { url = new URL(v); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false;
  return true;
}

/** The link if it is a safe web link, otherwise null. Used where data is loaded rather than typed. */
export function safeWebLinkOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return isSafeWebLink(v) ? v : null;
}

/**
 * Checks a link the user typed. Blank means "no link". Anything else must be a
 * safe web link, otherwise the save is refused with a message saying why.
 */
export function requireWebLinkOrBlank(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a web link`);
  const v = value.trim();
  if (v === '') return null;
  if (!isSafeWebLink(v)) throw new Error(`${field} must be a web link starting with https:// or http://`);
  return v;
}

/**
 * True if the window may show this address: only the app's own page (any
 * in-app #route), or the development server while developing.
 */
export function isAppPageUrl(target: string, appPageUrl: string, devOrigin: string | null): boolean {
  let t: URL, app: URL;
  try { t = new URL(target); app = new URL(appPageUrl); } catch { return false; }
  if (devOrigin) {
    try { if (t.origin === new URL(devOrigin).origin) return true; } catch { /* fall through */ }
  }
  if (t.protocol !== 'file:' || app.protocol !== 'file:') return false;
  // Same file, ignoring the #route. Windows paths compare without regard to case.
  const norm = (u: URL) => decodeURIComponent(u.pathname).replace(/\\/g, '/').toLowerCase();
  return t.host === app.host && norm(t) === norm(app) && t.search === '';
}
