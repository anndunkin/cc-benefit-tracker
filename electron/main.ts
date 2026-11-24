import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, shell, dialog, session } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  getDatabase, closeDatabase, lastOpenWasFresh,
  cardsGetAll, cardGetById, cardCreate, cardUpdate, cardDelete, cardSetVisible,
  programsGetAll, programGetById, programCreate, programUpdate, programDelete,
  benefitsGetAll, benefitsForCard, benefitsForProgram, benefitGetById,
  benefitCreate, benefitUpdate, benefitDelete, benefitGetChoices, benefitSetChoices,
  usagesForBenefit, usageCreate, usageUpdate, usageDelete,
  computeProjections, reconcileCertificateAwards,
  refreshGetStatus, refreshPendingChanges,
  refreshApproveChange, refreshRejectChange, refreshApplyRun, refreshDiscardRun,
  applyDataMigrations,
  pointsCurrenciesGetAll, pointsCurrencyGetById, pointsCurrencyCreate,
  pointsCurrencyUpdate, pointsCurrencyDelete,
} from './database';
import type {
  CardInput, ProgramInput, BenefitInput, UsageInput, FileResult, FileChangeInfo,
  PointsCurrencyInput, AppRoute, ExpiringReport, PrintResult,
} from './types';
import { buildExpiringReport, localIsoDate, utcDateFor } from './expiringCredits';
import { chooseStartupPath, writeLastDbPath } from './fileStore';
import { createFileOps } from './fileOps';
import type { FileOpResult, PickOptions } from './fileOps';
import { buildFileMenu } from './fileMenu';
import { isAppPageUrl, isSafeWebLink } from './linkPolicy';
import { pathToFileURL } from 'url';
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

const DEV_ORIGIN: string | null = isDev ? 'http://localhost:5173' : null;
function appIndexPath(): string { return path.join(app.getAppPath(), 'dist', 'index.html'); }

/**
 * v1.0.29: every request for data must come from the app's own page in the
 * app's own window. Anything else (another page, a frame) is refused.
 */
function handleIpc(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const frame = event.senderFrame;
    const fromApp = !!frame && frame === event.sender.mainFrame
      && isAppPageUrl(frame.url, pathToFileURL(appIndexPath()).href, DEV_ORIGIN);
    if (!fromApp) {
      logError(`blocked request ${channel} from ${frame?.url?.slice(0, 200) ?? 'unknown'}`);
      throw new Error('Request refused');
    }
    return listener(event, ...args);
  });
}

