// File operations behind the File menu and the Settings page (v1.0.25).
//
// Everything that needs Electron (dialogs, the shell, where the settings live)
// is passed in, so the real behaviour is exercised against real SQLite files in
// tests/fileOps.test.ts. No path ever comes from the renderer: every file is
// chosen in a native dialog shown by the main process.
import fs from 'fs';
import path from 'path';
import {
  getDatabase, openDatabaseAt, lastOpenWasFresh, createFreshDatabaseFile, buildFilePayload, importFilePayload,
} from './database';
import {
  samePath, inspectDatabaseFile, openProblem, flushToDisk, copyDatabaseTo,
  removeDatabaseFiles, replaceDatabaseFile, tempNameFor, writeLastDbPath,
} from './fileStore';
import { APP_FILE_VERSION } from './types';
import type { AppFilePayload, FileResult } from './types';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export interface PickOptions {
  title: string;
  defaultPath?: string;
  filterName: string;
  extension: 'db' | 'json';
}

export interface ConfirmOptions {
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
}

export interface FileOpsDeps {
  /** Ask where to save. Resolves to null when the user cancels. */
  pickSave: (o: PickOptions) => Promise<string | null>;
  /** Ask which file to open. Resolves to null when the user cancels. */
  pickOpen: (o: PickOptions) => Promise<string | null>;
  /** Ask before something that replaces data. Resolves to true only on an explicit yes. */
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  showInFolder: (filePath: string) => void;
  /** Folder that holds the default file and the remembered-file setting. */
  settingsDir: string;
  defaultDbPath: string;
  /** Folder suggested for Save As and backup copies. */
  suggestedDir: string;
  /** Called after a different file becomes the open one (fresh = just created). */
  afterOpen: (fresh: boolean) => void;
  log: (msg: string) => void;
  today?: () => string;
}

/** `reload` tells the window to re-read everything because the data changed underneath it. */
export type FileOpResult = FileResult & { reload?: boolean };

export interface FileOps {
  currentPath: () => string;
  /** Open the file chosen at startup. Not a user action; no dialogs. */
  openAtStartup: (dbPath: string) => void;   // creates the file only when it is the default one
  newFile: () => Promise<FileOpResult>;
  openFile: () => Promise<FileOpResult>;
  save: () => Promise<FileOpResult>;
  saveAs: () => Promise<FileOpResult>;
  saveCopy: () => Promise<FileOpResult>;
  exportJson: () => Promise<FileOpResult>;
  importJson: () => Promise<FileOpResult>;
  showInFolder: () => Promise<FileOpResult>;
}

const CANCELLED: FileOpResult = { success: false };
const DB_FILTER = 'Benefit Tracker File';

