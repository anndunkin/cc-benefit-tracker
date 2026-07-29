import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import {
  getDatabase, openDatabaseAt,
  cardsGetAll, cardGetById, cardCreate, cardUpdate, cardDelete, cardSetVisible,
  programsGetAll, programGetById, programCreate, programUpdate, programDelete,
  benefitsGetAll, benefitsForCard, benefitsForProgram, benefitGetById,
  benefitCreate, benefitUpdate, benefitDelete,
  usagesForBenefit, usageCreate, usageUpdate, usageDelete,
  computeProjections,
  refreshGetStatus, refreshStartRun, refreshPendingChanges,
  refreshApproveChange, refreshRejectChange, refreshApplyRun, refreshDiscardRun,
  buildFilePayload, importFilePayload,
  applyDataMigrations,
} from './database';
import type {
  CardInput, ProgramInput, BenefitInput, UsageInput, AppFilePayload, FileResult,
} from './types';
import { resolveIconPath } from './iconPath';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const APP_USER_MODEL_ID = 'com.dunkinglobal.ccbenefittracker';

let currentDbPath = '';

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

function createWindow(): void {
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
    {
      label: '&File',
      submenu: [
        isMac ? { role: 'close' as const } : { role: 'quit' as const },
      ],
    },
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
  currentDbPath = defaultDbPath();
  openDatabaseAt(currentDbPath);
  logError(`data migrations: ${JSON.stringify(applyDataMigrations(getDatabase()))}`);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(err => logError(`app.whenReady error: ${err}`));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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
ipcMain.handle('refresh:approveChange', (_e, id: number, notes?: string) => refreshApproveChange(getDatabase(), id, notes));
ipcMain.handle('refresh:rejectChange',  (_e, id: number, notes?: string) => refreshRejectChange(getDatabase(), id, notes));
ipcMain.handle('refresh:applyRun',      (_e, runId: number) => refreshApplyRun(getDatabase(), runId));
ipcMain.handle('refresh:discardRun',    (_e, runId: number) => { refreshDiscardRun(getDatabase(), runId); return { ok: true }; });

// ─── File management ─────────────────────────────────────────────────────────

function activeWindow(): BrowserWindow {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

function safeChosenPath(chosen: string, exts: string[]): boolean {
  const resolved = path.resolve(chosen);
  if (resolved !== chosen && path.normalize(chosen) !== resolved) { /* allow normalized */ }
  const ext = path.extname(resolved).toLowerCase();
  return exts.includes(ext);
}

ipcMain.handle('file:currentPath', () => currentDbPath);

ipcMain.handle('file:newDb', async (): Promise<FileResult> => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(activeWindow(), {
      title: 'New Benefit Tracker File',
      defaultPath: 'cc-benefit-tracker.db',
      filters: [{ name: 'Tracker Database', extensions: ['db'] }],
    });
    if (canceled || !filePath) return { success: false };
    if (!safeChosenPath(filePath, ['.db'])) return { success: false, error: 'Invalid file path.' };
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
    currentDbPath = filePath;
    openDatabaseAt(filePath);
    return { success: true, filePath };
  } catch (err) { logError(`file:newDb ${err}`); return { success: false, error: String(err) }; }
});

ipcMain.handle('file:openDb', async (): Promise<FileResult> => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(activeWindow(), {
      title: 'Open Benefit Tracker File',
      filters: [{ name: 'Tracker Database', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { success: false };
    const chosen = filePaths[0];
    if (!fs.existsSync(chosen) || !safeChosenPath(chosen, ['.db'])) {
      return { success: false, error: 'Invalid file path.' };
    }
    currentDbPath = chosen;
    openDatabaseAt(chosen);
    return { success: true, filePath: chosen };
  } catch (err) { logError(`file:openDb ${err}`); return { success: false, error: String(err) }; }
});

ipcMain.handle('file:saveAs', async (): Promise<FileResult> => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(activeWindow(), {
      title: 'Save Benefit Tracker File As…',
      defaultPath: 'cc-benefit-tracker.db',
      filters: [{ name: 'Tracker Database', extensions: ['db'] }],
    });
    if (canceled || !filePath) return { success: false };
    if (!safeChosenPath(filePath, ['.db'])) return { success: false, error: 'Invalid file path.' };
    try { getDatabase().pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    fs.copyFileSync(currentDbPath, filePath);
    currentDbPath = filePath;
    openDatabaseAt(filePath);
    return { success: true, filePath };
  } catch (err) { logError(`file:saveAs ${err}`); return { success: false, error: String(err) }; }
});

ipcMain.handle('file:exportJson', async (): Promise<FileResult> => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(activeWindow(), {
      title: 'Export Data as JSON',
      defaultPath: `cc-benefit-tracker-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { success: false };
    if (!safeChosenPath(filePath, ['.json'])) return { success: false, error: 'Invalid file path.' };
    const payload = buildFilePayload(getDatabase());
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true, filePath, payload };
  } catch (err) { logError(`file:exportJson ${err}`); return { success: false, error: String(err) }; }
});

// ─── App metadata / About ───────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:showAbout', () => { showAboutDialog(); });

ipcMain.handle('file:importJson', async (): Promise<FileResult> => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(activeWindow(), {
      title: 'Import Data from JSON',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { success: false };
    const chosen = filePaths[0];
    if (!fs.existsSync(chosen) || !safeChosenPath(chosen, ['.json'])) {
      return { success: false, error: 'Invalid file path.' };
    }
    const raw = fs.readFileSync(chosen, 'utf-8');
    const payload = JSON.parse(raw) as AppFilePayload;
    importFilePayload(getDatabase(), payload);
    return { success: true, filePath: chosen, payload };
  } catch (err) { logError(`file:importJson ${err}`); return { success: false, error: String(err) }; }
});
