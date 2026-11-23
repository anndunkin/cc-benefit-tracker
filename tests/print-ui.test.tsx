import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { AppRoute, ExpiringItem, ExpiringReport, FileChangeInfo, PrintResult } from '../electron/types';
import App from '../src/App';
import PrintExpiring, { loadPrefs, remainingText, rowKey, summaryText } from '../src/pages/PrintExpiring';

// The Print Expiring Credits screen (v1.0.26).

const PREFS_KEY = 'cct.printExpiring.v1';
const FILE = 'C:\\Users\\ann\\AppData\\Roaming\\cc-benefit-tracker\\cc-benefit-tracker.db';

function item(over: Partial<ExpiringItem> & { benefit_id: number; title: string }): ExpiringItem {
  return {
    owner_kind: 'card', owner_id: 'amex_platinum', owner_name: 'The Platinum Card', category: 'dining_credit', cadence: 'monthly',
    is_travel: false, kind: 'credit', expires_on: '2026-11-30', expiry_source: 'period', date_not_recorded: false,
    partially_used: false, value_remaining_usd: 25, value_total_usd: 25, value_each_usd: null,
    uses_remaining: 1, uses_max: 1, note: null, ...over,
  };
}

const ITEMS: ExpiringItem[] = [
  item({ benefit_id: 1, title: 'Digital Entertainment Credit' }),
  item({ benefit_id: 2, title: 'Uber Cash', category: 'rideshare_credit', is_travel: true, value_remaining_usd: 7.5, value_total_usd: 15, partially_used: true }),
  item({ benefit_id: 3, title: 'Airline Fee Credit', category: 'airline_credit', cadence: 'annual', is_travel: true, expires_on: '2026-12-31', value_remaining_usd: 40, value_total_usd: 200, partially_used: true }),
  item({ benefit_id: 4, title: 'Oura Ring Credit', category: 'wellness_credit', cadence: 'annual', expires_on: '2026-12-31', value_remaining_usd: 200, value_total_usd: 200 }),
  item({
    benefit_id: 5, title: 'Sky Club Visits', owner_id: 'delta_reserve', owner_name: 'Delta Reserve', category: 'lounge_access', cadence: 'annual',
    is_travel: true, kind: 'certificate', expires_on: '2026-12-31', date_not_recorded: true, partially_used: true,
    value_remaining_usd: null, value_total_usd: null, uses_remaining: 12, uses_max: 15, note: 'Visits reset each Medallion Year (Feb 1).',
  }),
  item({
    benefit_id: 6, title: 'Carried-over Free Night', owner_id: 'hyatt_visa', owner_name: 'World of Hyatt', category: 'free_night', cadence: 'one_time',
    is_travel: true, kind: 'certificate', expires_on: '2027-03-27', expiry_source: 'date',
    value_remaining_usd: null, value_total_usd: null,
  }),
];

function reportOf(items: ExpiringItem[] = ITEMS, today = '2026-11-22'): ExpiringReport {
  const y = Number(today.slice(0, 4));
  const monthEnd = today.slice(5, 7) === '12' ? `${y}-12-31` : `${y}-11-30`;
  return { today, month_end: monthEnd, year_end: `${y}-12-31`, next_year_end: `${y + 1}-12-31`, items };
}

let report: ExpiringReport;
let currentPath: string;
let printResult: PrintResult;
let printCalls: number;
let navListeners: Array<(route: AppRoute) => void>;
let fileListeners: Array<(info: FileChangeInfo) => void>;

