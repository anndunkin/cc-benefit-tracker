import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { FileChangeInfo, FileResult } from '../electron/types';
import App from '../src/App';
import Settings from '../src/pages/Settings';
import { FILE_MENU_LABELS as L } from '../electron/fileMenu';

let listeners: Array<(info: FileChangeInfo) => void>;
let currentPath: string;
let results: Record<string, FileResult>;
let calls: string[];
let statusCalls: number;

const emit = (info: FileChangeInfo) => act(() => { for (const l of [...listeners]) l(info); });

beforeEach(() => {
  listeners = []; calls = []; statusCalls = 0;
  currentPath = 'C:\\Users\\ann\\AppData\\Roaming\\cc-benefit-tracker\\cc-benefit-tracker.db';
  results = {};
  const command = (name: string) => async () => { calls.push(name); return results[name] ?? { success: false }; };
  window.api = {
    file: {
      currentPath: async () => currentPath,
      newDb: command('newDb'), openDb: command('openDb'), save: command('save'), saveAs: command('saveAs'),
      saveCopy: command('saveCopy'), exportJson: command('exportJson'), importJson: command('importJson'),
      showInFolder: command('showInFolder'),
      onChanged: (listener: (info: FileChangeInfo) => void) => {
        listeners.push(listener);
        return () => { listeners = listeners.filter(l => l !== listener); };
      },
    },
    app: { getVersion: async () => '1.0.25', showAbout: async () => {}, onNavigate: () => () => {} },
    refresh: {
      getStatus: async () => { statusCalls++; return { last_run_at: null, next_due: '2099-01-01', pending_run_id: null }; },
    },
  } as unknown as typeof window.api;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }
function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><App /><Where /></MemoryRouter>);
}

it('Settings offers every file command and runs the one that was clicked', async () => {
  render(<Settings />);
  const expected: Array<[string, string]> = [
    [L.newFile, 'newDb'], [L.openFile, 'openDb'], [L.save, 'save'], [L.saveAs, 'saveAs'],
    [L.saveCopy, 'saveCopy'], [L.showInFolder, 'showInFolder'],
    [L.exportJson, 'exportJson'], [L.importJson, 'importJson'],
  ];
  // The Settings buttons use the File menu's wording exactly.
  expect(expected.map(e => e[0])).toEqual([
    'New File…', 'Open File…', 'Save', 'Save As…', 'Save a Backup Copy…', 'Show File in Folder', 'Export to JSON…', 'Import from JSON…',
  ]);
  for (const [label, name] of expected) {
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(calls.at(-1)).toBe(name));
    await waitFor(() => expect(screen.getByRole('button', { name: label })).toBeEnabled());
  }
  expect(calls).toEqual(expected.map(e => e[1]));
});

it('Settings reports what Save did, in words', async () => {
  results.save = { success: true, filePath: currentPath, message: `Saved to ${currentPath}` };
  render(<Settings />);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('status')).toHaveTextContent(`Saved to ${currentPath}`);
});

it('Settings stays quiet when a dialog is cancelled and explains a failure', async () => {
  render(<Settings />);
  fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
  await waitFor(() => expect(calls).toEqual(['saveAs']));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save As…' })).toBeEnabled());
  expect(screen.queryByRole('status')).toBeNull();

  results.openDb = { success: false, error: 'That file is a database from another program. It was not changed.' };
  fireEvent.click(screen.getByRole('button', { name: 'Open File…' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Open file failed: That file is a database from another program.');
});

it('Settings shows the new location after Save As and follows changes made from the File menu', async () => {
  render(<Settings />);
  expect(await screen.findByText(currentPath)).toBeInTheDocument();
  const moved = 'D:\\OneDrive\\tracker.db';
  results.saveAs = { success: true, filePath: moved, message: `Saved as ${moved}.` };
  currentPath = moved;
  fireEvent.click(screen.getByRole('button', { name: 'Save As…' }));
  expect(await screen.findByText(moved)).toBeInTheDocument();

  const opened = 'E:\\backup\\other.db';
  emit({ path: opened, reload: true, source: 'menu', message: `Opened ${opened}` });
  expect(await screen.findByText(opened)).toBeInTheDocument();
});

it('the window shows a File menu result and the new file path, then lets it be dismissed', async () => {
  renderApp('/settings');
  await screen.findByText('v1.0.25');
  const opened = 'D:\\OneDrive\\tracker.db';
  emit({ path: opened, reload: false, source: 'menu', message: `Saved to ${opened}` });
  const notice = await screen.findByRole('status');
  expect(notice).toHaveTextContent(`Saved to ${opened}`);
  expect(screen.getByTitle(opened)).toBeInTheDocument();          // header path
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('status')).toBeNull();
});

it('the File menu notice goes away on its own', async () => {
  renderApp('/settings');
  await screen.findByText('v1.0.25');
  vi.useFakeTimers();
  emit({ path: currentPath, reload: false, source: 'menu', message: 'Exported to C:\\out.json' });
  expect(screen.getByRole('status')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(8100); });
  expect(screen.queryByRole('status')).toBeNull();
});

it('repeating a command shows the notice for its full time again', async () => {
  renderApp('/settings');
  await screen.findByText('v1.0.25');
  vi.useFakeTimers();
  const info: FileChangeInfo = { path: currentPath, reload: false, source: 'menu', message: 'Saved to C:\\x.db' };
  emit(info);
  act(() => { vi.advanceTimersByTime(6000); });
  emit(info);                                   // Ctrl+S a second time
  act(() => { vi.advanceTimersByTime(6000); });
  expect(screen.getByRole('status')).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(2100); });
  expect(screen.queryByRole('status')).toBeNull();
});

