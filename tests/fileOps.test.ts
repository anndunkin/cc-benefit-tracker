// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getDatabase, openDatabaseAt, closeDatabase, cardsGetAll, programsGetAll, cardDelete } from '../electron/database';
import { createFileOps, MAX_IMPORT_BYTES } from '../electron/fileOps';
import type { FileOps, PickOptions, ConfirmOptions } from '../electron/fileOps';
import { chooseStartupPath, readLastDbPath, inspectDatabaseFile } from '../electron/fileStore';

let dir: string;
let ops: FileOps;
let nextSave: string | null;
let nextOpen: string | null;
let confirmAnswer: boolean;
let asked: { save: PickOptions[]; open: PickOptions[]; confirm: ConfirmOptions[] };
let afterOpen: ReturnType<typeof vi.fn>;
let shown: string[];
let logs: string[];

const p = (name: string) => path.join(dir, name);
const def = () => p('cc-benefit-tracker.db');
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const setNote = (v: string) => getDatabase().prepare(`UPDATE cards SET notes = ? WHERE id = 'hilton_aspire'`).run(v);
const liveNote = () => (getDatabase().prepare(`SELECT notes FROM cards WHERE id = 'hilton_aspire'`).get() as { notes: string | null }).notes;
/** What a backup tool would see: the .db file on its own, without the write-ahead log. */
function noteInFileAlone(file: string): string | null {
  const lone = p(`lone-${crypto.randomUUID()}.db`);
  fs.copyFileSync(file, lone);
  const db = new Database(lone, { readonly: true });
  try { return (db.prepare(`SELECT notes FROM cards WHERE id = 'hilton_aspire'`).get() as { notes: string | null }).notes; }
  finally { db.close(); fs.rmSync(lone, { force: true }); }
}

