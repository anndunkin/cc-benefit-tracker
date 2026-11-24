import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { seededDb } from './helpers';
import * as data from '../electron/database';
import { isDiamondChoices, tracksEarnedNights } from '../electron/benefitRules';
import { buildExpiringReport, utcDateFor } from '../electron/expiringCredits';
import BenefitDashboard from '../src/components/BenefitDashboard';
import LogUsageModal from '../src/components/LogUsageModal';

let db: ReturnType<typeof seededDb>;
beforeEach(() => {
  db = seededDb(); data.applyDataMigrations(db);
  window.api = {
    benefits: {
      getById: async id => data.benefitGetById(db, id),
      update: async (id, patch) => data.benefitUpdate(db, id, patch),
      getChoices: async (id, year) => data.benefitGetChoices(db, id, year),
      setChoices: async (id, year, ids) => data.benefitSetChoices(db, id, year, ids),
    },
    cards: { getAll: async () => data.cardsGetAll(db) },
    programs: { getAll: async () => data.programsGetAll(db) },
    projection: { all: async year => data.computeProjections(db, year!) },
    usages: {
      getForBenefit: async id => data.usagesForBenefit(db, id),
      create: async input => data.usageCreate(db, input),
      delete: async id => { data.usageDelete(db, id); return { ok: true }; },
    },
  } as typeof window.api;
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); db.close(); vi.restoreAllMocks(); });

