import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { seededDb } from './helpers';
import * as data from '../electron/database';
import { isDiamondChoices, tracksEarnedNights } from '../electron/benefitRules';
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
  fireEvent.click(screen.getByRole('button', { name: 'Save expiration only' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(data.benefitGetById(db, b.id)?.expiration_date).toBe('2027-10-10');
  expect(data.usagesForBenefit(db, b.id)).toHaveLength(0);
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