function makeOps(): FileOps {
  return createFileOps({
    pickSave: async o => { asked.save.push(o); return nextSave; },
    pickOpen: async o => { asked.open.push(o); return nextOpen; },
    confirm: async o => { asked.confirm.push(o); return confirmAnswer; },
    showInFolder: f => { shown.push(f); },
    settingsDir: dir,
    defaultDbPath: def(),
    suggestedDir: path.join(dir, 'Documents'),
    afterOpen,
    log: m => { logs.push(m); },
    today: () => '2026-11-22',
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-fileops-'));
  nextSave = null; nextOpen = null; confirmAnswer = false;
  asked = { save: [], open: [], confirm: [] };
  afterOpen = vi.fn(); shown = []; logs = [];
  ops = makeOps();
  ops.openAtStartup(def());
});
afterEach(() => {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('startup', () => {
  it('opens the default file and does not record it as a remembered file', () => {
    expect(ops.currentPath()).toBe(def());
    expect(cardsGetAll(getDatabase()).length).toBeGreaterThan(0);
    expect(readLastDbPath(dir)).toBeNull();
    expect(afterOpen).not.toHaveBeenCalled();
  });
});

describe('Save', () => {
  it('makes the single .db file complete and names it', async () => {
    await ops.save();
    setNote('typed-then-saved');
    expect(noteInFileAlone(def())).not.toBe('typed-then-saved');
    const r = await ops.save();
    expect(r).toEqual({ success: true, filePath: def(), message: `Saved to ${def()}` });
    expect(noteInFileAlone(def())).toBe('typed-then-saved');
    expect(asked.save).toHaveLength(0);
  });

  it('does not report success when the file has been moved or deleted behind the app', async () => {
    setNote('orphaned');
    fs.renameSync(def(), p('renamed-elsewhere.db'));
    const r = await ops.save();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no longer where it was/);
    expect(r.error).toMatch(/Save As/);
    // Save As still rescues the data.
    nextSave = p('rescued.db');
    expect((await ops.saveAs()).success).toBe(true);
    expect(liveNote()).toBe('orphaned');
    expect(noteInFileAlone(p('rescued.db'))).toBe('orphaned');
  });

  it('does not report success while another program is reading the file', async () => {
    await ops.save();
    const reader = new Database(def(), { readonly: true });
    try {
      reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM cards').get();
      setNote('blocked');
      const r = await ops.save();
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/in use by another program/);
      reader.exec('COMMIT');
    } finally { reader.close(); }
    expect((await ops.save()).success).toBe(true);
    expect(noteInFileAlone(def())).toBe('blocked');
  });
});

describe('Save As', () => {
  it('copies everything to the new file, switches to it and remembers it', async () => {
    setNote('before-save-as');
    nextSave = p('moved.db');
    const r = await ops.saveAs();
    expect(r.success).toBe(true);
    expect(r.filePath).toBe(p('moved.db'));
    expect(r.reload).toBeUndefined();          // same data: the open page and any open editor are left alone
    expect(r.message).toMatch(/will reopen it next time/);
    expect(ops.currentPath()).toBe(p('moved.db'));
    expect(liveNote()).toBe('before-save-as');
    expect(readLastDbPath(dir)).toBe(p('moved.db'));
    expect(asked.save[0].defaultPath).toBe(path.join(dir, 'Documents', 'cc-benefit-tracker.db'));
    // An existing database is not "fresh": the refresh is offered for review, not applied.
    expect(afterOpen).toHaveBeenCalledWith(false);

    // New work goes to the new file; the original keeps what it had.
    setNote('after-save-as');
    await ops.save();
    expect(noteInFileAlone(p('moved.db'))).toBe('after-save-as');
    const original = new Database(def(), { readonly: true });
    try { expect((original.prepare(`SELECT notes FROM cards WHERE id = 'hilton_aspire'`).get() as { notes: string }).notes).toBe('before-save-as'); }
    finally { original.close(); }
  });

  it('is reopened on the next launch', async () => {
    nextSave = p('moved.db');
    await ops.saveAs();
    setNote('survives-restart');
    closeDatabase();
    const next = makeOps();
    const choice = chooseStartupPath(dir, def());
    expect(choice).toEqual({ path: p('moved.db'), unavailable: null, reason: null });
    next.openAtStartup(choice.path);
    expect(next.currentPath()).toBe(p('moved.db'));
    expect(liveNote()).toBe('survives-restart');
  });

  it('treats saving over the open file as a plain Save', async () => {
    setNote('same-file');
    nextSave = def();
    const r = await ops.saveAs();
    expect(r.success).toBe(true);
    expect(r.reload).toBeUndefined();
    expect(ops.currentPath()).toBe(def());
    expect(noteInFileAlone(def())).toBe('same-file');
    expect(liveNote()).toBe('same-file');
  });

  it('does nothing when cancelled, and rejects a name that is not .db', async () => {
    expect(await ops.saveAs()).toEqual({ success: false });
    nextSave = p('report.txt');
    const r = await ops.saveAs();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/\.db/);
    expect(fs.existsSync(p('report.txt'))).toBe(false);
    expect(ops.currentPath()).toBe(def());
  });

  it('replaces an existing tracker file only once the new one is complete', async () => {
    setNote('first');
    nextSave = p('target.db');
    await ops.saveCopy();                       // an existing good file at the destination
    const before = sha(p('target.db'));
    setNote('second');

    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === p('target.db')) throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' });
      return realRename(from, to);
    });
    const failed = await ops.saveAs();
    expect(failed.success).toBe(false);
    expect(failed.error).toMatch(/Nothing at that location was changed/);
    expect(sha(p('target.db'))).toBe(before);
    expect(ops.currentPath()).toBe(def());
    expect(liveNote()).toBe('second');
    vi.restoreAllMocks();

    const ok = await ops.saveAs();
    expect(ok.success).toBe(true);
    expect(ops.currentPath()).toBe(p('target.db'));
    expect(liveNote()).toBe('second');
  });

  it('works for a file whose cards have all been deleted, and the result can be reopened', async () => {
    for (const c of cardsGetAll(getDatabase())) cardDelete(getDatabase(), c.id);
    expect(cardsGetAll(getDatabase())).toHaveLength(0);
    const programs = programsGetAll(getDatabase()).length;
    expect(programs).toBeGreaterThan(0);
    nextSave = p('no-cards.db');
    const r = await ops.saveAs();
    expect(r.success).toBe(true);
    expect(ops.currentPath()).toBe(p('no-cards.db'));
    // Not reseeded: the deleted cards stay deleted and the programs are intact.
    expect(cardsGetAll(getDatabase())).toHaveLength(0);
    expect(programsGetAll(getDatabase())).toHaveLength(programs);
    // And it opens again on the next launch.
    closeDatabase();
    const next = makeOps();
    next.openAtStartup(chooseStartupPath(dir, def()).path);
    expect(next.currentPath()).toBe(p('no-cards.db'));
    expect(cardsGetAll(getDatabase())).toHaveLength(0);
    expect(programsGetAll(getDatabase())).toHaveLength(programs);
  });

  it('says so when the new location could not be recorded for next time', async () => {
    fs.mkdirSync(p('cc-benefit-tracker-settings.json'));     // a folder where the settings file should go
    nextSave = p('moved.db');
    const r = await ops.saveAs();
    expect(r.success).toBe(true);
    expect(ops.currentPath()).toBe(p('moved.db'));
    expect(r.message).not.toMatch(/will reopen it next time/);
    expect(r.message).toMatch(/could not be recorded/);
    expect(readLastDbPath(dir)).toBeNull();
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps working in the current file when the copy fails', async () => {
    setNote('still-here');
    nextSave = path.join(dir, 'missing-folder', 'x.db');
    const r = await ops.saveAs();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/folder does not exist/);
    expect(ops.currentPath()).toBe(def());
    expect(liveNote()).toBe('still-here');
    expect(readLastDbPath(dir)).toBeNull();
    expect(logs.join('\n')).toMatch(/file:saveAs/);
  });
});