/** Open a web link in the user's browser; refuse anything else. */
function openExternalLink(url: string): void {
  if (!isSafeWebLink(url)) { logError(`blocked link: ${String(url).slice(0, 200)}`); return; }
  shell.openExternal(url).catch(err => logError(`openExternal failed: ${err}`));
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
      // v1.0.29: the page runs in Chromium's sandbox. The preload script only
      // needs contextBridge and ipcRenderer, which work inside it.
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
    backgroundColor: '#0f172a',
    show: false,
  });

  win.once('ready-to-show', () => win.show());

  const indexPath = appIndexPath();
  const appPageUrl = pathToFileURL(indexPath).href;
  const devOrigin = DEV_ORIGIN;
  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools();
  } else {
    logError(`Loading: ${indexPath} (exists: ${fs.existsSync(indexPath)})`);
    win.loadFile(indexPath).catch(err => logError(`loadFile error: ${err}`));
  }

  // v1.0.29: no inline scripts in the installed app, no plug-ins, frames, forms
  // or <base> changes. The development server needs inline scripts for reloading.
  const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' file:; " : "script-src 'self' file:; ";
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' file:; " +
          scriptSrc +
          "style-src 'self' 'unsafe-inline' file:; " +
          "font-src 'self' file: data:; " +
          "img-src 'self' file: data:; " +
          "connect-src 'self' file:" + (isDev ? ' ws://localhost:5173' : '') + "; " +
          "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none';",
        ],
      },
    });
  });

  // v1.0.29: the window only ever shows the app's own page. Web links open in
  // the browser; every other kind of address is refused and logged.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppPageUrl(url, appPageUrl, devOrigin)) return;
    event.preventDefault();
    openExternalLink(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (isAppPageUrl(url, appPageUrl, devOrigin)) return;
    event.preventDefault();
    logError(`blocked redirect: ${url.slice(0, 200)}`);
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
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
      printExpiring: () => showScreen('print-expiring'),
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
  // v1.0.29: the app never needs the camera, microphone, location, notifications and so on.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
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
handleIpc('cards:getAll', () => cardsGetAll(getDatabase()));
handleIpc('cards:getById', (_e, id: string) => cardGetById(getDatabase(), id));
handleIpc('cards:create', (_e, data: CardInput) => cardCreate(getDatabase(), data));
handleIpc('cards:update', (_e, id: string, data: Partial<CardInput>) => cardUpdate(getDatabase(), id, data));
handleIpc('cards:delete', (_e, id: string) => { cardDelete(getDatabase(), id); return { ok: true }; });
handleIpc('cards:setVisible', (_e, id: string, visible: boolean) => cardSetVisible(getDatabase(), id, visible));

// ─── Programs ────────────────────────────────────────────────────────────────
handleIpc('programs:getAll', () => programsGetAll(getDatabase()));
handleIpc('programs:getById', (_e, id: string) => programGetById(getDatabase(), id));
handleIpc('programs:create', (_e, data: ProgramInput) => programCreate(getDatabase(), data));
handleIpc('programs:update', (_e, id: string, data: Partial<ProgramInput>) => programUpdate(getDatabase(), id, data));
handleIpc('programs:delete', (_e, id: string) => { programDelete(getDatabase(), id); return { ok: true }; });

// ─── Benefits ────────────────────────────────────────────────────────────────
handleIpc('benefits:getAll', () => benefitsGetAll(getDatabase()));
handleIpc('benefits:getChoices', (_e, id: number, year: number) => benefitGetChoices(getDatabase(), id, year));
handleIpc('benefits:setChoices', (_e, id: number, year: number, choices: number[]) => benefitSetChoices(getDatabase(), id, year, choices));
handleIpc('benefits:forCard', (_e, cardId: string) => benefitsForCard(getDatabase(), cardId));
handleIpc('benefits:forProgram', (_e, programId: string) => benefitsForProgram(getDatabase(), programId));
handleIpc('benefits:getById', (_e, id: number) => benefitGetById(getDatabase(), id));
handleIpc('benefits:create', (_e, data: BenefitInput) => benefitCreate(getDatabase(), data));
handleIpc('benefits:update', (_e, id: number, data: Partial<BenefitInput>) => benefitUpdate(getDatabase(), id, data));
handleIpc('benefits:delete', (_e, id: number) => { benefitDelete(getDatabase(), id); return { ok: true }; });

// ─── Usages ──────────────────────────────────────────────────────────────────
handleIpc('usages:forBenefit', (_e, id: number) => usagesForBenefit(getDatabase(), id));
handleIpc('usages:create', (_e, data: UsageInput) => usageCreate(getDatabase(), data));
handleIpc('usages:update', (_e, id: number, data: Partial<UsageInput>) => usageUpdate(getDatabase(), id, data));
handleIpc('usages:delete', (_e, id: number) => { usageDelete(getDatabase(), id); return { ok: true }; });

// ─── Projection ──────────────────────────────────────────────────────────────
// v1.0.26: "today" is the user's local calendar date. It used to be the UTC
// date, which in US time zones moved to the next day (and so the next month or
// year) during the evening.
handleIpc('projection:all', (_e, refYear?: number) => {
  const today = localIsoDate();
  reconcileCertificateAwards(getDatabase(), today);
  return computeProjections(getDatabase(), refYear ?? parseInt(today.slice(0, 4), 10), utcDateFor(today));
});

// ─── Refresh ─────────────────────────────────────────────────────────────────
handleIpc('refresh:getStatus', () => refreshGetStatus(getDatabase()));
// v1.0.29: there is no request for starting a refresh from the page. Refreshes come
// only from the files bundled with the app or a refresh file the user picks, and
// both are checked field by field before anything is proposed.
handleIpc('refresh:getPendingChanges', (_e, runId: number) => refreshPendingChanges(getDatabase(), runId));
handleIpc('refresh:approveChange', (_e, id: number, notes?: string, overwrite?: boolean) =>
  refreshApproveChange(getDatabase(), id, notes, overwrite === true));
handleIpc('refresh:rejectChange',  (_e, id: number, notes?: string) => refreshRejectChange(getDatabase(), id, notes));
// After a run is finished, offer the next bundled refresh that has come due (if any).
handleIpc('refresh:applyRun',      (_e, runId: number) => {
  const result = refreshApplyRun(getDatabase(), runId);
  offerBundledRefresh(false);
  return result;
});
handleIpc('refresh:discardRun',    (_e, runId: number) => {
  refreshDiscardRun(getDatabase(), runId);
  offerBundledRefresh(false);
  return { ok: true };
});

const NO_PROPOSAL: RefreshProposalResult = { state: 'cancelled', run_id: null, title: null, proposed: 0, already_current: 0, unmatched: [] };

// Manual "check again": re-compare the refresh bundled with this version,
// including one that was applied or discarded earlier.
handleIpc('refresh:checkBundled', (): RefreshProposalResult => {
  try { return offerBundledProposals(getDatabase(), { force: true }); }
  catch (err) { logError(`refresh:checkBundled ${err}`); return { ...NO_PROPOSAL, error: String(err instanceof Error ? err.message : err) }; }
});

// Load a refresh file chosen by the user. The file is untrusted: it is size
// limited, parsed as JSON only, and validated field by field before anything
// is written. It can only create a draft run for review.
handleIpc('refresh:importProposal', async (): Promise<RefreshProposalResult> => {
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
handleIpc('pointsCurrencies:getAll', () => pointsCurrenciesGetAll(getDatabase()));
handleIpc('pointsCurrencies:getById', (_e, id: string) => pointsCurrencyGetById(getDatabase(), id));
handleIpc('pointsCurrencies:create', (_e, data: PointsCurrencyInput) => pointsCurrencyCreate(getDatabase(), data));
handleIpc('pointsCurrencies:update', (_e, id: string, data: Partial<PointsCurrencyInput>) => pointsCurrencyUpdate(getDatabase(), id, data));
handleIpc('pointsCurrencies:delete', (_e, id: string) => { pointsCurrencyDelete(getDatabase(), id); return { ok: true }; });

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
handleIpc('file:currentPath', () => fileOps.currentPath());
handleIpc('file:newDb', () => fromSettings(fileOps.newFile));
handleIpc('file:openDb', () => fromSettings(fileOps.openFile));
handleIpc('file:save', () => fromSettings(fileOps.save));
handleIpc('file:saveAs', () => fromSettings(fileOps.saveAs));
handleIpc('file:saveCopy', () => fromSettings(fileOps.saveCopy));
handleIpc('file:exportJson', () => fromSettings(fileOps.exportJson));
handleIpc('file:importJson', () => fromSettings(fileOps.importJson));
handleIpc('file:showInFolder', () => fromSettings(fileOps.showInFolder));

// ─── Expiring credits and printing (v1.0.26) ───────────────────────────────────
// The list is built for the user's local calendar date, so a credit that ends
// on the last day of the month is still listed that evening.
handleIpc('expiring:list', (event): ExpiringReport => {
  if (!fromAppWindow(event)) throw new Error('Not available from this page.');
  const today = localIsoDate();
  const year = parseInt(today.slice(0, 4), 10);
  reconcileCertificateAwards(getDatabase(), today);
  return buildExpiringReport(computeProjections(getDatabase(), year, utcDateFor(today)), today);
});

/** Ask the window to show one of the screens the menu knows about. */
function showScreen(route: AppRoute): void {
  const win = activeWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  try { win.webContents.send('app:navigate', route); } catch (err) { logError(`app:navigate ${err}`); }
}

/** True when a request comes from the top-level page of one of this app's own windows. */
function fromAppWindow(event: Electron.IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender);
  return !!win && !win.isDestroyed() && event.senderFrame === event.sender.mainFrame;
}

// Opens the system print dialog for the window that asked. Nothing is taken
// from the renderer: no printer name, no file path, no options. One dialog at
// a time.
let printDialogOpen = false;
/** Whether the window is showing Print Expiring Credits, the only screen laid out for paper. */
function onPrintScreen(url: string): boolean {
  try { return new URL(url).hash.split('?')[0] === '#/print-expiring'; } catch { return false; }
}

handleIpc('app:print', (event): Promise<PrintResult> => new Promise(resolve => {
  if (!fromAppWindow(event) || !onPrintScreen(event.sender.getURL())) return resolve({ success: false, error: 'Printing is not available from this page.' });
  if (printDialogOpen) return resolve({ success: false, cancelled: true });
  printDialogOpen = true;
  const done = (result: PrintResult) => { printDialogOpen = false; resolve(result); };
  try {
    event.sender.print({ silent: false, printBackground: false }, (success, failureReason) => {
      if (success) return done({ success: true });
      const reason = String(failureReason ?? '').trim();
      if (/cancel/i.test(reason)) return done({ success: false, cancelled: true });
      logError(`print failed: ${reason}`);
      done({ success: false, error: reason || 'The print job did not start.' });
    });
  } catch (err) {
    logError(`print error: ${err}`);
    done({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}));

// ─── App metadata / About ───────────────────────────────────────
handleIpc('app:getVersion', () => app.getVersion());
handleIpc('app:showAbout', () => { showAboutDialog(); });
