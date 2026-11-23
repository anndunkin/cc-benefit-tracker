import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import LogUsageModal from '../src/components/LogUsageModal';
import { localIsoDate, utcDateFor } from '../electron/expiringCredits';
import { computeProjections } from '../electron/database';
import { seededDb } from './helpers';

// v1.0.26: "today" is the calendar date where the user is. Before, the app
// used the UTC date, which in US Eastern time is already tomorrow from 7 PM
// (8 PM in summer), so a use logged on the last evening of a month was filed
// under the next month.

const savedTz = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/New_York'; });
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

// 8:30 PM Eastern on December 31, 2026 is 1:30 AM UTC on January 1, 2027.
const NEW_YEARS_EVE_EVENING = new Date('2027-01-01T01:30:00Z');

it('the evening of December 31 in Atlanta is still December 31', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NEW_YEARS_EVE_EVENING);
  expect(new Date().getHours()).toBe(20);                       // the test really runs in Eastern time
  expect(new Date().toISOString().slice(0, 10)).toBe('2027-01-01');
  expect(localIsoDate()).toBe('2026-12-31');
});

it('a use logged that evening is dated December 31 by default', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NEW_YEARS_EVE_EVENING);
  window.api = {
    benefits: { getById: async () => ({ id: 7, title: 'Digital Entertainment Credit', category: 'entertainment_credit', reset_cadence: 'monthly', value_usd: 25, uses_per_period: 1, expiration_date: null }) },
    usages: { getForBenefit: async () => [] },
  } as unknown as typeof window.api;
  render(<LogUsageModal benefitId={7} onClose={() => {}} onSaved={() => {}} />);
  expect(await screen.findByLabelText('Date used')).toHaveValue('2026-12-31');
});

it('the dashboard numbers for that evening are December numbers', () => {
  const db = seededDb();
  try {
    const today = localIsoDate(NEW_YEARS_EVE_EVENING);
    const year = parseInt(today.slice(0, 4), 10);
    const monthly = computeProjections(db, year, utcDateFor(today)).find(p => p.benefit.reset_cadence === 'monthly')!;
    expect(year).toBe(2026);
    expect(monthly.next_reset).toBe('2027-01-01');
    expect(monthly.ref_year).toBe(2026);
  } finally { db.close(); }
});
