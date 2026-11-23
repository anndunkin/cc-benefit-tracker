// The File menu (v1.0.25). Kept apart from main.ts so the menu's contents and
// wiring can be tested without starting Electron (tests/fileStore.test.ts).
import type { MenuItemConstructorOptions } from 'electron';

export interface FileMenuActions {
  newFile: () => void;
  openFile: () => void;
  save: () => void;
  saveAs: () => void;
  saveCopy: () => void;
  exportJson: () => void;
  importJson: () => void;
  showInFolder: () => void;
  /** v1.0.26: open the Print Expiring Credits screen. */
  printExpiring: () => void;
}

/** Labels used by the application menu and, word for word, by the Settings page (checked in tests/file-ui.test.tsx). */
export const FILE_MENU_LABELS = {
  newFile: 'New File…',
  openFile: 'Open File…',
  save: 'Save',
  saveAs: 'Save As…',
  saveCopy: 'Save a Backup Copy…',
  exportJson: 'Export to JSON…',
  importJson: 'Import from JSON…',
  showInFolder: 'Show File in Folder',
} as const;

/** v1.0.26. Not a file command, so it is not part of FILE_MENU_LABELS (which Settings mirrors). */
export const PRINT_EXPIRING_LABEL = 'Print Expiring Credits…';

export function buildFileMenu(actions: FileMenuActions, isMac: boolean): MenuItemConstructorOptions {
  const L = FILE_MENU_LABELS;
  return {
    label: '&File',
    submenu: [
      { label: L.newFile, accelerator: 'CmdOrCtrl+N', click: () => actions.newFile() },
      { label: L.openFile, accelerator: 'CmdOrCtrl+O', click: () => actions.openFile() },
      { type: 'separator' },
      { label: L.save, accelerator: 'CmdOrCtrl+S', click: () => actions.save() },
      { label: L.saveAs, accelerator: 'CmdOrCtrl+Shift+S', click: () => actions.saveAs() },
      { label: L.saveCopy, click: () => actions.saveCopy() },
      { type: 'separator' },
      { label: L.exportJson, click: () => actions.exportJson() },
      { label: L.importJson, click: () => actions.importJson() },
      { type: 'separator' },
      { label: L.showInFolder, click: () => actions.showInFolder() },
      { type: 'separator' },
      { label: PRINT_EXPIRING_LABEL, accelerator: 'CmdOrCtrl+P', click: () => actions.printExpiring() },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit', label: 'E&xit' },
    ],
  };
}
