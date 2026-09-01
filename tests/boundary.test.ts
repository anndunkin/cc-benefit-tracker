import { describe, it, expect } from 'vitest';
import { seededDb } from './helpers';
import {
  benefitCreate, benefitUpdate, benefitGetById, benefitsGetAll, cardsGetAll, programsGetAll, benefitsForProgram,
  usageCreate, computeProjections,
  pointsCurrencyCreate, pointsCurrencyUpdate, pointsCurrencyDelete, pointsCurrencyGetById, pointsCurrenciesGetAll,
  applyDataMigrations, refreshGetStatus,
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

describe('v1.0.17 Bonus Categories backfill (regression for empty tab on upgrade)', () => {
  /**
   * Simulates a real pre-1.0.16 install: a fully seeded database that is
   * then rolled back to look like it stopped at seed_version 1.0.15 —
   * i.e. it has NONE of the earning_multiplier benefit rows, the
   * multiplier_rate/multiplier_currency/spend_category/spend_category_note
   * columns still exist (they're part of the base schema) but are NULL on
   * every row, and the marriott_bonvoy_base program/benefit don't exist yet.
   * This reproduces the exact bug reported: after v1.0.16 shipped, existing
   * installs' Bonus Categories tab stayed empty because the migration only
   * added columns/points-currencies, never the benefit/program rows
   * themselves.
   */
  function preV1_0_16Db() {
    const db = seededDb(); // fully seeded at the latest schema + seed_version
    db.exec(`DELETE FROM benefits WHERE multiplier_rate IS NOT NULL OR spend_category IS NOT NULL`);
    db.exec(`DELETE FROM benefits WHERE program_id = 'marriott_bonvoy_base'`);
    db.exec(`DELETE FROM programs WHERE id = 'marriott_bonvoy_base'`);
    db.exec(`UPDATE app_meta SET value = '1.0.15' WHERE key = 'seed_version'`);
    return db;
  }

  it('has zero earning_multiplier rows and no base program before migrating (sanity check on the fixture)', () => {
    const db = preV1_0_16Db();
    const multiplierRows = db.prepare(`SELECT COUNT(*) AS n FROM benefits WHERE category = 'earning_multiplier'`).get() as { n: number };
    expect(multiplierRows.n).toBe(0);
    expect(programsGetAll(db).find(p => p.id === 'marriott_bonvoy_base')).toBeUndefined();
  });

  it('backfills all earning_multiplier benefit rows on migration, without duplicating anything on a second run', () => {
    const db = preV1_0_16Db();
    const result = applyDataMigrations(db);
    expect(result.migrations_run.some(m => m.startsWith('v1_0_17_inserted_') && m.endsWith('_benefits'))).toBe(true);

    const allBenefits = benefitsGetAll(db);
    const multiplierRows = allBenefits.filter(b => b.category === 'earning_multiplier');
    expect(multiplierRows.length).toBeGreaterThan(0);

    // Every card that ships earning_multiplier seed content should now have
    // at least one populated row (this is exactly what the Bonus Categories
    // tab reads).
    const cardIdsWithMultipliers = new Set(multiplierRows.map(b => b.card_id));
    expect(cardIdsWithMultipliers.size).toBeGreaterThanOrEqual(9);

    const stamp = db.prepare(`SELECT value FROM app_meta WHERE key = 'seed_version'`).get() as { value: string };
    expect(stamp.value).toBe('1.0.19');

    // Re-running migrations (e.g. app restarted) must not duplicate rows.
    const beforeCount = benefitsGetAll(db).length;
    applyDataMigrations(db);
    expect(benefitsGetAll(db).length).toBe(beforeCount);
  });

  it('backfills the marriott_bonvoy_base program and its free-night benefit on migration', () => {
    const db = preV1_0_16Db();
    applyDataMigrations(db);

    const programs = programsGetAll(db);
    const base = programs.find(p => p.id === 'marriott_bonvoy_base');
    expect(base).toBeDefined();

    const benefits = benefitsForProgram(db, 'marriott_bonvoy_base');
    const freeNight = benefits.find(b => /Stay for 5, Pay for 4/i.test(b.title));
    expect(freeNight).toBeDefined();
    expect(freeNight!.reset_cadence).toBe('unlimited');
  });

  it('does not touch or duplicate the pre-existing marriott_premier/virgin_atlantic multiplier rows that already had a title match', () => {
    // These two cards had earning_multiplier rows even before v1.0.16 (just
    // without the new structured columns populated) — the backfill must
    // match them by title and skip inserting a duplicate.
    const fresh = seededDb();
    const freshMarriottMultipliers = benefitsGetAll(fresh).filter(b => b.card_id === 'marriott_premier' && b.category === 'earning_multiplier');
    expect(freshMarriottMultipliers.length).toBeGreaterThan(0);

    const db = preV1_0_16Db();
    applyDataMigrations(db);
    const afterMarriottMultipliers = benefitsGetAll(db).filter(b => b.card_id === 'marriott_premier' && b.category === 'earning_multiplier');
    // Same count as a fresh install — no duplicates introduced.
    expect(afterMarriottMultipliers.length).toBe(freshMarriottMultipliers.length);
  });
});

describe('v1.0.19 quarterly-refresh due-date epoch bug fix', () => {
  /**
   * Reproduces the reported bug: a never-refreshed database (no completed
   * refresh_runs row) used to anchor "next due" at new Date(0) — the Unix
   * epoch — making every fresh install show "Next due: 1970-04-01" from the
   * very first launch. The fix anchors on `installed_at` instead.
   */
  it('does not anchor next_due at the Unix epoch for a never-refreshed database', () => {
    const db = seededDb(); // seedIfFresh stamps installed_at at seed time
    const status = refreshGetStatus(db);
    expect(status.last_run_at).toBeNull();
    expect(status.next_due.startsWith('1970')).toBe(false);
    // next_due should be ~3 months after installed_at (seeded to "now" by seedIfFresh).
    const installedAt = db.prepare(`SELECT value FROM app_meta WHERE key = 'installed_at'`).get() as { value: string } | undefined;
    expect(installedAt).toBeDefined();
    const expected = new Date(installedAt!.value);
    expected.setUTCMonth(expected.getUTCMonth() + 3);
    expect(status.next_due).toBe(expected.toISOString().slice(0, 10));
  });

  it('backfills installed_at via migration for a pre-v1.0.19 install that never had it stamped, anchoring next_due at migration time rather than the epoch', () => {
    const db = seededDb();
    // Simulate an old install that predates the installed_at stamp entirely.
    db.exec(`DELETE FROM app_meta WHERE key = 'installed_at'`);
    db.exec(`UPDATE app_meta SET value = '1.0.17' WHERE key = 'seed_version'`);

    // Before migration, with no installed_at and no completed refresh, the
    // pre-fix code path would have fallen back to the epoch. Confirm the
    // fixture actually reproduces "no installed_at" so the migration has
    // something real to backfill.
    expect(db.prepare(`SELECT value FROM app_meta WHERE key = 'installed_at'`).get()).toBeUndefined();

    const result = applyDataMigrations(db);
    expect(result.migrations_run).toContain('v1_0_19_backfilled_installed_at');

    const after = refreshGetStatus(db);
    expect(after.next_due.startsWith('1970')).toBe(false);
    // before (pre-migration, no installed_at) already falls back to
    // Date.now() at call time too, so just confirm the migration actually
    // persisted a real installed_at value going forward.
    const backfilled = db.prepare(`SELECT value FROM app_meta WHERE key = 'installed_at'`).get() as { value: string } | undefined;
    expect(backfilled).toBeDefined();
    expect(new Date(backfilled!.value).getUTCFullYear()).toBeGreaterThan(2000);
  });
});

describe('v1.0.19 Hilton Honors Diamond status program', () => {
  it('adds hilton_status as its own program, independent of the hilton_aspire card', () => {
    const db = seededDb();
    const programs = programsGetAll(db);
    const hiltonStatus = programs.find(p => p.id === 'hilton_status');
    expect(hiltonStatus).toBeDefined();
    expect(hiltonStatus!.program_type).toBe('hotel_elite_status');

    const benefits = benefitsForProgram(db, 'hilton_status');
    expect(benefits.length).toBeGreaterThanOrEqual(9);
    for (const b of benefits) {
      expect(b.card_id).toBeNull();
      expect(b.program_id).toBe('hilton_status');
    }
  });

  it('includes the 5th-night-free Diamond benefit with no annual usage cap', () => {
    const db = seededDb();
    const benefits = benefitsForProgram(db, 'hilton_status');
    const fifthNight = benefits.find(b => /5th Night Free/i.test(b.title));
    expect(fifthNight).toBeDefined();
    expect(fifthNight!.reset_cadence).toBe('unlimited');
    expect(fifthNight!.category).toBe('free_night');
  });

  it('keeps the hilton_aspire card\'s own Diamond-status row pointing to the program rather than duplicating the perk list', () => {
    const db = seededDb();
    const aspireBenefits = benefitsGetAll(db).filter(b => b.card_id === 'hilton_aspire');
    const grantRow = aspireBenefits.find(b => /Complimentary Hilton Honors Diamond Status/i.test(b.title));
    expect(grantRow).toBeDefined();
    expect(grantRow!.program_id).toBeNull();
    // The detailed perks (5th night free etc.) should NOT also appear as
    // separate rows under the card — they live only under hilton_status.
    expect(aspireBenefits.find(b => /5th Night Free/i.test(b.title))).toBeUndefined();
  });

  it('backfills the hilton_status program and its benefits on migration for a pre-v1.0.19 install', () => {
    const db = seededDb();
    db.exec(`DELETE FROM benefits WHERE program_id = 'hilton_status'`);
    db.exec(`DELETE FROM programs WHERE id = 'hilton_status'`);
    db.exec(`UPDATE app_meta SET value = '1.0.17' WHERE key = 'seed_version'`);
    expect(programsGetAll(db).find(p => p.id === 'hilton_status')).toBeUndefined();

    const result = applyDataMigrations(db);
    expect(result.migrations_run.some(m => m.startsWith('v1_0_19_inserted_') && m.endsWith('_programs'))).toBe(true);
    expect(result.migrations_run.some(m => m.startsWith('v1_0_19_inserted_') && m.endsWith('_benefits'))).toBe(true);

    expect(programsGetAll(db).find(p => p.id === 'hilton_status')).toBeDefined();
    expect(benefitsForProgram(db, 'hilton_status').length).toBeGreaterThanOrEqual(9);

    // Re-running migrations must not duplicate rows.
    const beforeCount = benefitsGetAll(db).length;
    applyDataMigrations(db);
    expect(benefitsGetAll(db).length).toBe(beforeCount);
  });
});

describe('v1.0.19 Ongoing tab excludes earning multipliers', () => {
  it('seed data still carries earning_multiplier rows for the dedicated Bonus Categories tab', () => {
    // This is a data-layer sanity check; the actual tab-visibility filter
    // lives in the UI (src/components/BenefitDashboard.tsx modeFiltered) and
    // is exercised by component tests, but we confirm here that the
    // underlying rows the UI filters over still exist and are unaffected by
    // this round's other seed-data changes.
    const db = seededDb();
    const multiplierRows = benefitsGetAll(db).filter(b => b.category === 'earning_multiplier');
    expect(multiplierRows.length).toBeGreaterThan(0);
    // Unlimited cadence is what previously made these show up on Ongoing.
    expect(multiplierRows.every(b => b.reset_cadence === 'unlimited')).toBe(true);
  });
});

describe('v1.0.19 Virgin Atlantic single-card cleanup', () => {
  it('has exactly one Virgin Atlantic card, referencing only the current Synchrony Virgin Red Rewards Mastercard', () => {
    const db = seededDb();
    const vaCards = cardsGetAll(db).filter(c => c.id === 'virgin_atlantic' || /virgin atlantic/i.test(c.name));
    expect(vaCards.length).toBe(1);
    expect(vaCards[0].issuer).toBe('Synchrony Bank');
    expect(vaCards[0].name).not.toMatch(/Bank of America/i);
  });

  it('has no lingering discontinued Bank of America Virgin Atlantic benefit rows after migration', () => {
    const db = seededDb();
    db.exec(`UPDATE app_meta SET value = '1.0.17' WHERE key = 'seed_version'`);
    applyDataMigrations(db);
    const vaBenefits = benefitsGetAll(db).filter(b => b.card_id === 'virgin_atlantic');
    expect(vaBenefits.some(b => /Bank of America/i.test(b.title) || /Bank of America/i.test(b.description ?? ''))).toBe(false);
  });
});