it('Save As from the menu changes the path without reloading the page', async () => {
  renderApp('/settings');
  await screen.findByText('v1.0.25');
  const page = screen.getByRole('heading', { name: 'Settings' });
  emit({ path: 'D:\\moved.db', reload: false, source: 'menu', message: 'Saved as D:\\moved.db.' });
  expect(screen.getByTitle('D:\\moved.db')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Settings' })).toBe(page);
});

it('opening another file from the menu reloads the page and the review banner', async () => {
  renderApp('/settings');
  await screen.findByText('v1.0.25');
  await waitFor(() => expect(statusCalls).toBeGreaterThan(0));
  const before = statusCalls;
  const page = screen.getByRole('heading', { name: 'Settings' });
  currentPath = 'D:\\other.db';
  emit({ path: currentPath, reload: true, source: 'menu', message: `Opened ${currentPath}` });
  await waitFor(() => expect(statusCalls).toBeGreaterThan(before));
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).not.toBe(page));   // remounted
  expect(screen.getByTestId('where')).toHaveTextContent('/settings');
});

it('a result reported by Settings is not repeated as a window notice', async () => {
  renderApp('/settings');
  await screen.findByText('v1.0.25');
  const page = screen.getByRole('heading', { name: 'Settings' });
  emit({ path: 'D:\\other.db', reload: true, source: 'settings', message: 'Opened D:\\other.db' });
  expect(screen.getByTitle('D:\\other.db')).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Settings' })).toBe(page);   // Settings keeps its own message
});

it('stops listening when the window content is torn down', async () => {
  const view = renderApp('/settings');
  await screen.findByText('v1.0.25');
  expect(listeners.length).toBeGreaterThan(0);
  view.unmount();
  expect(listeners).toHaveLength(0);
});

it('header keeps the open file, version and theme on one row and the page links on their own row (v1.0.28)', async () => {
  renderApp('/settings');
  const path = await screen.findByTestId('current-file-path');
  await waitFor(() => expect(path).toHaveTextContent(currentPath));
  // The full path is always available as a tooltip; long paths are shortened from the left.
  expect(path).toHaveAttribute('title', currentPath);
  expect(path.className).toContain('truncate');
  expect(path.className).toContain('[direction:rtl]');
  expect(path.querySelector('bdi')).toHaveAttribute('dir', 'ltr');
  const header = path.closest('header')!;
  const nav = header.querySelector('nav')!;
  expect(nav).toHaveAttribute('aria-label', 'Pages');
  // The file path, version and theme controls are not inside the link row, so they cannot be pushed off screen by it.
  expect(nav.contains(path)).toBe(false);
  expect(nav.contains(screen.getByTitle('Toggle theme'))).toBe(false);
  expect(nav.contains(screen.getByTitle('About Credit Card Benefit Tracker'))).toBe(false);
  // Links never break inside a label and the row wraps rather than overflowing.
  expect(nav.className).toContain('flex-wrap');
  const links = Array.from(nav.querySelectorAll('a'));
  expect(links.map(a => a.textContent)).toEqual([
    'Credits & Usages', 'Ongoing Benefits', 'Cards', 'Programs', 'Bonus Categories', 'Points Values', 'Manage Benefits', 'Refresh', 'Settings',
  ]);
  for (const a of links) expect(a.className).toContain('whitespace-nowrap');
});
