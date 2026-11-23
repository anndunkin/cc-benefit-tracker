import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { seededDb } from './helpers';
import * as data from '../electron/database';
import { offerBundledProposals, importProposalText, PROPOSAL_FORMAT } from '../electron/refreshProposal';
import Refresh from '../src/pages/Refresh';
import RefreshBanner from '../src/components/RefreshBanner';

let db: ReturnType<typeof seededDb>;
let fileText: string | null;

function proposalFor(benefitTitle: string, cardId: string) {
  return JSON.stringify({
    format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'ui-test', title: 'UI test refresh', prepared_on: '2026-11-22',
    changes: [{
      scope: 'benefit', change_type: 'modified', card_id: cardId, match_title: benefitTitle,
      after: { value_usd: 219, description: 'Up to $219 per calendar year.' },
      summary: 'The credit rose to $219.', effective_date: '2026-07-01',
      sources: [
        { url: 'https://example.com/terms', label: 'Issuer terms', source_type: 'official' },
        { url: 'https://example.org/post', source_type: 'secondary' },
      ],
    }],
  });
}

beforeEach(() => {
  db = seededDb(); data.applyDataMigrations(db);
  fileText = null;
  window.api = {
    cards: { getAll: async () => data.cardsGetAll(db) },
    programs: { getAll: async () => data.programsGetAll(db) },
    pointsCurrencies: { getAll: async () => data.pointsCurrenciesGetAll(db) },
    refresh: {
      getStatus: async () => data.refreshGetStatus(db),
      getPendingChanges: async runId => data.refreshPendingChanges(db, runId),
      approveChange: async (id, notes, overwrite) => data.refreshApproveChange(db, id, notes, overwrite === true),
      rejectChange: async (id, notes) => data.refreshRejectChange(db, id, notes),
      applyRun: async runId => data.refreshApplyRun(db, runId),
      discardRun: async runId => { data.refreshDiscardRun(db, runId); return { ok: true }; },
      checkBundled: async () => offerBundledProposals(db, { force: true, now: new Date(2026, 10, 22) }),
      importProposal: async () => {
        try { return importProposalText(db, fileText ?? ''); }
        catch (e) { return { state: 'cancelled', run_id: null, title: null, proposed: 0, already_current: 0, unmatched: [], error: (e as Error).message }; }
      },
    },
  } as typeof window.api;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); db.close(); vi.restoreAllMocks(); });

const clear = () => data.benefitsGetAll(db).find(b => b.card_id === 'hilton_aspire' && b.title.includes('CLEAR'))!;