describe('Save a Backup Copy', () => {
  it('writes a dated copy and keeps working in the current file', async () => {
    setNote('backed-up');
    nextSave = p('backup.db');
    const r = await ops.saveCopy();
    expect(r.success).toBe(true);
    expect(r.reload).toBeUndefined();
    expect(asked.save[0].defaultPath).toBe(path.join(dir, 'Documents', 'cc-benefit-tracker-backup-2026-11-22.db'));
    expect(ops.currentPath()).toBe(def());
    expect(readLastDbPath(dir)).toBeNull();
    expect(inspectDatabaseFile(p('backup.db'))).toBe('tracker');
    expect(noteInFileAlone(p('backup.db'))).toBe('backed-up');
    setNote('after-backup');
    expect(noteInFileAlone(p('backup.db'))).toBe('backed-up');
    expect(afterOpen).not.toHaveBeenCalled();
  });

  it('refuses to write the copy over the open file', async () => {
    setNote('unharmed');
    nextSave = def();
    const r = await ops.saveCopy();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/already have open/);
    expect(liveNote()).toBe('unharmed');
  });
});

describe('New File', () => {
  it('starts a new seeded file, leaves the previous one intact and remembers the new one', async () => {
    setNote('old-file-data');
    nextSave = p('fresh.db');
    const r = await ops.newFile();
    expect(r.success).toBe(true);
    expect(r.reload).toBe(true);
    expect(ops.currentPath()).toBe(p('fresh.db'));
    expect(cardsGetAll(getDatabase()).length).toBeGreaterThan(0);
    expect(liveNote()).not.toBe('old-file-data');
    expect(afterOpen).toHaveBeenCalledWith(true);
    expect(readLastDbPath(dir)).toBe(p('fresh.db'));
    const previous = new Database(def(), { readonly: true });
    try { expect((previous.prepare(`SELECT notes FROM cards WHERE id = 'hilton_aspire'`).get() as { notes: string }).notes).toBe('old-file-data'); }
    finally { previous.close(); }
  });

  it('will not wipe the file that is open, however the same file is named', async () => {
    setNote('do-not-wipe');
    await ops.save();
    fs.symlinkSync(dir, p('alias'), 'junction');
    fs.linkSync(def(), p('second-name.db'));
    const sameFile = [
      def(),
      path.join(dir, 'alias', 'cc-benefit-tracker.db'),     // through a folder link
      p('second-name.db'),                                    // a second name for the same file
    ];
    for (const name of sameFile) {
      nextSave = name;
      const r = await ops.newFile();
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/file you have open/);
      expect(ops.currentPath()).toBe(def());
      expect(liveNote()).toBe('do-not-wipe');
      expect(noteInFileAlone(def())).toBe('do-not-wipe');
    }
    // The same guard protects Save a Backup Copy.
    nextSave = path.join(dir, 'alias', 'cc-benefit-tracker.db');
    expect((await ops.saveCopy()).error).toMatch(/already have open/);
    expect(liveNote()).toBe('do-not-wipe');
  });

  it('replaces a different, closed file completely', async () => {
    fs.writeFileSync(p('reuse.db'), 'old content');
    nextSave = p('reuse.db');
    const r = await ops.newFile();
    expect(r.success).toBe(true);
    expect(inspectDatabaseFile(p('reuse.db'))).toBe('tracker');
    expect(cardsGetAll(getDatabase()).length).toBeGreaterThan(0);
    expect(fs.readdirSync(dir).filter(f => /\.saving|\.replaced/.test(f))).toEqual([]);
  });

  it('will not replace a file that is open in another program or was not closed cleanly', async () => {
    setNote('current');
    const live = new Database(p('live.db'));
    try {
      live.pragma('journal_mode = WAL');
      live.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('only-in-the-log');`);
      const before = { main: sha(p('live.db')), wal: sha(p('live.db-wal')) };
      for (const attempt of [() => ops.newFile(), () => ops.saveAs(), () => ops.saveCopy()]) {
        nextSave = p('live.db');
        const r = await attempt();
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/was not replaced/);
        expect({ main: sha(p('live.db')), wal: sha(p('live.db-wal')) }).toEqual(before);
        expect(ops.currentPath()).toBe(def());
        expect(liveNote()).toBe('current');
      }
      expect((live.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('only-in-the-log');
    } finally { live.close(); }
    expect(afterOpen).not.toHaveBeenCalled();
  });

  it('leaves an existing file untouched, and stays in the current file, when the new one cannot be put in place', async () => {
    setNote('current');
    nextSave = p('existing.db');
    await ops.saveCopy();
    const before = sha(p('existing.db'));
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === p('existing.db')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realRename(from, to);
    });
    const r = await ops.newFile();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Nothing at that location was changed/);
    expect(sha(p('existing.db'))).toBe(before);
    expect(ops.currentPath()).toBe(def());
    expect(liveNote()).toBe('current');
    expect(afterOpen).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir).filter(f => /\.saving|\.replaced/.test(f))).toEqual([]);

    nextSave = path.join(dir, 'no-such-folder', 'x.db');
    expect((await ops.newFile()).error).toMatch(/folder does not exist/);
  });
});

describe('Open File', () => {
  async function makeSecondFile(): Promise<string> {
    setNote('second-file');
    nextSave = p('second.db');
    await ops.saveCopy();
    setNote('first-file');
    return p('second.db');
  }

  it('switches to a tracker file and remembers it', async () => {
    nextOpen = await makeSecondFile();
    const r = await ops.openFile();
    expect(r).toMatchObject({ success: true, filePath: p('second.db'), reload: true });
    expect(ops.currentPath()).toBe(p('second.db'));
    expect(liveNote()).toBe('second-file');
    expect(readLastDbPath(dir)).toBe(p('second.db'));
    expect(afterOpen).toHaveBeenCalledWith(false);
  });

  it('going back to the default file clears the remembered file', async () => {
    nextOpen = await makeSecondFile();
    await ops.openFile();
    nextOpen = def();
    await ops.openFile();
    expect(ops.currentPath()).toBe(def());
    expect(liveNote()).toBe('first-file');
    expect(readLastDbPath(dir)).toBeNull();
  });

  it('does nothing when the chosen file is already open', async () => {
    nextOpen = def();
    const r = await ops.openFile();
    expect(r.success).toBe(true);
    expect(r.reload).toBeUndefined();
    expect(r.message).toMatch(/already open/);
    expect(afterOpen).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a database and keeps the current file open', async () => {
    setNote('still-open');
    fs.writeFileSync(p('letter.db'), 'Dear Ann, this is not a database. '.repeat(100));
    const before = sha(p('letter.db'));
    nextOpen = p('letter.db');
    const r = await ops.openFile();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not be read as a Credit Card Benefit Tracker file/);
    expect(sha(p('letter.db'))).toBe(before);
    expect(ops.currentPath()).toBe(def());
    expect(liveNote()).toBe('still-open');
    setNote('and-writable');
    expect(liveNote()).toBe('and-writable');
    expect(readLastDbPath(dir)).toBeNull();
  });

  it("refuses another program's database without adding tracker tables to it", async () => {
    const other = new Database(p('invoices.db'));
    other.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY, total REAL); INSERT INTO invoices (total) VALUES (99);`);
    other.close();
    const before = sha(p('invoices.db'));
    nextOpen = p('invoices.db');
    const r = await ops.openFile();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/another program/);
    expect(sha(p('invoices.db'))).toBe(before);
    expect(ops.currentPath()).toBe(def());
  });

  it('refuses a look-alike database and leaves it byte-for-byte unchanged', async () => {
    const other = new Database(p('lookalike.db'));
    other.exec(`CREATE TABLE cards (id INTEGER PRIMARY KEY, suit TEXT); CREATE TABLE programs (id INTEGER PRIMARY KEY, channel TEXT);
      CREATE TABLE benefits (id INTEGER PRIMARY KEY, employee TEXT); CREATE TABLE usages (id INTEGER PRIMARY KEY, kwh REAL);`);
    other.close();
    const before = sha(p('lookalike.db'));
    nextOpen = p('lookalike.db');
    const r = await ops.openFile();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/another program/);
    expect(sha(p('lookalike.db'))).toBe(before);
    expect(fs.existsSync(p('lookalike.db-wal'))).toBe(false);
    expect(ops.currentPath()).toBe(def());
  });

  it('refuses an empty file, a wrong extension and a file that has vanished', async () => {
    fs.writeFileSync(p('zero.db'), '');
    nextOpen = p('zero.db');
    expect((await ops.openFile()).error).toMatch(/empty/);
    expect(fs.statSync(p('zero.db')).size).toBe(0);
    nextOpen = p('notes.txt');
    expect((await ops.openFile()).error).toMatch(/\.db/);
    nextOpen = p('vanished.db');
    expect((await ops.openFile()).error).toMatch(/no longer exists/);
    expect(await (async () => { nextOpen = null; return ops.openFile(); })()).toEqual({ success: false });
    expect(ops.currentPath()).toBe(def());
  });

  it('does not create a new tracker in place of a picked file that has vanished', () => {
    setNote('guarded');
    expect(() => openDatabaseAt(p('vanished.db'), { mustExist: true })).toThrow();
    expect(fs.existsSync(p('vanished.db'))).toBe(false);
    expect(liveNote()).toBe('guarded');
    // The same protection applies to a remembered file at startup; only the default file is created.
    const next = makeOps();
    expect(() => next.openAtStartup(p('remembered-but-gone.db'))).toThrow();
    expect(fs.existsSync(p('remembered-but-gone.db'))).toBe(false);
    expect(liveNote()).toBe('guarded');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses a read-only file instead of switching to a file that cannot record anything', async () => {
    setNote('second');
    nextSave = p('locked.db');
    await ops.saveCopy();
    setNote('first');
    fs.chmodSync(p('locked.db'), 0o400);
    nextOpen = p('locked.db');
    const r = await ops.openFile();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/read-only/);
    expect(ops.currentPath()).toBe(def());
    expect(liveNote()).toBe('first');
    setNote('still-writable');
    expect(liveNote()).toBe('still-writable');
    expect(readLastDbPath(dir)).toBeNull();
  });

  it('openDatabaseAt keeps the previous database open when the new one cannot be opened', () => {
    setNote('guarded');
    fs.writeFileSync(p('garbage.db'), 'garbage '.repeat(500));
    expect(() => openDatabaseAt(p('garbage.db'))).toThrow();
    expect(liveNote()).toBe('guarded');
  });
});

