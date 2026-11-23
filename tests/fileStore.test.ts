// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { initSchema, seedIfFresh } from '../electron/database';
import {
  samePath, sidecarFiles, removeDatabaseFiles, inspectDatabaseFile, openProblem, flushToDisk,
  copyDatabaseTo, replaceDatabaseFile, tempNameFor, readLastDbPath, writeLastDbPath, chooseStartupPath, SETTINGS_FILE,
} from '../electron/fileStore';
import { buildFileMenu, FILE_MENU_LABELS } from '../electron/fileMenu';
import type { FileMenuActions } from '../electron/fileMenu';

let dir: string;
const open: Database.Database[] = [];
const p = (name: string) => path.join(dir, name);
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A real tracker file in write-ahead-log mode, like the app's own. */
function trackerFile(name: string): Database.Database {
  const db = new Database(p(name));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seedIfFresh(db);
  open.push(db);
  return db;
}
const note = (db: Database.Database) =>
  (db.prepare(`SELECT notes FROM cards WHERE id = 'hilton_aspire'`).get() as { notes: string | null }).notes;
const setNote = (db: Database.Database, v: string) =>
  db.prepare(`UPDATE cards SET notes = ? WHERE id = 'hilton_aspire'`).run(v);
function readNote(file: string): string | null {
  const db = new Database(file, { readonly: true });
  try { return note(db); } finally { db.close(); }
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-filestore-')); });
afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* ignore */ } }
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('samePath', () => {
  it('treats different spellings of one file as the same file', () => {
    expect(samePath(p('a.db'), path.join(dir, 'sub', '..', 'a.db'))).toBe(true);
    expect(samePath(p('a.db'), p('b.db'))).toBe(false);
  });

  it('sees through a folder link and a second name for the same file', () => {
    fs.mkdirSync(p('real'));
    fs.writeFileSync(path.join(dir, 'real', 'a.db'), 'x');
    fs.symlinkSync(p('real'), p('alias'), 'junction');
    // Genuinely different strings that lead to one file.
    expect(path.join(dir, 'alias', 'a.db')).not.toBe(path.join(dir, 'real', 'a.db'));
    expect(samePath(path.join(dir, 'alias', 'a.db'), path.join(dir, 'real', 'a.db'))).toBe(true);
    // A file that does not exist yet is located through its folder.
    expect(samePath(path.join(dir, 'alias', 'new.db'), path.join(dir, 'real', 'new.db'))).toBe(true);
    expect(samePath(path.join(dir, 'alias', 'new.db'), path.join(dir, 'real', 'other.db'))).toBe(false);
    fs.linkSync(path.join(dir, 'real', 'a.db'), p('second-name.db'));
    expect(samePath(p('second-name.db'), path.join(dir, 'real', 'a.db'))).toBe(true);
    fs.writeFileSync(p('unrelated.db'), 'x');
    expect(samePath(p('unrelated.db'), path.join(dir, 'real', 'a.db'))).toBe(false);
  });

  it('ignores letter case on Windows only', () => {
    const original = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(samePath(p('Tracker.DB'), p('tracker.db'))).toBe(true);
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(samePath(p('Tracker.DB'), p('tracker.db'))).toBe(false);
    } finally { Object.defineProperty(process, 'platform', { value: original }); }
  });
});