beforeEach(() => {
  localStorage.clear();
  report = reportOf(); currentPath = FILE; printResult = { success: true }; printCalls = 0;
  navListeners = []; fileListeners = [];
  window.api = {
    expiring: { list: async () => report },
    file: {
      currentPath: async () => currentPath,
      onChanged: (l: (info: FileChangeInfo) => void) => { fileListeners.push(l); return () => { fileListeners = fileListeners.filter(x => x !== l); }; },
    },
    app: {
      getVersion: async () => '1.0.26', showAbout: async () => {},
      print: async () => { printCalls++; return printResult; },
      onNavigate: (l: (route: AppRoute) => void) => { navListeners.push(l); return () => { navListeners = navListeners.filter(x => x !== l); }; },
    },
    refresh: { getStatus: async () => ({ last_run_at: null, next_due: '2099-01-01', pending_run_id: null }) },
    projection: { all: async () => [] },
    cards: { getAll: async () => [] },
    programs: { getAll: async () => [] },
  } as unknown as typeof window.api;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function open() {
  const view = render(<MemoryRouter><PrintExpiring /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'Print Expiring Credits' });
  return view;
}
const sheet = () => screen.getByRole('region', { name: 'Printable list' });
const rowFor = (title: string) => within(sheet()).getByText(title).closest('tr')!;
const listed = () => Array.from(sheet().querySelectorAll('tr[data-benefit-id]')).map(tr => Number(tr.getAttribute('data-benefit-id')));
const tick = (title: RegExp) => screen.getByRole('checkbox', { name: title });
const emitNav = (route: AppRoute) => act(async () => { for (const l of [...navListeners]) l(route); });

describe('what is left, in words', () => {
  it('always states the amount remaining on a partly used credit', () => {
    expect(remainingText(ITEMS[0])).toBe('$25');
    expect(remainingText(ITEMS[1])).toBe('$7.50 left of $15');
    expect(remainingText(ITEMS[2])).toBe('$40 left of $200');
    expect(remainingText(ITEMS[4])).toBe('12 of 15 left');
    expect(remainingText(ITEMS[5])).toBe('Unused');
    expect(remainingText({ ...ITEMS[5], value_each_usd: 245 })).toBe('Unused (valued at $245)');
    expect(remainingText({ ...ITEMS[4], partially_used: false, uses_remaining: 15 })).toBe('All 15 unused');
    expect(remainingText({ ...ITEMS[4], kind: 'other', uses_max: 2, uses_remaining: 1 })).toBe('1 of 2 uses left');
  });

  it('sums up dollars, certificates and their uses', () => {
    expect(summaryText({ dollars: 272.5, credits: 4, certificates: 2, certificateUses: 13, others: 1 }))
      .toBe('Dollar credits remaining: $272.50 across 4 credits · 2 certificates or passes (13 uses in all) · 1 other benefit');
    expect(summaryText({ dollars: 25, credits: 1, certificates: 1, certificateUses: 1, others: 0 }))
      .toBe('Dollar credits remaining: $25 across 1 credit · 1 certificate or pass');
  });
});

describe('Print Expiring Credits screen', () => {
  it('starts with this month and shows the partly used amount on the sheet', async () => {
    await open();
    expect(screen.getByRole('radio', { name: /This month/ })).toBeChecked();
    expect(listed()).toEqual([1, 2]);
    expect(within(sheet()).getByRole('heading', { name: 'Credits and certificates expiring in November 2026' })).toBeInTheDocument();
    const uber = rowFor('Uber Cash');
    expect(uber).toHaveTextContent('$7.50 left of $15');
    expect(uber).toHaveTextContent('Partly used');
    expect(uber).toHaveTextContent('Nov 30, 2026');
    expect(uber).toHaveTextContent('end of month · in 8 days');
    expect(rowFor('Digital Entertainment Credit')).not.toHaveTextContent('Partly used');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2 will print');
    expect(sheet()).toHaveTextContent('Dollar credits remaining: $32.50 across 2 credits');
    expect(sheet()).toHaveTextContent('1 partly used; the amount still available is shown.');
  });

  it('this year, travel only and later certificates change the list as labelled', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: /This year/ }));
    expect(listed().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(within(sheet()).getByRole('heading', { name: 'Credits and certificates expiring in 2026' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /^Travel only/ }));
    expect(listed().sort()).toEqual([2, 3, 5]);
    expect(sheet()).toHaveTextContent('travel only');

    fireEvent.click(screen.getByRole('checkbox', { name: /^Also include certificates expiring through Dec 31, 2027/ }));
    expect(listed().sort()).toEqual([2, 3, 5, 6]);
    expect(sheet()).toHaveTextContent('plus certificates expiring through December 31, 2027');
    expect(rowFor('Carried-over Free Night')).toHaveTextContent('Mar 27, 2027');
    expect(rowFor('Carried-over Free Night')).toHaveTextContent('expiration date');

    // The choices are remembered.
    expect(loadPrefs()).toMatchObject({ scope: 'year', travelOnly: true, includeLater: true });
    cleanup();
    await open();
    expect(screen.getByRole('radio', { name: /This year/ })).toBeChecked();
    expect(listed().sort()).toEqual([2, 3, 5, 6]);
  });

  it('does not print a deadline the app does not know: an undated certificate says to check it', async () => {
    await open();
    fireEvent.click(screen.getByRole('radio', { name: /This year/ }));
    const visits = rowFor('Sky Club Visits');
    expect(visits).toHaveTextContent('Check certificate');
    expect(visits).toHaveTextContent('no date recorded · tracked through Dec 31, 2026');
    expect(visits).toHaveTextContent('12 of 15 left');
    expect(visits).toHaveTextContent('Visits reset each Medallion Year (Feb 1).');
    expect(sheet()).toHaveTextContent('"Check certificate" or "Check terms" means no expiration date is recorded');
    expect(sheet()).toHaveTextContent('1 certificate or pass (12 uses in all)');
  });

  it('lets rows be unticked, says how many were left off, and remembers it for that deadline only', async () => {
    await open();
    fireEvent.click(tick(/^Print Uber Cash/));
    expect(tick(/^Print Uber Cash/)).not.toBeChecked();
    expect(rowFor('Uber Cash').className).toMatch(/print:hidden/);
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 will print · 1 left off (unticked)');
    expect(sheet()).toHaveTextContent('1 other expiring item was left off this list by choice.');
    expect(sheet()).toHaveTextContent('Dollar credits remaining: $25 across 1 credit');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).excluded[FILE]).toEqual(['2@2026-11-30']);
    expect(rowKey(ITEMS[1])).toBe('2@2026-11-30');

    cleanup();
    await open();
    expect(tick(/^Print Uber Cash/)).not.toBeChecked();

    // Next month's Uber Cash is a new row and is listed again.
    cleanup();
    report = reportOf([item({ benefit_id: 2, title: 'Uber Cash', expires_on: '2026-12-31', value_remaining_usd: 15, value_total_usd: 15 })], '2026-12-01');
    await open();
    expect(tick(/^Print Uber Cash/)).toBeChecked();

    // Another data file has its own ticks.
    cleanup();
    report = reportOf(); currentPath = 'D:\\other.db';
    await open();
    expect(tick(/^Print Uber Cash/)).toBeChecked();
  });

  it('Clear all and Select all work on the rows shown', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('status')).toHaveTextContent('0 of 2 will print · 2 left off (unticked)');
    expect(screen.getByRole('button', { name: 'Print…' })).toBeDisabled();
    expect(sheet()).toHaveTextContent('Every row is unticked, so there is nothing to print.');
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('status')).toHaveTextContent('2 of 2 will print');
    expect(screen.getByRole('button', { name: 'Print…' })).toBeEnabled();
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).excluded[FILE]).toEqual([]);
  });

  it('says so when nothing is expiring', async () => {
    report = reportOf([]);
    await open();
    expect(sheet()).toHaveTextContent('Nothing with a balance left is expiring in this period with these choices.');
    expect(screen.getByRole('button', { name: 'Print…' })).toBeDisabled();
  });

  it('opens the print dialog once, stays quiet on cancel and explains a failure', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(printCalls).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Print…' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();

    printResult = { success: false, cancelled: true };
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(printCalls).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Print…' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();

    printResult = { success: false, error: 'no printer' };
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Printing did not start (no printer). Check that a printer is set up in Windows');
  });

  it('does not print a list that went out of date while the page was open', async () => {
    await open();
    expect(listed()).toEqual([1, 2]);
    // A use was logged elsewhere, or the date changed: the list is different now.
    report = reportOf([ITEMS[0]]);
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    expect(await screen.findByText(/brought up to date because the date or your data changed/)).toBeInTheDocument();
    expect(printCalls).toBe(0);
    expect(listed()).toEqual([1]);
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(printCalls).toBe(1));
  });

  it('does not print when the list cannot be read again just before printing', async () => {
    await open();
    window.api.expiring.list = async () => { throw new Error('database is closed'); };
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The list could not be prepared: database is closed');
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(printCalls).toBe(0);
  });

  it('does not print another screen when this one is left before the list is confirmed', async () => {
    const view = await open();
    let release: (r: ExpiringReport) => void = () => {};
    window.api.expiring.list = () => new Promise<ExpiringReport>(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    view.unmount();
    await act(async () => { release(report); await new Promise(r => setTimeout(r, 20)); });
    expect(printCalls).toBe(0);
  });

  it('does not print the old sheet when a reload and Print overlap', async () => {
    await open();
    expect(listed()).toEqual([1, 2]);
    // The window regains focus and Print is chosen before that reload has come back;
    // both reads then return the same, different list.
    const waiting: Array<(r: ExpiringReport) => void> = [];
    window.api.expiring.list = () => new Promise<ExpiringReport>(resolve => { waiting.push(resolve); });
    fireEvent(window, new Event('focus'));
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    expect(waiting).toHaveLength(2);
    const changed = reportOf([ITEMS[0]]);
    await act(async () => { for (const w of waiting) w(changed); await new Promise(r => setTimeout(r, 20)); });
    expect(printCalls).toBe(0);
    expect(await screen.findByText(/brought up to date because the date or your data changed/)).toBeInTheDocument();
    expect(listed()).toEqual([1]);
    // The earlier, overtaken read never replaces the newer one.
    window.api.expiring.list = async () => changed;
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    await waitFor(() => expect(printCalls).toBe(1));
  });

  it('fixes the choices once Print is chosen, so the sheet cannot change under the print dialog', async () => {
    await open();
    let release: (r: ExpiringReport) => void = () => {};
    window.api.expiring.list = () => new Promise<ExpiringReport>(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
    expect(tick(/^Print Uber Cash/)).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^This year/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    fireEvent.click(tick(/^Print Uber Cash/));
    await act(async () => { release(report); await new Promise(r => setTimeout(r, 20)); });
    expect(printCalls).toBe(1);
    expect(listed()).toEqual([1, 2]);
    expect(tick(/^Print Uber Cash/)).toBeChecked();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled());
  });

  it('does not print the previous file when another file is opened while the list is being confirmed', async () => {
    await open();
    const waiting: Array<(r: ExpiringReport) => void> = [];
    const before = report;
    window.api.expiring.list = () => new Promise<ExpiringReport>(resolve => { waiting.push(resolve); });
    fireEvent.click(screen.getByRole('button', { name: 'Print…' }));
    // Save As or Open happens now: a newer read starts for the other file.
    await act(async () => { for (const l of [...fileListeners]) l({ path: 'D:\\moved.db', reload: false, source: 'menu' } as FileChangeInfo); });
    expect(waiting).toHaveLength(2);
    // The older read comes back first with what it saw before the switch.
    await act(async () => { waiting[0](before); await new Promise(r => setTimeout(r, 20)); });
    expect(printCalls).toBe(0);
    expect(screen.getByText(/brought up to date because the date or your data changed/)).toBeInTheDocument();
    currentPath = 'D:\\moved.db';
    await act(async () => { waiting[1](reportOf([ITEMS[1]])); await new Promise(r => setTimeout(r, 20)); });
    expect(listed()).toEqual([2]);
    expect(printCalls).toBe(0);
  });

  it('keeps the newest read when an older one comes back late', async () => {
    await open();
    const waiting: Array<(r: ExpiringReport) => void> = [];
    window.api.expiring.list = () => new Promise<ExpiringReport>(resolve => { waiting.push(resolve); });
    fireEvent(window, new Event('focus'));
    fireEvent(window, new Event('focus'));
    expect(waiting).toHaveLength(2);
    await act(async () => { waiting[1](reportOf([ITEMS[1]])); await new Promise(r => setTimeout(r, 10)); });
    await act(async () => { waiting[0](reportOf([ITEMS[0]])); await new Promise(r => setTimeout(r, 10)); });
    expect(listed()).toEqual([2]);
  });

  it('follows the open file: Save As or Open reloads the list and uses that file\'s ticks', async () => {
    await open();
    currentPath = 'D:\\moved.db';
    report = reportOf([ITEMS[1]]);
    await act(async () => { for (const l of [...fileListeners]) l({ path: currentPath, reload: false, source: 'menu' } as FileChangeInfo); });
    await waitFor(() => expect(listed()).toEqual([2]));
    fireEvent.click(tick(/^Print Uber Cash/));
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)!).excluded;
    expect(saved['D:\\moved.db']).toEqual(['2@2026-11-30']);
    expect(saved[FILE] ?? []).toEqual([]);
  });

  it('shows a message when the list cannot be prepared', async () => {
    window.api.expiring.list = async () => { throw new Error('database is closed'); };
    render(<MemoryRouter><PrintExpiring /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('The list could not be prepared: database is closed');
  });

  it('says why Ctrl+P does nothing when every row is unticked, and labels the columns in every group', async () => {
    await open();
    for (const table of Array.from(sheet().querySelectorAll('table'))) {
      expect(within(table as HTMLElement).getByRole('columnheader', { name: 'Use by' })).toBeInTheDocument();
      expect(within(table as HTMLElement).getByRole('columnheader', { name: 'Remaining' })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('button', { name: 'Print…' })).toBeDisabled();
    await emitNav('print-expiring');
    expect(await screen.findByText('Tick at least one row to print.')).toBeInTheDocument();
    expect(printCalls).toBe(0);
  });

  it('ignores remembered choices that are damaged', () => {
    localStorage.setItem(PREFS_KEY, '{not json');
    expect(loadPrefs()).toEqual({ scope: 'month', travelOnly: false, includeLater: false, excluded: {} });
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'decade', travelOnly: 'yes', excluded: { a: [1, '2@2026-11-30', 'x@y', null] } }));
    expect(loadPrefs()).toEqual({ scope: 'month', travelOnly: false, includeLater: false, excluded: { a: ['2@2026-11-30'] } });
  });
});