describe('Export and Import JSON', () => {
  async function exportTo(name: string): Promise<string> {
    nextSave = p(name);
    const r = await ops.exportJson();
    expect(r.success).toBe(true);
    return p(name);
  }

  it('exports a file that can be read back', async () => {
    setNote('exported');
    const file = await exportTo('out.json');
    const payload = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(payload.cards.find((c: { id: string }) => c.id === 'hilton_aspire').notes).toBe('exported');
    expect(asked.save[0].defaultPath).toBe(path.join(dir, 'Documents', 'cc-benefit-tracker-export-2026-11-22.json'));
    expect(fs.readdirSync(dir).filter(f => f.includes('.saving'))).toEqual([]);
  });

  it('asks before replacing data and changes nothing when the answer is no', async () => {
    setNote('in-export');
    nextOpen = await exportTo('out.json');
    setNote('current-work');
    confirmAnswer = false;
    const r = await ops.importJson();
    expect(r).toEqual({ success: false });
    expect(asked.confirm).toHaveLength(1);
    expect(asked.confirm[0].confirmLabel).toBe('Replace my data');
    expect(asked.confirm[0].detail).toContain(def());
    expect(asked.confirm[0].detail).toContain(p('out.json'));
    expect(asked.confirm[0].detail).toMatch(/cannot be undone/);
    expect(liveNote()).toBe('current-work');
    expect(afterOpen).not.toHaveBeenCalled();
  });

  it('replaces the data only after a yes', async () => {
    setNote('in-export');
    nextOpen = await exportTo('out.json');
    setNote('current-work');
    confirmAnswer = true;
    const r = await ops.importJson();
    expect(r).toMatchObject({ success: true, reload: true });
    expect(liveNote()).toBe('in-export');
    expect(ops.currentPath()).toBe(def());
    expect(afterOpen).toHaveBeenCalledWith(false);
  });

  it('rejects files that are not tracker exports before asking anything', async () => {
    setNote('untouched');
    confirmAnswer = true;
    const cases: Array<[string, string | Buffer, RegExp]> = [
      ['bad.json', '{ this is not json', /not valid JSON/],
      ['list.json', '[1,2,3]', /not a tracker export/],
      ['other.json', JSON.stringify({ hello: 'world' }), /not a tracker export/],
      ['v9.json', JSON.stringify({ version: 9, cards: [], programs: [], benefits: [], usages: [] }), /file format/],
    ];
    for (const [name, body, pattern] of cases) {
      fs.writeFileSync(p(name), body);
      nextOpen = p(name);
      const r = await ops.importJson();
      expect(r.success).toBe(false);
      expect(r.error).toMatch(pattern);
    }
    nextOpen = p('wrong.txt');
    expect((await ops.importJson()).error).toMatch(/\.json/);
    nextOpen = p('gone.json');
    expect((await ops.importJson()).error).toMatch(/no longer exists/);
    fs.writeFileSync(p('huge.json'), '');
    fs.truncateSync(p('huge.json'), MAX_IMPORT_BYTES + 1);
    nextOpen = p('huge.json');
    expect((await ops.importJson()).error).toMatch(/too large/);
    expect(asked.confirm).toHaveLength(0);
    expect(liveNote()).toBe('untouched');
  });

  it('rolls back completely when an approved import turns out to be damaged', async () => {
    nextOpen = await exportTo('out.json');
    const payload = JSON.parse(fs.readFileSync(nextOpen, 'utf-8'));
    payload.usages.push({ id: 'broken', benefit_id: 'no-such-benefit', used_on: 'not-a-date', amount_usd: 1, period_key: 'x', notes: null, created_at: 'x', quantity: 1 });
    fs.writeFileSync(nextOpen, JSON.stringify(payload));
    setNote('must-survive');
    const cardsBefore = cardsGetAll(getDatabase()).length;
    confirmAnswer = true;
    const r = await ops.importJson();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/nothing was changed/);
    expect(liveNote()).toBe('must-survive');
    expect(cardsGetAll(getDatabase()).length).toBe(cardsBefore);
  });
});

describe('other behaviour', () => {
  it('shows the open file in its folder', async () => {
    const r = await ops.showInFolder();
    expect(r.success).toBe(true);
    expect(shown).toEqual([def()]);
  });

  it('runs one file command at a time', async () => {
    let release!: (v: string | null) => void;
    const slow = createFileOps({
      pickSave: () => new Promise<string | null>(res => { release = res; }),
      pickOpen: async () => null, confirm: async () => false, showInFolder: () => {},
      settingsDir: dir, defaultDbPath: def(), suggestedDir: dir, afterOpen: () => {}, log: () => {},
    });
    const first = slow.saveAs();
    await Promise.resolve();
    expect(await slow.save()).toEqual({ success: false });
    release(null);
    expect(await first).toEqual({ success: false });
    expect((await slow.save()).success).toBe(true);
  });

  it('still switches files when the follow-up step fails', async () => {
    afterOpen.mockImplementation(() => { throw new Error('refresh offer blew up'); });
    nextSave = p('moved.db');
    const r = await ops.saveAs();
    expect(r.success).toBe(true);
    expect(ops.currentPath()).toBe(p('moved.db'));
    expect(logs.join('\n')).toMatch(/afterOpen failed/);
  });
});
