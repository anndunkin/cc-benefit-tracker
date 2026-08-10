import path from 'path';
import fs from 'fs';

/** Base filename used for the app icon. Not user-controlled. */
export const ICON_FILE = 'icon.png';

/** The assets directory, computed relative to this compiled module. */
export function assetsDir(dirname: string = __dirname): string {
  // In dev this file lives at <repo>/electron/iconPath.ts; in a packaged app it
  // is bundled under <resources>/dist-electron/. We fall back through both.
  return path.resolve(dirname, '..', 'assets');
}

/**
 * Guard: return true if the given absolute path lives inside an assets
 * directory (blocks any `..` traversal in a computed icon path).
 *
 * Accepts BOTH the dev assets directory (siblings of this source file) and a
 * packaged assets directory rooted at `resourcesPath`. This is what lets the
 * packaged app resolve <install>/resources/assets/icon.ico without the guard
 * rejecting it just because it is outside the dev tree.
 */
export function iconPathWithinAssets(
  candidate: string,
  dirname: string = __dirname,
  resourcesPath?: string,
): boolean {
  try {
    const resolved = path.resolve(candidate);
    const allowedRoots = [assetsDir(dirname)];
    if (resourcesPath) allowedRoots.push(path.resolve(resourcesPath, 'assets'));
    for (const root of allowedRoots) {
      const rel = path.relative(root, resolved);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the app icon path. Reads Electron's `app.isPackaged` and
 * `process.resourcesPath` lazily so unit tests can call this without
 * a real Electron runtime.
 */
export function resolveIconPath(opts?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  dirname?: string;
}): string {
  let isPackaged = opts?.isPackaged;
  // Prefer process.resourcesPath: in a packaged build it is <install>/resources,
  // which is where extraResources deposits our assets folder. app.getAppPath()
  // is the wrong value here — it returns <install>/resources/app.asar, and the
  // icon is NOT inside the asar (it is an extraResource sibling).
  let resourcesPath = opts?.resourcesPath
    ?? (typeof process !== 'undefined' ? (process as any).resourcesPath : undefined)
    ?? '';
  const dirname = opts?.dirname ?? __dirname;

  if (isPackaged === undefined) {
    try {
      // Lazy require so this module can be loaded outside Electron.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron');
      isPackaged = Boolean(electron?.app?.isPackaged);
    } catch {
      isPackaged = false;
    }
  }

  // Widen the search when packaged: try process.resourcesPath first (correct
  // location for extraResources), then fall back to the app path (in case a
  // future config change moves the icon into the asar), then dev locations.
  const candidates: string[] = [];
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'assets', 'icon.ico'));
    candidates.push(path.join(resourcesPath, 'assets', ICON_FILE));
  }
  const dev = assetsDir(dirname);
  // On Windows, prefer .ico over .png so BrowserWindow gets a multi-resolution
  // icon with 16/24/32/48/256 all embedded — Electron picks the right size per
  // context (title bar, taskbar, Alt-Tab, jump list) automatically.
  candidates.push(path.join(dev, 'icon.ico'));
  candidates.push(path.join(dev, ICON_FILE));

  for (const c of candidates) {
    if (iconPathWithinAssets(c, dirname, resourcesPath) && fs.existsSync(c)) return c;
  }
  // Return the dev fallback path even if it doesn't exist yet — Electron will
  // fall back to a default icon and the guard above ensures it's inside assets/.
  return path.join(dev, ICON_FILE);
}
