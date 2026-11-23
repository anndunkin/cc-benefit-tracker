import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  getDatabase, closeDatabase, lastOpenWasFresh,
  cardsGetAll, cardGetById, cardCreate, cardUpdate, cardDelete, cardSetVisible,
  programsGetAll, programGetById, programCreate, programUpdate, programDelete,
  benefitsGetAll, benefitsForCard, benefitsForProgram, benefitGetById,
  benefitCreate, benefitUpdate, benefitDelete, benefitGetChoices, benefitSetChoices,
  usagesForBenefit, usageCreate, usageUpdate, usageDelete,
  computeProjections,
  refreshGetStatus, refreshStartRun, refreshPendingChanges,
  refreshApproveChange, refreshRejectChange, refreshApplyRun, refreshDiscardRun,
  applyDataMigrations,
  pointsCurrenciesGetAll, pointsCurrencyGetById, pointsCurrencyCreate,
  pointsCurrencyUpdate, pointsCurrencyDelete,
} from './database';
import type {
  CardInput, ProgramInput, BenefitInput, UsageInput, FileResult, FileChangeInfo,
  PointsCurrencyInput,
} from './types';
import { chooseStartupPath, writeLastDbPath } from './fileStore';
import { createFileOps } from './fileOps';
import type { FileOpResult, PickOptions } from './fileOps';
import { buildFileMenu } from './fileMenu';
import { resolveIconPath } from './iconPath';
import { offerBundledProposals, importProposalText, MAX_PROPOSAL_BYTES } from './refreshProposal';
import type { RefreshProposalResult } from './types';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const APP_USER_MODEL_ID = 'com.dunkinglobal.ccbenefittracker';

function appIconPath(): string {
  return resolveIconPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    dirname: __dirname,
  });
}

function defaultDbPath(): string {
  return path.join(app.getPath('userData'), 'cc-benefit-tracker.db');
}