describe('getting there', () => {
  function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }

  it('File > Print Expiring Credits opens the screen, and Ctrl+P there prints', async () => {
    render(<MemoryRouter initialEntries={['/settings']}><App /><Where /></MemoryRouter>);
    expect(screen.getByTestId('where')).toHaveTextContent('/settings');
    await emitNav('print-expiring');
    expect(screen.getByTestId('where')).toHaveTextContent('/print-expiring');
    await screen.findByRole('heading', { name: 'Print Expiring Credits' });
    await waitFor(() => expect(listed()).toEqual([1, 2]));
    expect(printCalls).toBe(0);
    await emitNav('print-expiring');
    await waitFor(() => expect(printCalls).toBe(1));
    expect(screen.getByTestId('where')).toHaveTextContent('/print-expiring');
  });

  it('does not walk away from an open form', async () => {
    render(<MemoryRouter initialEntries={['/settings']}><App /><Where /></MemoryRouter>);
    const form = document.createElement('div');
    form.className = 'fixed inset-0';
    document.querySelector('main')!.appendChild(form);
    await emitNav('print-expiring');
    expect(screen.getByTestId('where')).toHaveTextContent('/settings');
    expect(await screen.findByText('Close the open form first, then choose Print Expiring Credits again.')).toBeInTheDocument();
    form.remove();
    await emitNav('print-expiring');
    expect(screen.getByTestId('where')).toHaveTextContent('/print-expiring');
  });

  it('Credits & Usages links to the screen', async () => {
    render(<MemoryRouter initialEntries={['/']}><App /><Where /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('link', { name: 'Print expiring credits…' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/print-expiring');
    await screen.findByRole('heading', { name: 'Print Expiring Credits' });
    await waitFor(() => expect(listed()).toEqual([1, 2]));
  });
});