describe('inspectDatabaseFile', () => {
  it('recognises a tracker file', () => {
    trackerFile('t.db');
    expect(inspectDatabaseFile(p('t.db'))).toBe('tracker');
    expect(openProblem('tracker')).toBeNull();
  });

  it('reports a missing file, a folder, an empty file and a non-database file', () => {
    expect(inspectDatabaseFile(p('nope.db'))).toBe('missing');
    fs.mkdirSync(p('folder.db'));
    expect(inspectDatabaseFile(p('folder.db'))).toBe('invalid');
    fs.writeFileSync(p('zero.db'), '');
    expect(inspectDatabaseFile(p('zero.db'))).toBe('empty');
    fs.writeFileSync(p('text.db'), 'this is a letter, not a database. '.repeat(200));
    expect(inspectDatabaseFile(p('text.db'))).toBe('invalid');
    for (const kind of ['missing', 'invalid', 'empty', 'foreign'] as const) expect(openProblem(kind)).toMatch(/\w/);
  });

  it('reports a database with no tables as empty', () => {
    const db = new Database(p('blank.db')); db.pragma('user_version = 1'); db.close();
    expect(inspectDatabaseFile(p('blank.db'))).toBe('empty');
  });

  it("refuses another program's database and leaves it byte-for-byte unchanged", () => {
    const other = new Database(p('other.db'));
    other.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL); INSERT INTO invoices (total) VALUES (125.5);`);
    other.close();
    const before = sha(p('other.db'));
    expect(inspectDatabaseFile(p('other.db'))).toBe('foreign');
    expect(sha(p('other.db'))).toBe(before);
    expect(fs.readdirSync(dir).sort()).toEqual(['other.db']);
    expect(openProblem('foreign')).toMatch(/another program/);
  });
});

describe('inspectDatabaseFile, harder cases', () => {
  it('is not fooled by a database that only has tables with the same names', () => {
    const other = new Database(p('lookalike.db'));
    other.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY, suit TEXT, rank TEXT);
      CREATE TABLE programs (id INTEGER PRIMARY KEY, channel TEXT);
      CREATE TABLE benefits (id INTEGER PRIMARY KEY, employee TEXT);
      CREATE TABLE usages (id INTEGER PRIMARY KEY, kwh REAL);
      INSERT INTO cards (suit, rank) VALUES ('hearts', 'queen');`);
    other.close();
    const before = sha(p('lookalike.db'));
    expect(inspectDatabaseFile(p('lookalike.db'))).toBe('foreign');
    expect(sha(p('lookalike.db'))).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['lookalike.db']);
  });

  it('reports a damaged tracker file as unusable', () => {
    const db = trackerFile('t.db');
    flushToDisk(db);
    db.close();
    const bytes = fs.readFileSync(p('t.db'));
    // Wreck the middle of the file but keep the SQLite header.
    bytes.fill(0xab, 4096, Math.min(bytes.length, 4096 * 12));
    fs.writeFileSync(p('t.db'), bytes);
    expect(inspectDatabaseFile(p('t.db'))).toBe('invalid');
  });
});

describe('inspectDatabaseFile, identity', () => {
  it('requires the tracker\'s own version stamp, not just matching table and column names', () => {
    const src = trackerFile('t.db');
    flushToDisk(src);
    src.close(); open.splice(open.indexOf(src), 1);
    fs.copyFileSync(p('t.db'), p('no-stamp.db'));
    const strip = new Database(p('no-stamp.db'));
    strip.prepare(`DELETE FROM app_meta WHERE key = 'seed_version'`).run();
    strip.pragma('journal_mode = DELETE');
    strip.close();
    expect(inspectDatabaseFile(p('t.db'))).toBe('tracker');
    expect(inspectDatabaseFile(p('no-stamp.db'))).toBe('foreign');
  });
});

describe('flushToDisk (Save)', () => {
  it('does not claim success while another program holds the file', () => {
    const db = trackerFile('t.db');
    flushToDisk(db);
    const reader = new Database(p('t.db'), { readonly: true });
    open.push(reader);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM cards').get();      // holds a read snapshot
    setNote(db, 'not-yet-in-main-file');
    const usualWait = db.pragma('busy_timeout', { simple: true });
    const started = Date.now();
    expect(() => flushToDisk(db)).toThrow(/in use by another program/);
    expect(Date.now() - started).toBeLessThan(3000);                 // the window is not frozen for long
    expect(db.pragma('busy_timeout', { simple: true })).toBe(usualWait);
    fs.copyFileSync(p('t.db'), p('alone.db'));
    expect(readNote(p('alone.db'))).not.toBe('not-yet-in-main-file');
    // Nothing is lost, and Save works once the other program lets go.
    reader.exec('COMMIT');
    expect(() => flushToDisk(db)).not.toThrow();
    fs.copyFileSync(p('t.db'), p('alone2.db'));
    expect(readNote(p('alone2.db'))).toBe('not-yet-in-main-file');
  });


  it('puts every change into the single .db file', () => {
    const db = trackerFile('t.db');
    flushToDisk(db);
    setNote(db, 'saved-marker');
    // Before Save the change is only in the write-ahead log.
    expect(fs.statSync(p('t.db-wal')).size).toBeGreaterThan(0);
    fs.copyFileSync(p('t.db'), p('before.db'));
    expect(readNote(p('before.db'))).not.toBe('saved-marker');

    flushToDisk(db);
    expect(fs.statSync(p('t.db-wal')).size).toBe(0);
    fs.copyFileSync(p('t.db'), p('after.db'));
    expect(readNote(p('after.db'))).toBe('saved-marker');
    // Still usable afterwards.
    setNote(db, 'next');
    expect(note(db)).toBe('next');
  });
});

