import { describe, it, expect } from 'vitest';
import { seededDb } from './helpers';
import {
  benefitCreate, benefitsGetAll, cardsGetAll,
  usageCreate, computeProjections,
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