it('offers a way to start a refresh when none is pending, and reports a bad file readably', async () => {
  render(<MemoryRouter><Refresh /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Check for benefit changes' })).toBeEnabled();
  fileText = '{"format":"something else"}';
  fireEvent.click(screen.getByRole('button', { name: 'Load refresh file…' }));
  expect(await screen.findByText(/Could not load the refresh: This is not a benefit refresh file/)).toBeInTheDocument();
  expect(data.refreshGetStatus(db).pending_run_id).toBeNull();
});

it('shows what would change, why, and where it was published before anything is applied', async () => {
  const b = clear();
  fileText = proposalFor(b.title, 'hilton_aspire');
  render(<MemoryRouter><Refresh /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load refresh file…' }));
  const row = await screen.findByTestId('refresh-change');
  expect(within(row).getByText('The credit rose to $219.')).toBeInTheDocument();
  expect(within(row).getByText('Effective 2026-07-01')).toBeInTheDocument();
  expect(within(row).getByText('$209')).toBeInTheDocument();
  expect(within(row).getByText('$219')).toBeInTheDocument();
  expect(within(row).getByText(/Hilton Honors Aspire/)).toBeInTheDocument();
  const link = within(row).getByRole('link', { name: 'Issuer terms' });
  expect(link).toHaveAttribute('href', 'https://example.com/terms');
  expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  expect(within(row).getByRole('link', { name: 'example.org' })).toBeInTheDocument();
  expect(row.textContent).not.toContain('_meta');
  expect(data.benefitGetById(db, b.id)!.value_usd).toBe(209);      // still untouched

  fireEvent.click(within(row).getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.getByText(/1 approved/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Apply approved' }));
  expect(await screen.findByText('Applied 1 change; skipped 0.')).toBeInTheDocument();
  expect(data.benefitGetById(db, b.id)!.value_usd).toBe(219);
  expect(await screen.findByRole('button', { name: 'Check for benefit changes' })).toBeInTheDocument();
});

it('requires an explicit choice before replacing a hand-edited benefit', async () => {
  const b = clear();
  data.benefitUpdate(db, b.id, { notes: 'my note' });
  fileText = proposalFor(b.title, 'hilton_aspire');
  render(<MemoryRouter><Refresh /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load refresh file…' }));
  const row = await screen.findByTestId('refresh-change');
  expect(within(row).getByText(/You edited this benefit by hand/)).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();

  // "Approve all" never grants the overwrite.
  fireEvent.click(screen.getByRole('button', { name: 'Approve all undecided' }));
  expect(await within(row).findByText(/will be skipped \(hand-edited\)/)).toBeInTheDocument();
  expect(data.refreshPendingChanges(db, data.refreshGetStatus(db).pending_run_id!)[0].overwrite_user_edit).toBe(0);

  fireEvent.click(within(row).getByRole('button', { name: 'Approve and replace my edit' }));
  expect(await within(row).findByText(/replaces your edit/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Apply approved' }));
  await screen.findByText('Applied 1 change; skipped 0.');
  const after = data.benefitGetById(db, b.id)!;
  expect(after.value_usd).toBe(219);
  expect(after.notes).toBe('my note');
});

it('asks before discarding and leaves benefits untouched', async () => {
  const b = clear();
  fileText = proposalFor(b.title, 'hilton_aspire');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<MemoryRouter><Refresh /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load refresh file…' }));
  await screen.findByTestId('refresh-change');
  fireEvent.click(screen.getByRole('button', { name: 'Discard refresh' }));
  expect(confirm).toHaveBeenCalled();
  expect(data.refreshGetStatus(db).pending_run_id).not.toBeNull();   // declined → still there
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'Discard refresh' }));
  expect(await screen.findByText(/Refresh discarded/)).toBeInTheDocument();
  expect(data.benefitGetById(db, b.id)!.value_usd).toBe(209);
});

it('lists changes that could not be matched instead of dropping them silently', async () => {
  fileText = proposalFor('A benefit that was renamed', 'hilton_aspire');
  render(<MemoryRouter><Refresh /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load refresh file…' }));
  expect(await screen.findByText('Could not be matched (1)')).toBeInTheDocument();
  expect(screen.getByText('A benefit that was renamed')).toBeInTheDocument();
  expect(data.refreshGetStatus(db).pending_run_id).toBeNull();
});

it('the bundled refresh opens for review and the banner points to it', async () => {
  render(<MemoryRouter><RefreshBanner /><Refresh /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Check for benefit changes' }));
  const rows = await screen.findAllByTestId('refresh-change');
  expect(rows.length).toBeGreaterThan(10);
  cleanup();
  render(<MemoryRouter><RefreshBanner /></MemoryRouter>);
  expect(await screen.findByText('Benefit changes are ready for your review.')).toBeInTheDocument();
});

it('shows a proposed loyalty program, and says its benefits depend on it until it is approved (v1.0.27)', async () => {
  fileText = JSON.stringify({
    format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'ui-test-program', title: 'UI test program', prepared_on: '2026-11-23',
    changes: [
      { scope: 'program', change_type: 'added', program_id: 'ui_hotel_status',
        after: { name: 'UI Hotel Status', program_type: 'hotel_elite_status', source_url: 'https://example.com/program' },
        summary: 'Adds the hotel program.', sources: [{ url: 'https://example.com/program', label: 'Program page', source_type: 'official' }] },
      { scope: 'benefit', change_type: 'added', program_id: 'ui_hotel_status',
        after: { title: 'Late checkout', category: 'status_boost', reset_cadence: 'unlimited', value_usd: 0 },
        summary: 'Tier benefit.', sources: [{ url: 'https://example.com/program', label: 'Program page', source_type: 'official' }] },
    ],
  });
  render(<MemoryRouter><Refresh /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load refresh file…' }));
  const rows = await screen.findAllByTestId('refresh-change');
  expect(rows).toHaveLength(2);
  const programRow = rows.find(r => within(r).queryByText('Adds the hotel program.'))!;
  const benefitRow = rows.find(r => within(r).queryByText('Tier benefit.'))!;
  expect(within(programRow).getByText(/New loyalty program · 1 benefit proposed with it/)).toBeInTheDocument();
  expect(within(programRow).getAllByText('UI Hotel Status').length).toBeGreaterThan(0);
  expect(within(programRow).getAllByText(/Hotel elite status/i).length).toBeGreaterThan(0);
  expect(within(programRow).getByText(/added only if this\s+row is approved/)).toBeInTheDocument();
  expect(programRow.textContent).not.toContain('hotel_elite_status');
  // The benefit names the new program as its owner and warns that it depends on it.
  expect(within(benefitRow).getAllByText(/UI Hotel Status/).length).toBeGreaterThan(1);
  expect(benefitRow.textContent).not.toContain('ui_hotel_status');
  expect(within(benefitRow).getByTestId('needs-program')).toHaveTextContent('added only if the new program "UI Hotel Status" is also approved');
  expect(data.programsGetAll(db).some(p => p.id === 'ui_hotel_status')).toBe(false);

  fireEvent.click(within(programRow).getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.queryByTestId('needs-program')).not.toBeInTheDocument());
  fireEvent.click(within(screen.getAllByTestId('refresh-change').find(r => within(r).queryByText('Tier benefit.'))!).getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.getByText(/2 approved/)).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Apply approved' }));
  expect(await screen.findByText('Applied 2 changes; skipped 0.')).toBeInTheDocument();
  expect(data.programsGetAll(db).find(p => p.id === 'ui_hotel_status')).toMatchObject({ name: 'UI Hotel Status', program_type: 'hotel_elite_status' });
  expect(data.benefitsGetAll(db).filter(b => b.program_id === 'ui_hotel_status').map(b => b.title)).toEqual(['Late checkout']);
});