describe('copyDatabaseTo (Save As / backup copy)', () => {
  it('writes a complete, independent copy including changes not yet folded in', async () => {
    const db = trackerFile('t.db');
    setNote(db, 'in-the-log');
    await copyDatabaseTo(db, p('t.db'), p('copy.db'));
    expect(inspectDatabaseFile(p('copy.db'))).toBe('tracker');
    expect(readNote(p('copy.db'))).toBe('in-the-log');
    const count = (file: string, table: string) => {
      const d = new Database(file, { readonly: true });
      try { return (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { d.close(); }
    };
    for (const t of ['cards', 'programs', 'benefits', 'usages']) expect(count(p('copy.db'), t)).toBe(count(p('t.db'), t));
    // Later changes to the original do not reach the copy.
    setNote(db, 'later');
    expect(readNote(p('copy.db'))).toBe('in-the-log');
    // No temporary files are left behind.
    expect(fs.readdirSync(dir).filter(f => f.includes('.saving'))).toEqual([]);
  });

  it('refuses to copy a file onto itself', async () => {
    const db = trackerFile('t.db');
    setNote(db, 'keep');
    await expect(copyDatabaseTo(db, p('t.db'), path.join(dir, '.', 't.db'))).rejects.toThrow(/already have open/);
    expect(note(db)).toBe('keep');
  });

  it('replaces an existing, cleanly closed tracker file', async () => {
    const db = trackerFile('t.db');
    setNote(db, 'new-content');
    const old = trackerFile('old.db');
    setNote(old, 'old-content');
    old.close(); open.splice(open.indexOf(old), 1);
    expect(fs.existsSync(p('old.db-wal'))).toBe(false);          // closed cleanly: one file
    await copyDatabaseTo(db, p('t.db'), p('old.db'));
    expect(fs.readdirSync(dir).sort()).toEqual(['old.db', 't.db', 't.db-shm', 't.db-wal']);
    expect(inspectDatabaseFile(p('old.db'))).toBe('tracker');
    expect(fs.readdirSync(dir).sort()).toEqual(['old.db', 't.db', 't.db-shm', 't.db-wal']);   // looking leaves no litter
    expect(readNote(p('old.db'))).toBe('new-content');
    // Saving the same backup again works, even after something has read it and left empty companions.
    expect(fs.existsSync(p('old.db-shm'))).toBe(true);
    expect(fs.statSync(p('old.db-wal')).size).toBe(0);
    setNote(db, 'newer-content');
    await copyDatabaseTo(db, p('t.db'), p('old.db'));
    expect(fs.existsSync(p('old.db-shm'))).toBe(false);
    expect(fs.existsSync(p('old.db-wal'))).toBe(false);
    expect(readNote(p('old.db'))).toBe('newer-content');
  });

  it('a look at a tracker file does not disturb companions that were already there', () => {
    const live = trackerFile('live.db');
    setNote(live, 'pending');
    const before = sha(p('live.db-wal'));
    expect(inspectDatabaseFile(p('live.db'))).toBe('tracker');
    expect(fs.existsSync(p('live.db-shm'))).toBe(true);
    expect(sha(p('live.db-wal'))).toBe(before);
    expect(note(live)).toBe('pending');
  });

  it('refuses to replace a file that is open elsewhere or was not closed cleanly, and touches nothing', async () => {
    const db = trackerFile('t.db');
    setNote(db, 'new-content');
    // A real file in use: its latest change exists only in its write-ahead log.
    const live = trackerFile('live.db');
    setNote(live, 'only-in-the-log');
    expect(fs.statSync(p('live.db-wal')).size).toBeGreaterThan(0);
    const before = { main: sha(p('live.db')), wal: sha(p('live.db-wal')) };

    await expect(copyDatabaseTo(db, p('t.db'), p('live.db'))).rejects.toThrow(/in use by a program or was not closed cleanly/);
    expect({ main: sha(p('live.db')), wal: sha(p('live.db-wal')) }).toEqual(before);
    expect(note(live)).toBe('only-in-the-log');                   // the other program's data is intact
    setNote(live, 'and-still-writable');
    expect(note(live)).toBe('and-still-writable');
    expect(fs.readdirSync(dir).filter(f => /\.saving|\.replaced/.test(f))).toEqual([]);

    // A leftover rollback journal is treated the same way.
    fs.writeFileSync(p('j.db'), 'x'); fs.writeFileSync(p('j.db-journal'), 'pending rollback');
    await expect(copyDatabaseTo(db, p('t.db'), p('j.db'))).rejects.toThrow(/was not replaced/);
    expect(fs.readFileSync(p('j.db'), 'utf-8')).toBe('x');
    expect(fs.readFileSync(p('j.db-journal'), 'utf-8')).toBe('pending rollback');

    // The same file after a crash: no program has it open, but its log still holds the last change.
    fs.copyFileSync(p('live.db'), p('crashed.db')); fs.copyFileSync(p('live.db-wal'), p('crashed.db-wal'));
    const crashed = { main: sha(p('crashed.db')), wal: sha(p('crashed.db-wal')) };
    await expect(copyDatabaseTo(db, p('t.db'), p('crashed.db'))).rejects.toThrow(/was not replaced/);
    expect({ main: sha(p('crashed.db')), wal: sha(p('crashed.db-wal')) }).toEqual(crashed);
  });

  it('leaves an existing file exactly as it was when the new one cannot be put in place', async () => {
    const db = trackerFile('t.db');
    setNote(db, 'new-content');
    await expect(copyDatabaseTo(db, p('t.db'), path.join(dir, 'no-such-folder', 'x.db'))).rejects.toThrow(/folder does not exist/);
    fs.writeFileSync(p('precious.db'), 'do not lose me');

    // 1. The copy itself fails.
    const backup = vi.spyOn(db, 'backup').mockRejectedValue(new Error('disk full'));
    await expect(copyDatabaseTo(db, p('t.db'), p('precious.db'))).rejects.toThrow(/disk full/);
    backup.mockRestore();
    expect(fs.readFileSync(p('precious.db'), 'utf-8')).toBe('do not lose me');

    // 2. The copy succeeds but the final move is refused (file locked, sync folder, no permission).
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === p('precious.db')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realRename(from, to);
    });
    await expect(copyDatabaseTo(db, p('t.db'), p('precious.db'))).rejects.toThrow(/Nothing at that location was changed/);
    expect(fs.readFileSync(p('precious.db'), 'utf-8')).toBe('do not lose me');
    expect(fs.readdirSync(dir).filter(f => /\.saving|\.replaced/.test(f))).toEqual([]);
  });

  it('replaceDatabaseFile reports a missing source without touching the destination', () => {
    fs.writeFileSync(p('d.db'), 'main');
    expect(() => replaceDatabaseFile(tempNameFor(p('d.db')), p('d.db'))).toThrow(/Nothing at that location was changed/);
    expect(fs.readdirSync(dir)).toEqual(['d.db']);
    expect(fs.readFileSync(p('d.db'), 'utf-8')).toBe('main');
  });
});