it('saves multiple earned nights through the actual entry form', async () => {
  const b = data.benefitsGetAll(db).find(tracksEarnedNights)!;
  const saved = vi.fn();
  render(<LogUsageModal benefitId={b.id} onClose={() => {}} onSaved={saved} />);
  fireEvent.change(await screen.findByLabelText('Number of nights earned'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save usage' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(data.usagesForBenefit(db, b.id)[0].quantity).toBe(7);
});

it.each(['hyatt_visa', 'marriott_business'])('allows %s expiration-only save without marking used', async card => {
  const b = data.benefitsGetAll(db).find(b => b.card_id === card && b.title.startsWith('Annual'))!;
  const saved = vi.fn();
  render(<LogUsageModal benefitId={b.id} onClose={() => {}} onSaved={saved} />);
  fireEvent.change(await screen.findByLabelText('Certificate expiration date'), { target: { value: '2027-10-10' } });
  expect(screen.queryByLabelText('Date used')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save expiration' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(data.benefitGetById(db, b.id)?.expiration_date).toBe('2027-10-10');
  expect(data.usagesForBenefit(db, b.id)).toHaveLength(0);
});

it('saves the generated Hyatt expiration with Date used blank, even after opening the redemption fields', async () => {
  const spend = data.benefitsForCard(db, 'hyatt_visa').find(b => b.spend_threshold_usd === 15000)!;
  data.usageCreate(db, { benefit_id: spend.id, used_on: '2026-09-15', amount_usd: 15000 });
  data.reconcileCertificateAwards(db, '2026-11-24');
  const id = data.buildFilePayload(db).certificate_awards!.find(a => a.kind === 'hyatt_spend')!.award_id;
  const saved = vi.fn();
  render(<LogUsageModal benefitId={id} onClose={() => {}} onSaved={saved} />);
  const date = await screen.findByLabelText('Certificate expiration date');
  expect(screen.queryByRole('button', { name: 'Save usage' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Date used')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Log redemption…' }));
  expect(screen.getByLabelText('Date used')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Save redemption' })).toBeDisabled();
  fireEvent.change(date, { target: { value: '2026-10-25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save expiration' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(data.benefitGetById(db, id)?.expiration_date).toBe('2026-10-25');
  expect(data.usagesForBenefit(db, id)).toEqual([]);

  // onSaved normally unmounts the dialog. Re-open it to exercise a separate redemption.
  cleanup();
  render(<LogUsageModal benefitId={id} onClose={() => {}} onSaved={saved} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Log redemption…' }));
  fireEvent.change(screen.getByLabelText('Date used'), { target: { value: '2026-10-24' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save redemption' }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
  expect(data.usagesForBenefit(db, id)).toMatchObject([{ used_on: '2026-10-24' }]);
});

it('shows the new expiration on the same Hyatt dashboard tile and report after a 2026-to-2027 edit', async () => {
  const today = '2026-11-24';
  const spend = data.benefitsForCard(db, 'hyatt_visa').find(b => b.spend_threshold_usd === 15000)!;
  data.usageCreate(db, { benefit_id: spend.id, used_on: '2026-09-15', amount_usd: 15000 });
  data.reconcileCertificateAwards(db, today);
  const id = data.buildFilePayload(db).certificate_awards!.find(a => a.kind === 'hyatt_spend')!.award_id;
  const carryover = data.benefitsForCard(db, 'hyatt_visa').find(b => b.title === 'Carried-over Category 1-4 Free Night (expires 2026-11-26)')!;
  data.benefitUpdate(db, id, { expiration_date: '2026-10-25' });
  data.benefitUpdate(db, carryover.id, { expiration_date: '2027-11-26' });
  const projections = () => data.computeProjections(db, 2026, utcDateFor(today));
  window.api.projection.all = async () => projections();
  render(<MemoryRouter><BenefitDashboard mode="consumable" title="Credits & Usage" /></MemoryRouter>);
  const title = await screen.findByText('Hyatt Category 1–4 Free Night Award ($15,000 spend)');
  const tile = within(title.closest<HTMLElement>('[data-benefit-id]')!);
  expect(tile.getByText('2026-10-25')).toBeInTheDocument();
  fireEvent.click(tile.getByRole('button', { name: 'Edit expiration…' }));
  const field = await screen.findByLabelText('Certificate expiration date');
  expect(field).toHaveValue('2026-10-25');
  fireEvent.change(field, { target: { value: '2027-10-25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save expiration' }));
  expect(await tile.findByText('2027-10-25')).toHaveAttribute('datetime', '2027-10-25');
  expect(tile.queryByText('2026-10-25')).not.toBeInTheDocument();
  expect(tile.getByText(/Earned from 2026 spend/)).toBeInTheDocument();

  const report = buildExpiringReport(projections(), today);
  expect(report.items.find(p => p.benefit_id === id)).toMatchObject({
    title: 'Hyatt Category 1–4 Free Night Award ($15,000 spend)',
    expires_on: '2027-10-25',
    note: 'Earned from 2026 spend.',
  });
  expect(report.items.find(p => p.benefit_id === carryover.id)).toMatchObject({
    title: 'Carried-over Category 1-4 Free Night', expires_on: '2027-11-26', note: 'Cannot be extended.',
  });
});

it('logs one Omni reservation and shows its separate award and the IHG $250 summary', async () => {
  const today = '2026-11-24';
  const omni = data.benefitCreate(db, { card_id: 'aa_executive', title: 'Omni Free Night Award', category: 'free_night', reset_cadence: 'annual' });
  const ihg = data.benefitCreate(db, { card_id: 'ihg_premier', title: '$100 Annual Airline Statement Credit', category: 'airline_credit', reset_cadence: 'annual', value_usd: 100 });
  data.usageCreate(db, { benefit_id: omni.id, used_on: '2026-11-20', quantity: 1 });
  data.usageCreate(db, { benefit_id: omni.id, used_on: '2026-11-21', quantity: 1 });
  window.api.projection.all = async () => {
    data.reconcileCertificateAwards(db, today);
    return data.computeProjections(db, 2026, utcDateFor(today));
  };
  render(<MemoryRouter><BenefitDashboard mode="consumable" title="Credits & Usage" /></MemoryRouter>);
  const title = await screen.findByText('Earn an Omni Free Night Award');
  const sourceTile = within(title.closest<HTMLElement>('[data-benefit-id]')!);
  expect(sourceTile.getByText('Not yet earned')).toBeInTheDocument();
  expect(sourceTile.queryByRole('button', { name: 'Mark used' })).not.toBeInTheDocument();
  expect(screen.queryByText('Omni Free Night Award', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText('Requires one flight-ticket purchase of $250 or more booked directly with the airline.')).toBeInTheDocument();
  fireEvent.click(sourceTile.getByRole('button', { name: 'Log Omni stay' }));
  fireEvent.change(await screen.findByLabelText('Checkout date'), { target: { value: today } });
  fireEvent.change(screen.getByLabelText('Consecutive nights on this reservation'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save stay' }));
  const award = within((await screen.findByText('Omni Free Night Award', { exact: true })).closest<HTMLElement>('[data-benefit-id]')!);
  expect(sourceTile.getByText('Qualifying stay completed')).toBeInTheDocument();
  expect(award.getByText('0 of 1 used')).toBeInTheDocument();
  expect(award.getByRole('button', { name: 'Add expiration…' })).toBeInTheDocument();
  const report = buildExpiringReport(await window.api.projection.all(), today);
  expect(report.items.find(row => row.benefit_id === ihg.id)?.note).toMatch(/\$250 or more booked directly/);
});

it('hides and restores a credit from the dashboard', async () => {
  const b = data.benefitsGetAll(db).find(b => b.card_id === 'hyatt_visa' && b.title.startsWith('Annual'))!;
  db.prepare('UPDATE benefits SET is_active=0 WHERE id != ?').run(b.id);
  render(<MemoryRouter><BenefitDashboard mode="consumable" title="Credits & Usage" /></MemoryRouter>);
  await screen.findByText(b.title);
  fireEvent.click(screen.getByRole('button', { name: 'Hide', exact: true }));
  await waitFor(() => expect(screen.queryByText(b.title)).toBeNull());
  fireEvent.click(screen.getByLabelText('Show hidden'));
  await screen.findByText(b.title);
  fireEvent.click(screen.getByRole('button', { name: 'Unhide' }));
  await waitFor(() => expect(data.benefitGetById(db, b.id)?.is_hidden).toBe(0));
});

it('shows one Diamond achievement toggle, then three choice inputs and saves three selections', async () => {
  const parent = data.benefitsGetAll(db).find(isDiamondChoices)!;
  db.prepare('UPDATE benefits SET is_active=0 WHERE id != ? AND prerequisite_benefit_id IS NOT ?').run(parent.id, parent.id);
  render(<MemoryRouter><BenefitDashboard mode="consumable" title="Credits & Usage" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark achieved' }));
  await screen.findByRole('button', { name: 'Achieved (click to undo)' });
  expect(data.usagesForBenefit(db, parent.id)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /Choose rewards/ }));
  const inputs = [await screen.findByLabelText('Choice 1'), screen.getByLabelText('Choice 2'), screen.getByLabelText('Choice 3')];
  await waitFor(() => expect(inputs[0]).not.toBeDisabled());
  const ids = data.benefitsGetAll(db).filter(b => b.prerequisite_benefit_id === parent.id && !b.title.includes('Membership')).slice(0, 3).map(b => b.id);
  inputs.forEach((input, i) => fireEvent.change(input, { target: { value: String(ids[i]) } }));
  fireEvent.click(screen.getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(data.benefitGetChoices(db, parent.id, new Date().getUTCFullYear())).toEqual(ids));
  expect(data.usagesForBenefit(db, parent.id)).toHaveLength(1);
});

it('does not delete a usage when undo confirmation is declined', async () => {
  const parent = data.benefitsGetAll(db).find(isDiamondChoices)!;
  db.prepare('UPDATE benefits SET is_active=0 WHERE id != ?').run(parent.id);
  data.usageCreate(db, { benefit_id: parent.id, used_on: new Date().toISOString().slice(0, 10) });
  vi.mocked(window.confirm).mockReturnValue(false);
  render(<MemoryRouter><BenefitDashboard mode="consumable" title="Credits & Usage" /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Achieved (click to undo)' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(data.usagesForBenefit(db, parent.id)).toHaveLength(1);
});