function hasExtension(p: string, ext: string): boolean {
  return path.extname(p).toLowerCase() === `.${ext}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createFileOps(deps: FileOpsDeps): FileOps {
  let current = deps.defaultDbPath;
  let busy = false;
  const today = deps.today ?? (() => new Date().toISOString().slice(0, 10));

  const NOT_REMEMBERED = ' The location could not be recorded, so next time use File > Open File to return to it.';

  function remember(): boolean {
    try { writeLastDbPath(deps.settingsDir, current, deps.defaultDbPath); return true; }
    catch (err) { deps.log(`could not remember the file in use: ${errorText(err)}`); return false; }
  }

  /** Make `dbPath` the open file. Returns false when it could not be recorded for next launch. */
  function switchTo(dbPath: string, fresh?: boolean): boolean {
    openDatabaseAt(dbPath, { mustExist: true });   // throws and leaves the old file open if this fails
    current = dbPath;
    const remembered = remember();
    try { deps.afterOpen(fresh ?? lastOpenWasFresh()); } catch (err) { deps.log(`afterOpen failed: ${errorText(err)}`); }
    return remembered;
  }

  /** Save: make the one .db file complete. Refuses to claim success for a file that is gone. */
  function saveNow(): FileOpResult {
    if (!fs.existsSync(current)) {
      return { success: false, error: `The file is no longer where it was: ${current}. It may have been moved, renamed or deleted. Use File > Save As to write your data to a new file.` };
    }
    flushToDisk(getDatabase());
    return { success: true, filePath: current, message: `Saved to ${current}` };
  }

  /** One file operation at a time; failures become a readable result, never a throw. */
  async function run(name: string, op: () => Promise<FileOpResult>): Promise<FileOpResult> {
    if (busy) return CANCELLED;
    busy = true;
    try { return await op(); }
    catch (err) {
      deps.log(`file:${name} ${errorText(err)}`);
      return { success: false, error: errorText(err) };
    } finally { busy = false; }
  }

  return {
    currentPath: () => current,

    openAtStartup(dbPath: string): void {
      // Only the default file may be created; a remembered file must already be there.
      openDatabaseAt(dbPath, { mustExist: !samePath(dbPath, deps.defaultDbPath) });
      current = dbPath;
    },

    newFile: () => run('new', async () => {
      const chosen = await deps.pickSave({
        title: 'New Benefit Tracker File',
        defaultPath: path.join(deps.suggestedDir, 'cc-benefit-tracker.db'),
        filterName: DB_FILTER, extension: 'db',
      });
      if (!chosen) return CANCELLED;
      if (!hasExtension(chosen, 'db')) return { success: false, error: 'A tracker file name must end in .db.' };
      if (samePath(chosen, current)) {
        return { success: false, error: 'That is the file you have open now, so it was left alone. Choose a different name to start a new file.' };
      }
      const folder = path.dirname(chosen);
      if (!fs.existsSync(folder)) return { success: false, error: `The folder does not exist: ${folder}` };
      const previous = current;
      // Build the new file beside its destination and move it into place only
      // when it is complete, so a failure never damages a file already there.
      // (The save dialog has already asked before replacing an existing file.)
      const tmp = tempNameFor(chosen);
      removeDatabaseFiles(tmp);
      try {
        createFreshDatabaseFile(tmp);
        replaceDatabaseFile(tmp, chosen);
      } finally { removeDatabaseFiles(tmp); }
      const remembered = switchTo(chosen, true);
      return {
        success: true, filePath: chosen, reload: true,
        message: `New file created: ${chosen}. Your previous file is unchanged: ${previous}` + (remembered ? '' : `.${NOT_REMEMBERED}`),
      };
    }),

    openFile: () => run('open', async () => {
      const chosen = await deps.pickOpen({ title: 'Open Benefit Tracker File', filterName: DB_FILTER, extension: 'db' });
      if (!chosen) return CANCELLED;
      if (!hasExtension(chosen, 'db')) return { success: false, error: 'Choose a tracker file ending in .db.' };
      if (samePath(chosen, current)) return { success: true, filePath: current, message: `That file is already open: ${current}` };
      const problem = openProblem(inspectDatabaseFile(chosen));
      if (problem) return { success: false, error: problem };
      const remembered = switchTo(chosen);
      return { success: true, filePath: chosen, reload: true, message: `Opened ${chosen}` + (remembered ? '' : `.${NOT_REMEMBERED}`) };
    }),

    save: () => run('save', async () => saveNow()),

    saveAs: () => run('saveAs', async () => {
      const chosen = await deps.pickSave({
        title: 'Save Benefit Tracker File As',
        defaultPath: path.join(deps.suggestedDir, path.basename(current)),
        filterName: DB_FILTER, extension: 'db',
      });
      if (!chosen) return CANCELLED;
      if (!hasExtension(chosen, 'db')) return { success: false, error: 'A tracker file name must end in .db.' };
      if (samePath(chosen, current)) {
        // Saving over the open file is just Save.
        return saveNow();
      }
      await copyDatabaseTo(getDatabase(), current, chosen);
      let remembered: boolean;
      try { remembered = switchTo(chosen); }
      catch (err) {
        throw new Error(`A copy was saved to ${chosen}, but the tracker could not switch to it and is still working in ${current}. (${errorText(err)})`);
      }
      // Same data in a new place: the window only needs the new path, not a reload.
      return {
        success: true, filePath: chosen,
        message: remembered
          ? `Saved as ${chosen}. The tracker now works in this file and will reopen it next time.`
          : `Saved as ${chosen}. The tracker now works in this file.${NOT_REMEMBERED}`,
      };
    }),

    saveCopy: () => run('saveCopy', async () => {
      const chosen = await deps.pickSave({
        title: 'Save a Backup Copy',
        defaultPath: path.join(deps.suggestedDir, `cc-benefit-tracker-backup-${today()}.db`),
        filterName: DB_FILTER, extension: 'db',
      });
      if (!chosen) return CANCELLED;
      if (!hasExtension(chosen, 'db')) return { success: false, error: 'A tracker file name must end in .db.' };
      await copyDatabaseTo(getDatabase(), current, chosen);
      return {
        success: true, filePath: chosen,
        message: `Backup copy saved to ${chosen}. The tracker is still working in ${current}`,
      };
    }),

    exportJson: () => run('exportJson', async () => {
      const chosen = await deps.pickSave({
        title: 'Export Data as JSON',
        defaultPath: path.join(deps.suggestedDir, `cc-benefit-tracker-export-${today()}.json`),
        filterName: 'JSON', extension: 'json',
      });
      if (!chosen) return CANCELLED;
      if (!hasExtension(chosen, 'json')) return { success: false, error: 'An export file name must end in .json.' };
      const payload = buildFilePayload(getDatabase());
      const tmp = `${chosen}.${process.pid}.saving`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
        fs.renameSync(tmp, chosen);
      } finally { fs.rmSync(tmp, { force: true }); }
      return { success: true, filePath: chosen, message: `Exported to ${chosen}` };
    }),

    importJson: () => run('importJson', async () => {
      const chosen = await deps.pickOpen({ title: 'Import Data from JSON', filterName: 'JSON', extension: 'json' });
      if (!chosen) return CANCELLED;
      if (!hasExtension(chosen, 'json')) return { success: false, error: 'Choose an export file ending in .json.' };
      let stat: fs.Stats;
      try { stat = fs.statSync(chosen); } catch { return { success: false, error: 'That file no longer exists.' }; }
      if (!stat.isFile()) return { success: false, error: 'That is not a file.' };
      if (stat.size > MAX_IMPORT_BYTES) return { success: false, error: 'That file is too large to be a tracker export.' };
      let payload: AppFilePayload;
      try { payload = JSON.parse(fs.readFileSync(chosen, 'utf-8')) as AppFilePayload; }
      catch { return { success: false, error: 'That file is not a tracker export (it is not valid JSON). Nothing was changed.' }; }
      const lists = ['cards', 'programs', 'benefits', 'usages'] as const;
      if (!payload || typeof payload !== 'object' || lists.some(k => !Array.isArray((payload as unknown as Record<string, unknown>)[k]))) {
        return { success: false, error: 'That file is not a tracker export. Nothing was changed.' };
      }
      if (payload.version !== APP_FILE_VERSION) {
        return { success: false, error: `That export uses a file format this version cannot read (version ${String(payload.version)}). Nothing was changed.` };
      }
      const ok = await deps.confirm({
        title: 'Import from JSON',
        message: 'Replace everything in the open file with this import?',
        detail:
          `Import: ${chosen}\n(${payload.cards.length} cards, ${payload.programs.length} programs, ` +
          `${payload.benefits.length} benefits, ${payload.usages.length} usage entries)\n\n` +
          `Open file: ${current}\n\n` +
          'All cards, programs, benefits and usage history now in the open file will be removed and replaced. ' +
          'This cannot be undone. To keep what you have, cancel and use File > Save a Backup Copy first.',
        confirmLabel: 'Replace my data',
      });
      if (!ok) return CANCELLED;
      try { importFilePayload(getDatabase(), payload); }   // one transaction: all or nothing
      catch (err) { throw new Error(`The import could not be read, so nothing was changed. (${errorText(err)})`); }
      try { deps.afterOpen(false); } catch (err) { deps.log(`afterOpen failed: ${errorText(err)}`); }
      return { success: true, filePath: chosen, reload: true, message: `Imported ${chosen} into ${current}` };
    }),

    showInFolder: () => run('showInFolder', async () => {
      if (!fs.existsSync(current)) return { success: false, error: `The file is not on disk yet: ${current}` };
      deps.showInFolder(current);
      return { success: true, filePath: current };
    }),
  };
}
