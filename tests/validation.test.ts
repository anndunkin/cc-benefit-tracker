import { describe, it, expect } from 'vitest';
import { seededDb, emptyDb } from './helpers';
import {
  cardCreate, cardUpdate, cardDelete, cardsGetAll,
  programCreate, programUpdate, programDelete,
  benefitCreate, benefitUpdate, benefitsGetAll,
  usageCreate,
  refreshStartRun, refreshGetStatus,
  pointsCurrencyCreate, pointsCurrencyUpdate, pointsCurrencyGetById, pointsCurrenciesGetAll,
} from '../electron/database';

describe('Card validation', () => {
  it('rejects a card without a name', () => {
    const db = seededDb();
    expect(() => cardCreate(db, { name: '  ', issuer: 'X', network: 'Visa' })).toThrow(/name/i);
  });
  it('rejects a card without an issuer', () => {
    const db = seededDb();
    expect(() => cardCreate(db, { name: 'X', issuer: '', network: 'Visa' })).toThrow(/issuer/i);
  });
  it('enforces the network CHECK constraint', () => {
    const db = seededDb();
    expect(() => cardCreate(db, { name: 'X', issuer: 'X', network: 'Bogus' as any })).toThrow();
  });
  it('returns null when fetching a non-existent card', () => {
    const db = seededDb();
    expect(cardUpdate(db, 'nope', { name: 'X' })).toBeNull();
  });
});

describe('Program validation', () => {
  it('rejects a program without a name', () => {
    const db = emptyDb();
    expect(() => programCreate(db, { name: '', program_type: 'airline' })).toThrow(/name/i);
  });
  it('enforces program_type CHECK constraint', () => {
    const db = emptyDb();
    expect(() => programCreate(db, { name: 'X', program_type: 'starship' as any })).toThrow();
  });
});

describe('Benefit validation', () => {
  it('rejects a benefit with neither card_id nor program_id', () => {
    const db = seededDb();
    expect(() => benefitCreate(db, {
      card_id: null, program_id: null,
      title: 'Orphan', category: 'other', reset_cadence: 'annual',
    })).toThrow();
  });

  it('rejects a benefit with both card_id AND program_id', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    expect(() => benefitCreate(db, {
      card_id: card.id, program_id: 'delta_medallion',
      title: 'Both', category: 'other', reset_cadence: 'annual',
    })).toThrow();
  });

  it('rejects a benefit with an invalid reset_cadence', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    expect(() => benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Bad', category: 'other', reset_cadence: 'weekly' as any,
    })).toThrow();
  });

  it('rejects a benefit with an empty title', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    expect(() => benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: '  ', category: 'other', reset_cadence: 'annual',
    })).toThrow(/title/i);
  });
});

describe('Usage validation', () => {
  it('rejects a usage without a benefit_id', () => {
    const db = seededDb();
    expect(() => usageCreate(db, { benefit_id: 0 as any, used_on: '2026-01-01', amount_usd: 10 })).toThrow();
  });
  it('rejects a usage with an invalid date', () => {
    const db = seededDb();
    const b = benefitsGetAll(db)[0];
    expect(() => usageCreate(db, { benefit_id: b.id, used_on: 'not-a-date', amount_usd: 10 })).toThrow(/date/i);
  });
  it('accepts a usage with a null amount', () => {
    const db = seededDb();
    const b = benefitsGetAll(db)[0];
    const u = usageCreate(db, { benefit_id: b.id, used_on: '2026-06-15', amount_usd: null });
    expect(u.amount_usd).toBeNull();
    expect(u.period_key).toBeDefined();
  });
});

describe('Refresh flow validation', () => {
  it('rejects a refresh run with no changes', () => {
    const db = seededDb();
    expect(() => refreshStartRun(db, 'test', [])).toThrow(/change/i);
  });
  it('reports null last_run_at on a fresh install', () => {
    const db = seededDb();
    const s = refreshGetStatus(db);
    expect(s.last_run_at).toBeNull();
    expect(typeof s.next_due).toBe('string');
  });
});

describe('Points currency validation (v1.0.16)', () => {
  it('rejects a points currency without a name', () => {
    const db = seededDb();
    expect(() => pointsCurrencyCreate(db, { name: '  ', currency_type: 'airline', value_cents_per_point: 1.5 })).toThrow(/name/i);
  });
  it('enforces the currency_type CHECK constraint', () => {
    const db = seededDb();
    expect(() => pointsCurrencyCreate(db, { name: 'X', currency_type: 'crypto' as any, value_cents_per_point: 1 })).toThrow();
  });
  it('rejects a points currency with a non-numeric value', () => {
    const db = seededDb();
    expect(() => pointsCurrencyCreate(db, { name: 'X', currency_type: 'airline', value_cents_per_point: NaN })).toThrow(/value_cents_per_point/i);
  });
  it('throws when updating a non-existent points currency', () => {
    const db = seededDb();
    expect(() => pointsCurrencyUpdate(db, 'nope', { value_cents_per_point: 2 })).toThrow(/not found/i);
  });
  it('seeds all 10 relevant points currencies on a fresh install', () => {
    const db = seededDb();
    const all = pointsCurrenciesGetAll(db);
    expect(all.length).toBe(10);
    const amex = all.find(c => c.id === 'amex_membership_rewards');
    expect(amex).toBeDefined();
    expect(amex!.value_cents_per_point).toBe(1.7);
    expect(amex!.currency_type).toBe('transferable');
    expect(amex!.source_name).toBe('One Mile at a Time');
    expect(amex!.source_url).toBe('https://onemileatatime.com/guides/value-miles-points/');
  });
});
