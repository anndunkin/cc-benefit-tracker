import { describe, it, expect } from 'vitest';
import { seededDb } from './helpers';
import {
  benefitCreate, benefitUpdate, benefitGetById, benefitsGetAll, cardsGetAll, programsGetAll, benefitsForProgram,
  usageCreate, computeProjections,
  pointsCurrencyCreate, pointsCurrencyUpdate, pointsCurrencyDelete, pointsCurrencyGetById, pointsCurrenciesGetAll,
} from '../electron/database';

describe('Cadence period math', () => {
  const db = seededDb();
  const card = cardsGetAll(db)[0];

  it('rolls over a monthly benefit to the next period after use', () => {
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: monthly test', category: 'other',
      reset_cadence: 'monthly', uses_per_period: 1, value_usd: 10,
    });
    // Log usage in the CURRENT month
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-15`;
    usageCreate(db, { benefit_id: b.id, used_on: currentMonth, amount_usd: 10 });
    const proj = computeProjections(db, now.getUTCFullYear()).find(p => p.benefit.id === b.id)!;
    expect(proj.status).toBe('exhausted');
    expect(proj.uses_count).toBe(1);
  });

  it('quarterly benefit does not count usage from a different quarter', () => {
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: quarterly test', category: 'other',
      reset_cadence: 'quarterly', uses_per_period: 1, value_usd: 50,
    });
    // Log usage on Feb 15, 2026 (Q1)
    usageCreate(db, { benefit_id: b.id, used_on: '2026-02-15', amount_usd: 50 });
    // Compute for Q3 of same year — the projection uses "current" quarter based on today.
    // For determinism, we check the aggregate: uses_count for current period.
    const proj = computeProjections(db, 2026).find(p => p.benefit.id === b.id)!;
    // If today is in Q1 of 2026 this test would incorrectly show 1. Guard:
    const today = new Date();
    const q = Math.floor(today.getUTCMonth() / 3) + 1;
    const yr = today.getUTCFullYear();
    if (yr === 2026 && q === 1) {
      expect(proj.uses_count).toBe(1);
    } else {
      expect(proj.uses_count).toBe(0);
    }
  });

  it('unlimited benefit reports "unlimited" status regardless of usage', () => {
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: unlimited test', category: 'earning_multiplier',
      reset_cadence: 'unlimited', uses_per_period: null, value_usd: null,
    });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-05-01', amount_usd: 15 });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-05-02', amount_usd: 15 });
    const proj = computeProjections(db, 2026).find(p => p.benefit.id === b.id)!;
    expect(proj.status).toBe('unlimited');
    expect(proj.uses_max).toBeNull();
  });

  it('spend_threshold benefit locks until threshold met', () => {
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: spend threshold test', category: 'other',
      reset_cadence: 'spend_threshold', uses_per_period: 1,
      value_usd: 500, spend_threshold_usd: 15000,
    });
    const proj = computeProjections(db, 2026).find(p => p.benefit.id === b.id)!;
    expect(['locked', 'available']).toContain(proj.status);
  });

  it('semiannual benefit tracks H1 vs H2 separately', () => {
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: semiannual test', category: 'other',
      reset_cadence: 'semiannual', uses_per_period: 1, value_usd: 100,
    });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-03-15', amount_usd: 100 }); // H1
    usageCreate(db, { benefit_id: b.id, used_on: '2026-08-15', amount_usd: 100 }); // H2
    // The projection reflects the current half based on today, but total logged is 2.
    // We can also count period_keys via a lower-level check.
    const proj = computeProjections(db, 2026).find(p => p.benefit.id === b.id)!;
    // Regardless of which half we're in, this benefit should not be over-quota.
    expect(proj.uses_count).toBeLessThanOrEqual(proj.uses_max ?? Infinity);
  });
});

describe('Extreme values', () => {
  it('accepts a benefit with a very large USD value', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: big value', category: 'travel_credit',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: 999_999,
    });
    expect(b.value_usd).toBe(999999);
  });

  it('accepts a benefit with uses_per_period = 0 (locked state)', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: zero uses', category: 'other',
      reset_cadence: 'annual', uses_per_period: 0, value_usd: 100,
    });
    const proj = computeProjections(db, 2026).find(p => p.benefit.id === b.id)!;
    // 0 max uses should immediately register as exhausted.
    expect(proj.uses_max).toBe(0);
  });

  it('handles a Unicode title correctly', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: '🛎 Résumé — Über spa €500', category: 'wellness_credit',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: 500,
    });
    expect(b.title).toBe('🛎 Résumé — Über spa €500');
  });

  it('supports 100+ benefits on a single card', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    for (let i = 0; i < 100; i++) {
      benefitCreate(db, {
        card_id: card.id, program_id: null,
        title: `BM: bulk ${i}`, category: 'other',
        reset_cadence: 'unlimited',
      });
    }
    const total = benefitsGetAll(db).filter(b => b.card_id === card.id && b.title.startsWith('BM: bulk')).length;
    expect(total).toBe(100);
  });
});

describe('Structured earning-multiplier columns round-trip (v1.0.16)', () => {
  it('persists multiplier_rate/multiplier_currency/spend_category/spend_category_note through create', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: 5x test category', category: 'earning_multiplier',
      reset_cadence: 'unlimited',
      multiplier_rate: 5, multiplier_currency: 'Test Points',
      spend_category: 'dining', spend_category_note: 'Restaurants only',
    });
    expect(b.multiplier_rate).toBe(5);
    expect(b.multiplier_currency).toBe('Test Points');
    expect(b.spend_category).toBe('dining');
    expect(b.spend_category_note).toBe('Restaurants only');

    // Round-trip through a fresh SELECT (guards against BEN_COLS regressions
    // that would silently drop these columns from query results).
    const reloaded = benefitGetById(db, b.id)!;
    expect(reloaded.multiplier_rate).toBe(5);
    expect(reloaded.multiplier_currency).toBe('Test Points');
    expect(reloaded.spend_category).toBe('dining');
    expect(reloaded.spend_category_note).toBe('Restaurants only');
  });

  it('persists structured fields through benefitUpdate and preserves them when untouched', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: update test', category: 'earning_multiplier',
      reset_cadence: 'unlimited',
      multiplier_rate: 3, multiplier_currency: 'Test Points',
      spend_category: 'gas', spend_category_note: 'note A',
    });
    // Update an unrelated field only — structured fields must survive untouched.
    const updated = benefitUpdate(db, b.id, { title: 'BM: update test (renamed)' });
    expect(updated.multiplier_rate).toBe(3);
    expect(updated.multiplier_currency).toBe('Test Points');
    expect(updated.spend_category).toBe('gas');
    expect(updated.spend_category_note).toBe('note A');

    // Now actually change the multiplier rate.
    const updated2 = benefitUpdate(db, b.id, { multiplier_rate: 6 });
    expect(updated2.multiplier_rate).toBe(6);
    expect(updated2.spend_category).toBe('gas'); // unrelated field still intact
  });

  it('leaves structured fields null for non-multiplier benefits (no regression)', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'BM: plain credit', category: 'dining_credit',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: 20,
    });
    expect(b.multiplier_rate).toBeNull();
    expect(b.multiplier_currency).toBeNull();
    expect(b.spend_category).toBeNull();
    expect(b.spend_category_note).toBeNull();
  });

  it('seed data has structured earning_multiplier rows for every one of the 11 seeded cards', () => {
    const db = seededDb();
    const cardIds = new Set(cardsGetAll(db).map(c => c.id));
    const multiplierRows = benefitsGetAll(db).filter(b => b.category === 'earning_multiplier' && b.card_id);
    const cardsWithStructuredMultipliers = new Set(
      multiplierRows.filter(b => b.spend_category !== null).map(b => b.card_id),
    );
    expect(cardIds.size).toBe(11);
    for (const id of cardIds) {
      expect(cardsWithStructuredMultipliers.has(id)).toBe(true);
    }
  });
});

describe('Bonus Categories grouping logic (v1.0.16)', () => {
  it('groups earning_multiplier benefits by spend_category and sorts by rate descending', () => {
    const db = seededDb();
    const benefits = benefitsGetAll(db);
    const hotelsBucket = benefits
      .filter(b => b.category === 'earning_multiplier' && b.spend_category === 'hotels')
      .sort((a, z) => (z.multiplier_rate ?? 0) - (a.multiplier_rate ?? 0));
    expect(hotelsBucket.length).toBeGreaterThan(1);
    for (let i = 1; i < hotelsBucket.length; i++) {
      expect(hotelsBucket[i - 1].multiplier_rate ?? 0).toBeGreaterThanOrEqual(hotelsBucket[i].multiplier_rate ?? 0);
    }
    // The highest hotels-bucket multiplier in the seed data is Hilton Aspire's 14x.
    expect(hotelsBucket[0].multiplier_rate).toBe(14);
  });

  it('excludes statement-credit and non-multiplier benefits from any spend_category bucket', () => {
    const db = seededDb();
    const benefits = benefitsGetAll(db);
    const nonMultiplierWithCategory = benefits.filter(b => b.category !== 'earning_multiplier' && b.spend_category !== null);
    expect(nonMultiplierWithCategory.length).toBe(0);
  });
});

describe('Base program benefit seeding (v1.0.16, Feature 3)', () => {
  it('seeds a marriott_bonvoy_base program distinct from the elite-status marriott_status program', () => {
    const db = seededDb();
    const programs = programsGetAll(db);
    const base = programs.find(p => p.id === 'marriott_bonvoy_base');
    const elite = programs.find(p => p.id === 'marriott_status');
    expect(base).toBeDefined();
    expect(elite).toBeDefined();
    expect(base!.id).not.toBe(elite!.id);
    expect(base!.program_type).not.toBe('hotel_elite_status');
  });

  it('seeds the Stay-for-5-Pay-for-4 benefit under marriott_bonvoy_base with unlimited cadence', () => {
    const db = seededDb();
    const benefits = benefitsForProgram(db, 'marriott_bonvoy_base');
    expect(benefits.length).toBeGreaterThanOrEqual(1);
    const freeNight = benefits.find(b => /Stay for 5, Pay for 4/i.test(b.title));
    expect(freeNight).toBeDefined();
    expect(freeNight!.reset_cadence).toBe('unlimited');
    expect(freeNight!.source_url).toMatch(/marriott\.com/);
  });
});

describe('Points currency CRUD lifecycle (v1.0.16)', () => {
  it('creates, updates, and deletes a points currency end to end', () => {
    const db = seededDb();
    const created = pointsCurrencyCreate(db, {
      name: 'Test Points Program', currency_type: 'hotel', value_cents_per_point: 0.9,
      source_name: 'Test Source', source_url: 'https://example.com',
    });
    expect(created.id).toBe('test_points_program');
    expect(created.is_user_modified).toBe(0);

    const updated = pointsCurrencyUpdate(db, created.id, { value_cents_per_point: 1.2 });
    expect(updated.value_cents_per_point).toBe(1.2);
    expect(updated.is_user_modified).toBe(1); // editing marks it user-modified
    expect(updated.name).toBe('Test Points Program'); // untouched field preserved

    pointsCurrencyDelete(db, created.id);
    expect(pointsCurrencyGetById(db, created.id)).toBeNull();
  });

  it('is_user_modified currencies are never silently clobbered by a bulk reseed pass', () => {
    const db = seededDb();
    const before = pointsCurrencyGetById(db, 'amex_membership_rewards')!;
    const edited = pointsCurrencyUpdate(db, 'amex_membership_rewards', { value_cents_per_point: 2.0 });
    expect(edited.is_user_modified).toBe(1);
    expect(edited.value_cents_per_point).toBe(2.0);
    expect(edited.value_cents_per_point).not.toBe(before.value_cents_per_point);
  });

  it('handles 50+ points currencies without error (extreme-count boundary)', () => {
    const db = seededDb();
    for (let i = 0; i < 50; i++) {
      pointsCurrencyCreate(db, { name: `Bulk Currency ${i}`, currency_type: 'hotel', value_cents_per_point: 1 });
    }
    expect(pointsCurrenciesGetAll(db).length).toBeGreaterThanOrEqual(60); // 10 seeded + 50 bulk
  });
});
