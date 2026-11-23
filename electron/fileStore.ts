// File management helpers (v1.0.25). No Electron imports, so every function
// here is unit-tested directly (tests/fileStore.test.ts).
//
// The tracker's data is one SQLite file. Changes are written to it as they are
// made, so "Save" does not copy anything: it folds SQLite's write-ahead log
// into the main file so that the single .db file is complete on disk (which is
// what a backup tool or a cloud-sync folder picks up).
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const SETTINGS_FILE = 'cc-benefit-tracker-settings.json';

/** What a file on disk is, judged without modifying it. */
export type FileKind =
  | 'tracker'   // a Credit Card Benefit Tracker database
  | 'empty'     // a zero-byte file or a SQLite database with no tables
  | 'foreign'   // a SQLite database that belongs to something else
  | 'invalid'   // not a SQLite database, or unreadable
  | 'missing';

/**
 * The real location of a path: links, folder junctions and, on Windows, letter
 * case are resolved. Works for a file that does not exist yet by resolving its
 * folder.
 */
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); }
  catch {
    try { real = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)); }
    catch { /* folder missing too: compare as written */ }
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * True when two paths name the same file, however they are spelled: different
 * case on Windows, a path through a link or junction, or a second (hard-linked)
 * name for the same file.
 */
export function samePath(a: string, b: string): boolean {
  if (canonicalPath(a) === canonicalPath(b)) return true;
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch { return false; }
}