describe('removeDatabaseFiles', () => {
  it('removes the file and its companions and tolerates missing ones', () => {
    for (const f of [p('x.db'), ...sidecarFiles(p('x.db'))]) fs.writeFileSync(f, 'x');
    removeDatabaseFiles(p('x.db'));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(() => removeDatabaseFiles(p('x.db'))).not.toThrow();
  });
});

describe('remembering the file in use', () => {
  const def = () => p('cc-benefit-tracker.db');

  it('remembers a file and forgets it when the default file is used again', () => {
    expect(readLastDbPath(dir)).toBeNull();
    writeLastDbPath(dir, p('mine.db'), def());
    expect(readLastDbPath(dir)).toBe(p('mine.db'));
    writeLastDbPath(dir, def(), def());
    expect(readLastDbPath(dir)).toBeNull();
  });

  it('keeps other settings and creates the folder when needed', () => {
    fs.writeFileSync(p(SETTINGS_FILE), JSON.stringify({ something_else: 7 }));
    writeLastDbPath(dir, p('mine.db'), def());
    expect(JSON.parse(fs.readFileSync(p(SETTINGS_FILE), 'utf-8'))).toEqual({ something_else: 7, last_db_path: p('mine.db') });
    const nested = path.join(dir, 'new', 'place');
    writeLastDbPath(nested, p('mine.db'), def());
    expect(readLastDbPath(nested)).toBe(p('mine.db'));
  });

  it('reads a settings file saved by a text editor with a byte-order mark', () => {
    fs.writeFileSync(p(SETTINGS_FILE), '\uFEFF' + JSON.stringify({ last_db_path: p('mine.db') }));
    expect(readLastDbPath(dir)).toBe(p('mine.db'));
  });

  it('ignores a damaged or implausible settings file', () => {
    for (const bad of ['{not json', '[]', '"text"', JSON.stringify({ last_db_path: 42 }),
      JSON.stringify({ last_db_path: 'relative/file.db' }), JSON.stringify({ last_db_path: p('script.exe') }),
      JSON.stringify({ last_db_path: p('x'.repeat(5000) + '.db') })]) {
      fs.writeFileSync(p(SETTINGS_FILE), bad);
      expect(readLastDbPath(dir)).toBeNull();
    }
  });

  it('cleans up and reports when the setting cannot be written', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EPERM'); });
    expect(() => writeLastDbPath(dir, p('mine.db'), def())).toThrow(/EPERM/);
    vi.restoreAllMocks();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(readLastDbPath(dir)).toBeNull();
  });

  it('opens the default file when nothing is remembered', () => {
    expect(chooseStartupPath(dir, def())).toEqual({ path: def(), unavailable: null, reason: null });
  });

  it('reopens the remembered file when it is still a tracker file', () => {
    trackerFile('mine.db');
    writeLastDbPath(dir, p('mine.db'), def());
    expect(chooseStartupPath(dir, def())).toEqual({ path: p('mine.db'), unavailable: null, reason: null });
  });

  it('falls back to the default file, says why, and does not forget the remembered file', () => {
    writeLastDbPath(dir, p('gone.db'), def());
    const gone = chooseStartupPath(dir, def());
    expect(gone.path).toBe(def());
    expect(gone.unavailable).toBe(p('gone.db'));
    expect(gone.reason).toMatch(/moved, renamed or deleted/);
    // A drive or sync folder that comes back is picked up again next time.
    expect(readLastDbPath(dir)).toBe(p('gone.db'));
    trackerFile('gone.db');
    expect(chooseStartupPath(dir, def())).toEqual({ path: p('gone.db'), unavailable: null, reason: null });

    fs.writeFileSync(p('broken.db'), 'not a database at all '.repeat(100));
    writeLastDbPath(dir, p('broken.db'), def());
    const broken = chooseStartupPath(dir, def());
    expect(broken.path).toBe(def());
    expect(broken.unavailable).toBe(p('broken.db'));
    expect(broken.reason).toMatch(/no longer a readable/);
  });
});

