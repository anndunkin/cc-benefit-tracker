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
 * Guard: return true if the given absolute path lives inside the assets
 * directory (blocks any `..` traversal in a computed icon path).
 */
export function iconPathWithinAssets(candidate: string, dirname: string = __dirname): boolean {
  try {
    const dir = assetsDir(dirname);
    const rel = path.relative(dir, path.resolve(candidate));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
  let resourcesPath = opts?.resourcesPath ?? (typeof process !== 'undefined' ? (process as any).resourcesPath : undefined) ?? '';
  const dirname = opts?.dirname ?? __dirname;

  if (isPackaged === undefined) {
    try {
      // Lazy require so this module can be loaded outside Electron.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron');
      isPackaged = Boolean(electron?.app?.isPackaged);
      if (!resourcesPath) resourcesPath = (electron as any)?.app?.getAppPath?.() ?? '';
    } catch {
      isPackaged = false;
    }
  }

  const candidates: string[] = [];
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'assets', ICON_FILE));
    candidates.push(path.join(resourcesPath, 'assets', 'icon.ico'));
  }
  const dev = assetsDir(dirname);
  candidates.push(path.join(dev, ICON_FILE));
  candidates.push(path.join(dev, 'icon.ico'));

  for (const c of candidates) {
    if (iconPathWithinAssets(c, dirname) && fs.existsSync(c)) return c;
  }
  // Return the dev fallback path even if it doesn't exist yet — Electron will
  // fall back to a default icon and the guard above ensures it's inside assets/.
  return path.join(dev, ICON_FILE);
}
