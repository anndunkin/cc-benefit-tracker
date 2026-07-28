// Minimal electron stub for node-environment unit tests. The database module
// only touches `app.getPath` lazily (via getDatabase); tests inject an
// in-memory DB directly, so these are safety no-ops.
export const app = {
  getPath: (_name: string) => '/tmp',
  isPackaged: false,
  getAppPath: () => '/tmp',
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {},
};
export const ipcMain = { handle: () => {} };
export const dialog = {};
export const shell = {};
export const contextBridge = { exposeInMainWorld: () => {} };
export const ipcRenderer = { invoke: () => Promise.resolve() };
export class BrowserWindow {}
export default { app, ipcMain, dialog, shell, contextBridge, ipcRenderer, BrowserWindow };