describe('File menu', () => {
  const names = ['newFile', 'openFile', 'save', 'saveAs', 'saveCopy', 'exportJson', 'importJson', 'showInFolder'] as const;
  function menu(isMac = false) {
    const actions = Object.fromEntries(names.map(n => [n, vi.fn()])) as unknown as Record<(typeof names)[number], ReturnType<typeof vi.fn>>;
    const built = buildFileMenu(actions as unknown as FileMenuActions, isMac);
    return { actions, items: built.submenu as Array<Record<string, any>>, built };
  }

  it('offers every file command, in order, with the usual shortcuts', () => {
    const { items, built } = menu();
    expect(built.label).toBe('&File');
    expect(items.filter(i => i.type !== 'separator').map(i => i.label)).toEqual([
      'New File…', 'Open File…', 'Save', 'Save As…', 'Save a Backup Copy…',
      'Export to JSON…', 'Import from JSON…', 'Show File in Folder', 'E&xit',
    ]);
    const shortcut = (label: string) => items.find(i => i.label === label)!.accelerator;
    expect(shortcut(FILE_MENU_LABELS.newFile)).toBe('CmdOrCtrl+N');
    expect(shortcut(FILE_MENU_LABELS.openFile)).toBe('CmdOrCtrl+O');
    expect(shortcut(FILE_MENU_LABELS.save)).toBe('CmdOrCtrl+S');
    expect(shortcut(FILE_MENU_LABELS.saveAs)).toBe('CmdOrCtrl+Shift+S');
    expect(items[items.length - 1].role).toBe('quit');
    expect(menu(true).items.at(-1)!.role).toBe('close');
  });

  it('runs exactly the matching command for each item', () => {
    const { actions, items } = menu();
    for (const n of names) {
      items.find(i => i.label === FILE_MENU_LABELS[n])!.click();
      expect(actions[n]).toHaveBeenCalledTimes(1);
    }
    for (const n of names) expect(actions[n]).toHaveBeenCalledTimes(1);
  });
});