function logError(msg: string): void {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'cc-benefit-tracker-error.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * v1.0.24: after a database is opened, offer the benefit refresh bundled with
 * this version. Existing data gets a draft run to review (nothing is changed
 * until the user approves it); a brand-new database starts from the refreshed
 * catalog. A failure here must never stop the app from opening.
 */
function offerBundledRefresh(fresh: boolean): void {
  try {
    const r = offerBundledProposals(getDatabase(), { fresh });
    logError(`bundled refresh: ${JSON.stringify({ state: r.state, run_id: r.run_id, proposed: r.proposed, already_current: r.already_current, unmatched: r.unmatched.length })}`);
  } catch (err) { logError(`bundled refresh failed: ${err}`); }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Credit Card Benefit Tracker',
    icon: appIconPath(),
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    const indexPath = path.join(app.getAppPath(), 'dist', 'index.html');
    logError(`Loading: ${indexPath} (exists: ${fs.existsSync(indexPath)})`);
    win.loadFile(indexPath).catch(err => logError(`loadFile error: ${err}`));
  }

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' file:; " +
          "script-src 'self' 'unsafe-inline' file:; " +
          "style-src 'self' 'unsafe-inline' file:; " +
          "font-src 'self' file: data:; " +
          "img-src 'self' file: data:; " +
          "connect-src 'self' file:;",
        ],
      },
    });
  });

  win.webContents.on('will-navigate', (event, url) => {
    try {
      const parsedUrl = new URL(url);
      if (isDev && parsedUrl.origin === 'http://localhost:5173') return;
      if (parsedUrl.protocol === 'file:') return;
    } catch { /* ignore */ }
    event.preventDefault();
    shell.openExternal(url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logError(`render-process-gone: ${JSON.stringify(details)}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logError(`did-fail-load: ${code} ${desc} url=${url}`);
  });
  return win;
}

function showAboutDialog(): void {
  const win = activeWindow();
  const version = app.getVersion();
  const electronVersion = process.versions.electron;
  const nodeVersion = process.versions.node;
  const chromeVersion = process.versions.chrome;
  const detail = [
    `Version ${version}`,
    '',
    'Credit Card Benefit Tracker',
    'Dunkin Global Advisors',
    '',
    `Electron ${electronVersion}`,
    `Node ${nodeVersion}`,
    `Chromium ${chromeVersion}`,
    '',
    'https://github.com/anndunkin/cc-benefit-tracker',
  ].join('\n');
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'About Credit Card Benefit Tracker',
    message: 'Credit Card Benefit Tracker',
    detail,
    buttons: ['Copy version', 'Close'],
    defaultId: 1,
    cancelId: 1,
    icon: appIconPath(),
  }).then(res => {
    if (res.response === 0) {
      const { clipboard } = require('electron');
      clipboard.writeText(`Credit Card Benefit Tracker v${version}`);
    }
  }).catch(err => logError(`about dialog error: ${err}`));
}

function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const aboutItem: MenuItemConstructorOptions = {
    label: `About Credit Card Benefit Tracker`,
    click: () => showAboutDialog(),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        aboutItem,
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    buildFileMenu({
      newFile: () => { void fromMenu(fileOps.newFile); },
      openFile: () => { void fromMenu(fileOps.openFile); },
      save: () => { void fromMenu(fileOps.save); },
      saveAs: () => { void fromMenu(fileOps.saveAs); },
      saveCopy: () => { void fromMenu(fileOps.saveCopy); },
      exportJson: () => { void fromMenu(fileOps.exportJson); },
      importJson: () => { void fromMenu(fileOps.importJson); },
      showInFolder: () => { void fromMenu(fileOps.showInFolder); },
    }, isMac),
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: '&Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal('https://github.com/anndunkin/cc-benefit-tracker').catch(() => { /* ignore */ }),
        },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/anndunkin/cc-benefit-tracker/issues/new').catch(() => { /* ignore */ }),
        },
        ...(isMac ? [] : [{ type: 'separator' as const }, aboutItem]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
  app.setAboutPanelOptions({
    applicationName: 'Credit Card Benefit Tracker',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: 'Dunkin Global Advisors',
    website: 'https://github.com/anndunkin/cc-benefit-tracker',
  });
  buildAppMenu();
  let startupProblem: StartupProblem | null;
  try { startupProblem = openStartupFile(); }
  catch (err) {
    logError(`could not open the data file: ${err}`);
    dialog.showErrorBox('Credit Card Benefit Tracker',
      `The data file could not be opened:\n${defaultDbPath()}\n\n${err instanceof Error ? err.message : String(err)}\n\n` +
      'Details are in cc-benefit-tracker-error.log in the same folder.');
    app.exit(1);
    return;
  }
  logError(`data migrations: ${JSON.stringify(applyDataMigrations(getDatabase()))}`);
  offerBundledRefresh(lastOpenWasFresh());
  const win = createWindow();
  if (startupProblem) {
    const problem = startupProblem;
    // Wait until the window is on screen so the message is not hidden behind it.
    win.webContents.once('did-finish-load', () => reportStartupProblem(win, problem));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => logError(`app.whenReady error: ${err}`));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Leave one complete .db file behind: fold the write-ahead log in and close.
app.on('will-quit', () => { closeDatabase(); });

// ─── Cards ───────────────────────────────────────────────────────────────────
ipcMain.handle('cards:getAll', () => cardsGetAll(getDatabase()));
ipcMain.handle('cards:getById', (_e, id: string) => cardGetById(getDatabase(), id));
ipcMain.handle('cards:create', (_e, data: CardInput) => cardCreate(getDatabase(), data));
ipcMain.handle('cards:update', (_e, id: string, data: Partial<CardInput>) => cardUpdate(getDatabase(), id, data));
ipcMain.handle('cards:delete', (_e, id: string) => { cardDelete(getDatabase(), id); return { ok: true }; });
ipcMain.handle('cards:setVisible', (_e, id: string, visible: boolean) => cardSetVisible(getDatabase(), id, visible));

// ─── Programs ────────────────────────────────────────────────────────────────
ipcMain.handle('programs:getAll', () => programsGetAll(getDatabase()));
ipcMain.handle('programs:getById', (_e, id: string) => programGetById(getDatabase(), id));
ipcMain.handle('programs:create', (_e, data: ProgramInput) => programCreate(getDatabase(), data));
ipcMain.handle('programs:update', (_e, id: string, data: Partial<ProgramInput>) => programUpdate(getDatabase(), id, data));
ipcMain.handle('programs:delete', (_e, id: string) => { programDelete(getDatabase(), id); return { ok: true }; });

// ─── Benefits ────────────────────────────────────────────────────────────────
ipcMain.handle('benefits:getAll', () => benefitsGetAll(getDatabase()));
ipcMain.handle('benefits:getChoices', (_e, id: number, year: number) => benefitGetChoices(getDatabase(), id, year));
ipcMain.handle('benefits:setChoices', (_e, id: number, year: number, choices: number[]) => benefitSetChoices(getDatabase(), id, year, choices));
ipcMain.handle('benefits:forCard', (_e, cardId: string) => benefitsForCard(getDatabase(), cardId));
ipcMain.handle('benefits:forProgram', (_e, programId: string) => benefitsForProgram(getDatabase(), programId));
ipcMain.handle('benefits:getById', (_e, id: number) => benefitGetById(getDatabase(), id));
ipcMain.handle('benefits:create', (_e, data: BenefitInput) => benefitCreate(getDatabase(), data));
ipcMain.handle('benefits:update', (_e, id: number, data: Partial<BenefitInput>) => benefitUpdate(getDatabase(), id, data));
ipcMain.handle('benefits:delete', (_e, id: number) => { benefitDelete(getDatabase(), id); return { ok: true }; });

// ─── Usages ──────────────────────────────────────────────────────────────────
ipcMain.handle('usages:forBenefit', (_e, id: number) => usagesForBenefit(getDatabase(), id));
ipcMain.handle('usages:create', (_e, data: UsageInput) => usageCreate(getDatabase(), data));
ipcMain.handle('usages:update', (_e, id: number, data: Partial<UsageInput>) => usageUpdate(getDatabase(), id, data));
ipcMain.handle('usages:delete', (_e, id: number) => { usageDelete(getDatabase(), id); return { ok: true }; });

// ─── Projection ──────────────────────────────────────────────────────────────
ipcMain.handle('projection:all', (_e, refYear?: number) =>
  computeProjections(getDatabase(), refYear ?? new Date().getUTCFullYear()));

// ─── Refresh ─────────────────────────────────────────────────────────────────
ipcMain.handle('refresh:getStatus', () => refreshGetStatus(getDatabase()));
ipcMain.handle('refresh:startRun', (_e, sourceNotes: string, changes: any[]) =>
  refreshStartRun(getDatabase(), sourceNotes, changes));
ipcMain.handle('refresh:getPendingChanges', (_e, runId: number) => refreshPendingChanges(getDatabase(), runId));
ipcMain.handle('refresh:approveChange', (_e, id: number, notes?: string, overwrite?: boolean) =>
  refreshApproveChange(getDatabase(), id, notes, overwrite === true));
ipcMain.handle('refresh:rejectChange',  (_e, id: number, notes?: string) => refreshRejectChange(getDatabase(), id, notes));
// After a run is finished, offer the next bundled refresh that has come due (if any).
ipcMain.handle('refresh:applyRun',      (_e, runId: number) => {
  const result = refreshApplyRun(getDatabase(), runId);
  offerBundledRefresh(false);
  return result;
});
ipcMain.handle('refresh:discardRun',    (_e, runId: number) => {
  refreshDiscardRun(getDatabase(), runId);
  offerBundledRefresh(false);
  return { ok: true };
});

const NO_PROPOSAL: RefreshProposalResult = { state: 'cancelled', run_id: null, title: null, proposed: 0, already_current: 0, unmatched: [] };

// Manual "check again": re-compare the refresh bundled with this version,
// including one that was applied or discarded earlier.
ipcMain.handle('refresh:checkBundled', (): RefreshProposalResult => {
  try { return offerBundledProposals(getDatabase(), { force: true }); }
  catch (err) { logError(`refresh:checkBundled ${err}`); return { ...NO_PROPOSAL, error: String(err instanceof Error ? err.message : err) }; }
});

// Load a refresh file chosen by the user. The file is untrusted: it is size
// limited, parsed as JSON only, and validated field by field before anything
// is written. It can only create a draft run for review.
ipcMain.handle('refresh:importProposal', async (): Promise<RefreshProposalResult> => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(activeWindow(), {
      title: 'Load Benefit Refresh File',
      filters: [{ name: 'Benefit refresh', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return NO_PROPOSAL;
    const chosen = filePaths[0];
    if (!fs.existsSync(chosen) || !safeChosenPath(chosen, ['.json'])) {
      return { ...NO_PROPOSAL, error: 'Invalid file path.' };
    }
    if (fs.statSync(chosen).size > MAX_PROPOSAL_BYTES) return { ...NO_PROPOSAL, error: 'The refresh file is too large.' };
    return importProposalText(getDatabase(), fs.readFileSync(chosen, 'utf-8'));
  } catch (err) {
    logError(`refresh:importProposal ${err}`);
    return { ...NO_PROPOSAL, error: String(err instanceof Error ? err.message : err) };
  }
});

// ─── Points currencies ───────────────────────────────────────────────────────
ipcMain.handle('pointsCurrencies:getAll', () => pointsCurrenciesGetAll(getDatabase()));
ipcMain.handle('pointsCurrencies:getById', (_e, id: string) => pointsCurrencyGetById(getDatabase(), id));
ipcMain.handle('pointsCurrencies:create', (_e, data: PointsCurrencyInput) => pointsCurrencyCreate(getDatabase(), data));
ipcMain.handle('pointsCurrencies:update', (_e, id: string, data: Partial<PointsCurrencyInput>) => pointsCurrencyUpdate(getDatabase(), id, data));
ipcMain.handle('pointsCurrencies:delete', (_e, id: string) => { pointsCurrencyDelete(getDatabase(), id); return { ok: true }; });

// ─── File management ─────────────────────────────────────────────────────────

function activeWindow(): BrowserWindow {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function safeChosenPath(chosen: string, exts: string[]): boolean {
  const ext = path.extname(path.resolve(chosen)).toLowerCase();
  return exts.includes(ext);
}

function dialogFilters(o: PickOptions) {
  return [{ name: o.filterName, extensions: [o.extension] }];
}

const fileOps = createFileOps({
  pickSave: async (o) => {
    const { canceled, filePath } = await dialog.showSaveDialog(activeWindow(), {
      title: o.title, defaultPath: o.defaultPath, filters: dialogFilters(o),
    });
    return canceled || !filePath ? null : filePath;
  },
  pickOpen: async (o) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(activeWindow(), {
      title: o.title, filters: dialogFilters(o), properties: ['openFile'],
    });
    return canceled || !filePaths.length ? null : filePaths[0];
  },
  confirm: async (o) => {
    const res = await dialog.showMessageBox(activeWindow(), {
      type: 'warning',
      title: o.title,
      message: o.message,
      detail: o.detail,
      buttons: [o.confirmLabel, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return res.response === 0;
  },
  showInFolder: (p) => shell.showItemInFolder(p),
  get settingsDir() { return app.getPath('userData'); },
  get defaultDbPath() { return defaultDbPath(); },
  get suggestedDir() { return app.getPath('documents'); },
  afterOpen: (fresh) => offerBundledRefresh(fresh),
  log: logError,
});

interface StartupProblem { unavailable: string; reason: string; opened: string }

/**
 * Open the file used last time, or the default file. Returns a description for
 * the user when the remembered file could not be used. The remembered file is
 * only forgotten if the user says so (see reportStartupProblem).
 */
function openStartupFile(): StartupProblem | null {
  const fallback = defaultDbPath();
  const choice = chooseStartupPath(app.getPath('userData'), fallback);
  let problem: StartupProblem | null = choice.unavailable
    ? { unavailable: choice.unavailable, reason: choice.reason ?? '', opened: fallback }
    : null;
  if (choice.path !== fallback) {
    try { fileOps.openAtStartup(choice.path); return null; }
    catch (err) {
      logError(`could not open remembered file ${choice.path}: ${err}`);
      problem = { unavailable: choice.path, reason: 'It could not be opened as a Credit Card Benefit Tracker file.', opened: fallback };
    }
  }
  fileOps.openAtStartup(fallback);
  return problem;
}

function reportStartupProblem(win: BrowserWindow, problem: StartupProblem): void {
  dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Credit Card Benefit Tracker',
    message: 'The file you used last time could not be opened',
    detail:
      `${problem.unavailable}\n\n${problem.reason}\n\n` +
      `The default file is open instead:\n${problem.opened}\n\n` +
      'Use File > Open File to choose another file at any time.',
    buttons: ['Try my file again next time', 'Use the default file from now on'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }).then(res => {
    if (res.response !== 1) return;
    // Only now, with the default file open and at the user's request, stop looking for the old file.
    try { writeLastDbPath(app.getPath('userData'), problem.opened, problem.opened); }
    catch (err) { logError(`could not reset remembered file: ${err}`); }
  }).catch(err => logError(`startup notice error: ${err}`));
}

/** Tell every window which file is open and whether its data changed underneath it. */
function announce(result: FileOpResult, source: FileChangeInfo['source']): void {
  if (!result.success) return;
  const info: FileChangeInfo = {
    path: fileOps.currentPath(),
    reload: result.reload === true,
    source,
    message: result.message,
  };
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('file:changed', info); } catch (err) { logError(`file:changed ${err}`); }
  }
}

function toFileResult(r: FileOpResult): FileResult {
  const { reload: _reload, ...rest } = r;
  return rest;
}

/** A File menu command: the result is shown in the window; a failure gets a dialog. */
async function fromMenu(op: () => Promise<FileOpResult>): Promise<void> {
  const result = await op();
  announce(result, 'menu');
  if (!result.success && result.error) {
    dialog.showMessageBox(activeWindow(), {
      type: 'error',
      title: 'Credit Card Benefit Tracker',
      message: 'That did not work',
      detail: result.error,
      buttons: ['OK'],
    }).catch(err => logError(`file error dialog: ${err}`));
  }
}

/** The same command from the Settings page, which shows the result itself. */
async function fromSettings(op: () => Promise<FileOpResult>): Promise<FileResult> {
  const result = await op();
  announce(result, 'settings');
  return toFileResult(result);
}

// Paths are never accepted from the renderer; each handler shows its own dialog.
ipcMain.handle('file:currentPath', () => fileOps.currentPath());
ipcMain.handle('file:newDb', () => fromSettings(fileOps.newFile));
ipcMain.handle('file:openDb', () => fromSettings(fileOps.openFile));
ipcMain.handle('file:save', () => fromSettings(fileOps.save));
ipcMain.handle('file:saveAs', () => fromSettings(fileOps.saveAs));
ipcMain.handle('file:saveCopy', () => fromSettings(fileOps.saveCopy));
ipcMain.handle('file:exportJson', () => fromSettings(fileOps.exportJson));
ipcMain.handle('file:importJson', () => fromSettings(fileOps.importJson));
ipcMain.handle('file:showInFolder', () => fromSettings(fileOps.showInFolder));

// ─── App metadata / About ───────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:showAbout', () => { showAboutDialog(); });