/** SQLite's companion files for a database in write-ahead-log mode. */
export function sidecarFiles(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

/** Remove a database file and its companions. Missing files are fine. */
export function removeDatabaseFiles(dbPath: string): void {
  for (const p of [dbPath, ...sidecarFiles(dbPath)]) {
    try { fs.rmSync(p, { force: true }); } catch { /* reported by the caller's next step */ }
  }
}

/** Columns that together identify a tracker file (present since the first release). */
const TRACKER_SIGNATURE: Record<string, string[]> = {
  app_meta: ['key', 'value'],
  cards: ['id', 'name', 'issuer', 'annual_fee_usd'],
  programs: ['id', 'name', 'program_type'],
  benefits: ['id', 'card_id', 'program_id', 'title', 'reset_cadence'],
  usages: ['id', 'benefit_id', 'used_on', 'period_key'],
};

/**
 * Look at a file read-only and say what it is. Used before opening a file the
 * user picked, so that an unrelated database is never given tracker tables and
 * seed data, and a non-database or damaged file never replaces the open one.
 */
export function inspectDatabaseFile(filePath: string): FileKind {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return 'missing'; }
  if (!stat.isFile()) return 'invalid';
  if (stat.size === 0) return 'empty';
  // Reading a database can make SQLite create companion files beside it. Note
  // which ones were already there so that only the ones this look created are
  // tidied away afterwards.
  const createdByProbe = sidecarFiles(filePath).filter(f => !fs.existsSync(f));
  let probe: Database.Database | null = null;
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const tables = (probe.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
      .map(t => t.name);
    if (tables.length === 0) return 'empty';
    for (const [table, columns] of Object.entries(TRACKER_SIGNATURE)) {
      if (!tables.includes(table)) return 'foreign';
      const have = (probe.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(c => c.name);
      if (!columns.every(c => have.includes(c))) return 'foreign';
    }
    // Every tracker file since the first release records the catalog version it was seeded from.
    const stamp = probe.prepare(`SELECT value FROM app_meta WHERE key = 'seed_version'`).get() as { value: unknown } | undefined;
    if (!stamp || typeof stamp.value !== 'string' || !/^\d+\.\d+\.\d+$/.test(stamp.value)) return 'foreign';
    const check = probe.pragma('quick_check', { simple: true });
    return check === 'ok' ? 'tracker' : 'invalid';
  } catch {
    return 'invalid';
  } finally {
    try { probe?.close(); } catch { /* ignore */ }
    for (const f of createdByProbe) {
      try { if (fs.existsSync(f) && (f.endsWith('-shm') || fs.statSync(f).size === 0)) fs.rmSync(f, { force: true }); }
      catch { /* in use by another program: leave it */ }
    }
  }
}

/** Plain-language reason a picked file cannot be opened, or null when it can. */
export function openProblem(kind: FileKind): string | null {
  switch (kind) {
    case 'tracker': return null;
    case 'missing': return 'That file no longer exists.';
    case 'empty': return 'That file is empty. Use New File to start a new tracker file.';
    case 'foreign': return 'That file is a database from another program, not a Credit Card Benefit Tracker file. It was not changed.';
    default: return 'That file could not be read as a Credit Card Benefit Tracker file. It may be a different kind of file, damaged, or in a folder that does not allow changes. It was not changed.';
  }
}

/**
 * Fold the write-ahead log into the main file so the .db file is complete on
 * disk. Throws if SQLite could not finish (another program is reading the
 * file), so "saved" is never reported when it is not true.
 */
export function flushToDisk(db: Database.Database): void {
  // Wait briefly, not the usual five seconds, if another program is reading the file.
  const usualWait = Number(db.pragma('busy_timeout', { simple: true }));
  let rows: Array<{ busy: number }>;
  try {
    db.pragma('busy_timeout = 1000');
    rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  } finally {
    db.pragma(`busy_timeout = ${Number.isFinite(usualWait) && usualWait >= 0 ? Math.floor(usualWait) : 5000}`);
  }
  if (rows[0] && rows[0].busy !== 0) {
    throw new Error('The file is in use by another program, so the save could not be completed. Your changes are still recorded; close the other program and choose Save again.');
  }
}

/** Name of the temporary file used while writing `dest`, in the same folder. */
export function tempNameFor(dest: string): string {
  return path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.saving`);
}

function sizeOf(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Put a finished database file (`tmp`) in place of `dest`.
 *
 * Nothing at the destination is deleted or moved beforehand. If the file there
 * has a non-empty write-ahead log or rollback journal, it is open in a program
 * or was not closed cleanly and holds changes that exist only in those files;
 * replacing it could lose them, so it is refused and left untouched. Otherwise
 * the new file takes the old one's place in a single step, which either
 * happens completely or not at all. Leftover companions that hold no data are
 * cleared afterwards so they cannot be mistaken for the new file's.
 */
export function replaceDatabaseFile(tmp: string, dest: string): void {
  const wal = `${dest}-wal`;
  const journal = `${dest}-journal`;
  if (sizeOf(wal) > 0 || sizeOf(journal) > 0) {
    throw new Error(`${dest} is in use by a program or was not closed cleanly, so it was not replaced. Nothing at that location was changed. Choose a different file name, or open that file in the tracker once (File > Open File) and then try again.`);
  }
  try { fs.renameSync(tmp, dest); }
  catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`The file could not be written to ${dest}. It may be open in another program, or the folder may not allow changes. Nothing at that location was changed. (${why})`);
  }
  for (const empty of [wal, `${dest}-shm`, journal]) {
    try { fs.rmSync(empty, { force: true }); } catch { /* holds no data; SQLite rebuilds it */ }
  }
}

/**
 * Write a complete copy of the open database to `dest`.
 *
 * The copy is made with SQLite's online backup into a temporary file next to
 * the destination, checked, and only then moved into place, so a failed save
 * never leaves a half-written file where a good one used to be.
 */
export async function copyDatabaseTo(db: Database.Database, currentPath: string, dest: string): Promise<void> {
  if (samePath(currentPath, dest)) {
    throw new Error('That is the file you already have open. Choose a different name or folder.');
  }
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) throw new Error(`The folder does not exist: ${dir}`);
  const tmp = tempNameFor(dest);
  removeDatabaseFiles(tmp);
  try {
    await db.backup(tmp);
    if (inspectDatabaseFile(tmp) !== 'tracker') throw new Error('The copy could not be verified, so nothing was replaced.');
    replaceDatabaseFile(tmp, dest);
  } finally {
    removeDatabaseFiles(tmp);
  }
}

// ─── Remembering the file in use ──────────────────────────────────────────────

interface StoredSettings { last_db_path?: string }

function readSettings(settingsDir: string): StoredSettings {
  try {
    const raw = fs.readFileSync(path.join(settingsDir, SETTINGS_FILE), 'utf-8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));   // tolerate a byte-order mark from a text editor
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredSettings : {};
  } catch { return {}; }
}

/** The file the user last worked in, or null when none was recorded. */
export function readLastDbPath(settingsDir: string): string | null {
  const p = readSettings(settingsDir).last_db_path;
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return null;
  if (!path.isAbsolute(p) || path.extname(p).toLowerCase() !== '.db') return null;
  return p;
}

/** Record the file in use. Passing the default path clears the record. Throws if it cannot be written. */
export function writeLastDbPath(settingsDir: string, dbPath: string, defaultPath: string): void {
  const file = path.join(settingsDir, SETTINGS_FILE);
  const next: StoredSettings = { ...readSettings(settingsDir) };
  if (samePath(dbPath, defaultPath)) delete next.last_db_path;
  else next.last_db_path = path.resolve(dbPath);
  fs.mkdirSync(settingsDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export interface StartupChoice {
  /** The file to open. */
  path: string;
  /** The remembered file that could not be used, when there was one. */
  unavailable: string | null;
  /** Why it could not be used, in plain words. */
  reason: string | null;
}

/**
 * Decide which file to open at launch: the file last used if it is still a
 * tracker file, otherwise the default file. Never returns a file that
 * `inspectDatabaseFile` would refuse. The remembered file is not forgotten
 * here: a drive or sync folder that is temporarily unavailable should work
 * again next time unless the user says otherwise.
 */
export function chooseStartupPath(settingsDir: string, defaultPath: string): StartupChoice {
  const last = readLastDbPath(settingsDir);
  if (!last || samePath(last, defaultPath)) return { path: defaultPath, unavailable: null, reason: null };
  const kind = inspectDatabaseFile(last);
  if (kind === 'tracker') return { path: last, unavailable: null, reason: null };
  return {
    path: defaultPath,
    unavailable: last,
    reason: kind === 'missing'
      ? 'It may have been moved, renamed or deleted, or its drive or sync folder is not available right now.'
      : 'It is no longer a readable Credit Card Benefit Tracker file.',
  };
}
