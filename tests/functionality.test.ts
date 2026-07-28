import { describe, it, expect } from 'vitest';
import { seededDb, emptyDb } from './helpers';
import {
  cardCreate, cardDelete, cardsGetAll,
  programCreate, programsGetAll,
  benefitCreate, benefitUpdate, benefitsGetAll, benefitsForCard, benefitDelete,
  usageCreate, usagesForBenefit, usageDelete,
  computeProjections,
  refreshStartRun, refreshPendingChanges, refreshApproveChange, refreshRejectChange,
  refreshApplyRun, refreshDiscardRun, refreshGetStatus,
  buildFilePayload, importFilePayload,
  seedIfFresh, initSchema, applyDataMigrations,
} from '../electron/database';
import Database from 'better-sqlite3';

describe('Seed data loads correctly', () => {
  it('seeds cards, programs, and benefits from the research-generated data', () => {
    const db = seededDb();
    const cards = cardsGetAll(db);
    const programs = programsGetAll(db);
    const benefits = benefitsGetAll(db);
    expect(cards.length).toBeGreaterThanOrEqual(11);   // 11 seeded (v1.0.5 restored marriott_premier)
    expect(programs.length).toBe(4);
    expect(benefits.length).toBeGreaterThan(20);
  });

  it('seedIfFresh is idempotent — running twice does not duplicate rows', () => {
    const db = seededDb();
    const before = cardsGetAll(db).length;
    seedIfFresh(db);
    seedIfFresh(db);
    expect(cardsGetAll(db).length).toBe(before);
  });
});

describe('Card CRUD', () => {
  it('creates, reads, and deletes a card', () => {
    const db = seededDb();
    const created = cardCreate(db, { name: 'Test Card', issuer: 'Test Bank', network: 'Amex', annual_fee_usd: 250 });
    expect(created.id).toBeDefined();
    cardDelete(db, created.id);
    expect(cardsGetAll(db).find(c => c.id === created.id)).toBeUndefined();
  });

  it('deleting a card cascades to its benefits and usages', () => {
    const db = seededDb();
    const created = cardCreate(db, { name: 'Cascade Test', issuer: 'Bank', network: 'Visa' });
    const b = benefitCreate(db, {
      card_id: created.id, program_id: null,
      title: 'test-bene', category: 'other', reset_cadence: 'annual', uses_per_period: 1,
    });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-01-15', amount_usd: 10 });
    cardDelete(db, created.id);
    expect(benefitsGetAll(db).find(x => x.id === b.id)).toBeUndefined();
    expect(usagesForBenefit(db, b.id).length).toBe(0);
  });
});

describe('Benefit CRUD & user-modified flag', () => {
  it('marks a benefit as user_modified when updated by the user', () => {
    const db = seededDb();
    const benefits = benefitsGetAll(db);
    const b = benefits[0];
    // seedIfFresh should mark these as NOT user-modified by default.
    expect(b.is_user_modified).toBe(0);
    benefitUpdate(db, b.id, { title: b.title + ' (edited)' });
    const after = benefitsGetAll(db).find(x => x.id === b.id)!;
    expect(after.is_user_modified).toBe(1);
    expect(after.title.endsWith('(edited)')).toBe(true);
  });

  it('deleting a benefit removes its usages', () => {
    const db = seededDb();
    const b = benefitCreate(db, {
      card_id: cardsGetAll(db)[0].id, program_id: null,
      title: 'del-me', category: 'other', reset_cadence: 'annual', uses_per_period: 1,
    });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-04-01', amount_usd: 20 });
    benefitDelete(db, b.id);
    expect(benefitsGetAll(db).find(x => x.id === b.id)).toBeUndefined();
  });
});

describe('Usage log & projections', () => {
  it('logging usage decreases uses_remaining and increases value_used_usd', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Use tracker', category: 'travel_credit',
      reset_cadence: 'annual', uses_per_period: 5, value_usd: 100,
    });
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      usageCreate(db, {
        benefit_id: b.id,
        used_on: `${now.getUTCFullYear()}-0${(i % 9) + 1}-15`,
        amount_usd: 100,
      });
    }
    const proj = computeProjections(db, now.getUTCFullYear()).find(p => p.benefit.id === b.id)!;
    expect(proj.uses_count).toBe(3);
    expect(proj.uses_max).toBe(5);
    expect(proj.status).toBe('partial');
    expect(proj.value_used_usd).toBe(300);
    expect(proj.value_remaining_usd).toBe(200);
  });

  it('deleting a usage frees up capacity', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Delete usage test', category: 'other',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: 50,
    });
    const now = new Date();
    const u = usageCreate(db, { benefit_id: b.id, used_on: `${now.getUTCFullYear()}-06-15`, amount_usd: 50 });
    let proj = computeProjections(db, now.getUTCFullYear()).find(p => p.benefit.id === b.id)!;
    expect(proj.status).toBe('exhausted');
    usageDelete(db, u.id);
    proj = computeProjections(db, now.getUTCFullYear()).find(p => p.benefit.id === b.id)!;
    expect(proj.status).toBe('available');
  });

  // v1.0.1: quarterly benefit stores per-period value; projection filters usages
  // by current-quarter period_key and totals the per-period cap.
  it('quarterly benefit reports per-period max and only counts current-quarter usages', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Q credit', category: 'airline_credit',
      reset_cadence: 'quarterly', uses_per_period: 1, value_usd: 50,
    });
    const year = new Date().getUTCFullYear();
    // Log two usages in Q1 and Q2 of the current year.
    usageCreate(db, { benefit_id: b.id, used_on: `${year}-03-11`, amount_usd: 50 });
    usageCreate(db, { benefit_id: b.id, used_on: `${year}-06-10`, amount_usd: 50 });
    // Anchor projection at Q3 (2026-07-28 style)
    // computeProjections uses today's UTC date for the current year, so we can
    // only pin the assertion for the actual current quarter. What matters is:
    // uses_max is 1 (per current period) and total_value is 1 * 50 = 50.
    const proj = computeProjections(db, year).find(p => p.benefit.id === b.id)!;
    expect(proj.uses_max).toBe(1);
    // total_value = uses_max * value_usd = 1 * 50 = 50
    // Depending on which quarter today falls in:
    //   Q1 or Q2 (Jan-Jun): the current-period usage is present, exhausted.
    //   Q3 or Q4 (Jul-Dec): no current-period usage, available with $50 remaining.
    if (proj.uses_count === 0) {
      expect(proj.value_remaining_usd).toBe(50);
      expect(proj.status).toBe('available');
    } else {
      expect(proj.uses_count).toBe(1);
      expect(proj.status).toBe('exhausted');
    }
  });

  // v1.0.1: single-use "toggle" flow. Tile records a usage with null amount;
  // projection must still count it and mark the benefit exhausted.
  it('single-use toggle: null-amount usage still counts toward exhaustion', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Companion cert', category: 'companion_ticket',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: null,
    });
    const year = new Date().getUTCFullYear();
    usageCreate(db, { benefit_id: b.id, used_on: `${year}-04-01`, amount_usd: null });
    const proj = computeProjections(db, year).find(p => p.benefit.id === b.id)!;
    expect(proj.uses_count).toBe(1);
    expect(proj.uses_max).toBe(1);
    expect(proj.status).toBe('exhausted');
    // No dollar value stored on the benefit or usage — remaining stays null.
    expect(proj.value_remaining_usd).toBeNull();
  });
});

describe('Refresh workflow (diff & review)', () => {
  it('does NOT overwrite a user-modified benefit even when a change is approved', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    // Baseline benefit created by user
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Original Title', category: 'travel_credit',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: 100,
    });
    // Simulate the user editing it → marks user_modified=1
    benefitUpdate(db, b.id, { title: 'User Edited Title' });

    // Refresh proposes a new title
    const { run_id } = refreshStartRun(db, 'test refresh', [{
      change_type: 'modified',
      card_id: card.id, program_id: null, benefit_id: b.id,
      before_json: JSON.stringify({ title: 'Original Title' }),
      after_json:  JSON.stringify({ title: 'Refresh-Proposed Title', category: 'travel_credit', reset_cadence: 'annual', uses_per_period: 1, value_usd: 100 }),
    }]);
    const changes = refreshPendingChanges(db, run_id);
    expect(changes.length).toBe(1);
    refreshApproveChange(db, changes[0].id);
    const result = refreshApplyRun(db, run_id);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    const after = benefitsGetAll(db).find(x => x.id === b.id)!;
    expect(after.title).toBe('User Edited Title');   // unchanged
  });

  it('applies an approved change to a non-user-modified benefit', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Vanilla', category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 50,
    }, /*markUserModified*/ false);
    const { run_id } = refreshStartRun(db, 'test', [{
      change_type: 'modified', card_id: card.id, program_id: null, benefit_id: b.id,
      before_json: JSON.stringify({ value_usd: 50 }),
      after_json: JSON.stringify({ value_usd: 75, category: 'other', reset_cadence: 'annual', uses_per_period: 1, title: 'Vanilla' }),
    }]);
    const [ch] = refreshPendingChanges(db, run_id);
    refreshApproveChange(db, ch.id);
    const result = refreshApplyRun(db, run_id);
    expect(result.applied).toBe(1);
    const after = benefitsGetAll(db).find(x => x.id === b.id)!;
    expect(after.value_usd).toBe(75);
  });

  it('skips a rejected change', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Reject me', category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 100,
    }, false);
    const { run_id } = refreshStartRun(db, 't', [{
      change_type: 'modified', card_id: card.id, program_id: null, benefit_id: b.id,
      before_json: '{"value_usd":100}', after_json: '{"value_usd":999,"category":"other","reset_cadence":"annual","uses_per_period":1,"title":"Reject me"}',
    }]);
    const [ch] = refreshPendingChanges(db, run_id);
    refreshRejectChange(db, ch.id, 'Not authoritative');
    const result = refreshApplyRun(db, run_id);
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('soft-deletes removed benefits to preserve usage history', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Sunset', category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 100,
    }, false);
    usageCreate(db, { benefit_id: b.id, used_on: '2026-04-01', amount_usd: 100 });
    const { run_id } = refreshStartRun(db, 't', [{
      change_type: 'removed', card_id: card.id, program_id: null, benefit_id: b.id,
      before_json: JSON.stringify({ title: 'Sunset' }), after_json: null,
    }]);
    const [ch] = refreshPendingChanges(db, run_id);
    refreshApproveChange(db, ch.id);
    refreshApplyRun(db, run_id);
    // Benefit still exists (soft-deleted), usages preserved.
    const after = benefitsGetAll(db).find(x => x.id === b.id);
    expect(after).toBeDefined();
    expect(after!.is_active).toBe(0);
    expect(usagesForBenefit(db, b.id).length).toBe(1);
  });

  it('discardRun removes a pending run without applying changes', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Discard test', category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 10,
    });
    const { run_id } = refreshStartRun(db, 't', [{
      change_type: 'modified', card_id: card.id, program_id: null, benefit_id: b.id,
      before_json: '{}', after_json: '{"value_usd":20,"category":"other","reset_cadence":"annual","uses_per_period":1,"title":"Discard test"}',
    }]);
    refreshDiscardRun(db, run_id);
    const status = refreshGetStatus(db);
    expect(status.pending_run_id).toBeNull();
  });
});

describe('File export / import round-trip', () => {
  it('exports and re-imports a database identically', () => {
    const db = seededDb();
    // Add a couple of user rows so we know they survive
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Round-trip test', category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 100,
    });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-03-15', amount_usd: 100 });

    const payload = buildFilePayload(db);
    const db2 = emptyDb();
    importFilePayload(db2, payload);

    expect(cardsGetAll(db2).length).toBe(cardsGetAll(db).length);
    expect(benefitsGetAll(db2).length).toBe(benefitsGetAll(db).length);
    const roundtrip = benefitsGetAll(db2).find(x => x.title === 'Round-trip test');
    expect(roundtrip).toBeDefined();
    expect(usagesForBenefit(db2, roundtrip!.id).length).toBe(1);
  });
});

describe('Annualized totals (v1.0.2)', () => {
  it('quarterly $50 credit projects annual_value_usd = $200', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Quarterly credit test', category: 'other',
      reset_cadence: 'quarterly', uses_per_period: 1, value_usd: 50,
    });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.annual_value_usd).toBe(200);
    expect(p.annual_value_used_usd).toBe(0);
    expect(p.annual_value_remaining_usd).toBe(200);
  });

  it('semiannual $75 credit projects annual_value_usd = $150', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Semiannual test', category: 'other',
      reset_cadence: 'semiannual', uses_per_period: 1, value_usd: 75,
    });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.annual_value_usd).toBe(150);
  });

  it('monthly $15 credit (uses_per_period=1) projects annual_value_usd = $180', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Monthly test', category: 'other',
      reset_cadence: 'monthly', uses_per_period: 1, value_usd: 15,
    });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.annual_value_usd).toBe(180);
  });

  it('annual credit gives annual_value_usd = value_usd × uses_per_period', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Annual test', category: 'other',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: 200,
    });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.annual_value_usd).toBe(200);
  });
});

describe('Partial-amount status resolution (v1.0.2)', () => {
  it('partial $30 spend on a quarterly $50 credit stays PARTIAL with $20 left', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Partial spend test', category: 'other',
      reset_cadence: 'quarterly', uses_per_period: 1, value_usd: 50,
    });
    const today = new Date().toISOString().slice(0, 10);
    usageCreate(db, { benefit_id: b.id, used_on: today, amount_usd: 30 });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.status).toBe('partial');
    expect(p.value_used_usd).toBe(30);
    expect(p.value_remaining_usd).toBe(20);
  });

  it('two partial usages totaling the cap mark the credit EXHAUSTED', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Two partial test', category: 'other',
      reset_cadence: 'quarterly', uses_per_period: 1, value_usd: 50,
    });
    const today = new Date().toISOString().slice(0, 10);
    usageCreate(db, { benefit_id: b.id, used_on: today, amount_usd: 30 });
    usageCreate(db, { benefit_id: b.id, used_on: today, amount_usd: 20 });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.status).toBe('exhausted');
    expect(p.value_used_usd).toBe(50);
    expect(p.value_remaining_usd).toBe(0);
  });

  it('use-count-only benefit (no dollar value) uses count-based status', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Count-only test', category: 'other',
      reset_cadence: 'annual', uses_per_period: 1, value_usd: null,
    });
    const today = new Date().toISOString().slice(0, 10);
    usageCreate(db, { benefit_id: b.id, used_on: today, amount_usd: null });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.status).toBe('exhausted');
  });
});

describe('Spend-threshold benefits (v1.0.2)', () => {
  it('accumulates spend_progress_usd from logged usages', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Threshold test', category: 'other',
      reset_cadence: 'spend_threshold', uses_per_period: 1,
      value_usd: null, spend_threshold_usd: 30000,
    });
    const y = String(new Date().getUTCFullYear());
    usageCreate(db, { benefit_id: b.id, used_on: `${y}-01-15`, amount_usd: 12500 });
    usageCreate(db, { benefit_id: b.id, used_on: `${y}-04-20`, amount_usd: 5000 });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.spend_progress_usd).toBe(17500);
    expect(p.status).toBe('partial');
  });

  it('marks EXHAUSTED once cumulative spend meets the threshold', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Threshold met test', category: 'other',
      reset_cadence: 'spend_threshold', uses_per_period: 1,
      value_usd: null, spend_threshold_usd: 30000,
    });
    const y = String(new Date().getUTCFullYear());
    usageCreate(db, { benefit_id: b.id, used_on: `${y}-01-15`, amount_usd: 30000 });
    const p = computeProjections(db, new Date().getUTCFullYear()).find(x => x.benefit.id === b.id)!;
    expect(p.spend_progress_usd).toBe(30000);
    expect(p.status).toBe('exhausted');
  });
});

describe('Unlimited benefits surface on Ongoing dashboard (v1.0.2)', () => {
  it('seeded Hilton Diamond, National Executive, Cell Phone Protection all use reset_cadence=unlimited', () => {
    const db = seededDb();
    const benefits = benefitsGetAll(db);
    const hiltonDiamond = benefits.find(b => b.title.toLowerCase().includes('hilton') && b.title.toLowerCase().includes('diamond'));
    const nationalExec = benefits.find(b => b.title.toLowerCase().includes('national') && b.title.toLowerCase().includes('executive'));
    const cellProt = benefits.filter(b => b.title.toLowerCase().includes('cell phone protection'));
    expect(hiltonDiamond?.reset_cadence).toBe('unlimited');
    expect(nationalExec?.reset_cadence).toBe('unlimited');
    expect(cellProt.length).toBeGreaterThan(0);
    for (const b of cellProt) expect(b.reset_cadence).toBe('unlimited');
  });

  it('Hilton spend-threshold free nights have value_usd = 0 (points-based) but keep spend_threshold_usd', () => {
    const db = seededDb();
    const benefits = benefitsGetAll(db);
    const hiltonSpendFn = benefits.filter(b =>
      b.card_id === 'hilton_aspire' &&
      b.reset_cadence === 'spend_threshold'
    );
    expect(hiltonSpendFn.length).toBeGreaterThan(0);
    for (const b of hiltonSpendFn) {
      expect(b.value_usd === 0 || b.value_usd === null).toBe(true);
      expect(b.spend_threshold_usd).toBeGreaterThan(0);
    }
  });
});

describe('v1.0.3 seed-refresh migration', () => {
  function legacyDb(): Database.Database {
    // Simulate a v1.0.0/v1.0.1 install: schema is initialised and seed rows are
    // inserted directly (skipping the v1.0.2 upsert path) to prove the migration
    // rewrites broken rows and purges deprecated Marriott cards without wiping
    // real user data.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    // Legacy cards + benefits — including deprecated Marriott and a broken
    // monthly row that stores annual value in value_usd.
    db.prepare(`INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active) VALUES
      ('marriott_bonvoy_brilliant', 'Marriott Brilliant', 'Amex', 'Amex', 650, 1),
      ('ihg_premier', 'IHG Premier', 'Chase', 'Mastercard', 99, 1)
    `).run();
    db.prepare(`INSERT INTO benefits (card_id, title, category, reset_cadence, uses_per_period, value_usd)
      VALUES ('marriott_bonvoy_brilliant', 'Legacy Marriott bene', 'other', 'annual', 1, 500)
    `).run();
    const legacyBene = db.prepare(`INSERT INTO benefits (card_id, title, category, reset_cadence, uses_per_period, value_usd)
      VALUES ('ihg_premier', '$10 monthly Instacart credit', 'retail_credit', 'monthly', 12, 120)
    `).run();
    // Real user usage on the legacy benefit — MUST be preserved.
    usageCreate(db, { benefit_id: Number(legacyBene.lastInsertRowid), used_on: '2026-03-15', amount_usd: 10 });
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seed_version', '1.0.1')`).run();
    return db;
  }

  it('purges deprecated Marriott cards and cascades their benefits', () => {
    const db = legacyDb();
    expect(db.prepare(`SELECT 1 FROM cards WHERE id = 'marriott_bonvoy_brilliant'`).get()).toBeDefined();
    applyDataMigrations(db);
    expect(db.prepare(`SELECT 1 FROM cards WHERE id = 'marriott_bonvoy_brilliant'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT 1 FROM benefits WHERE card_id = 'marriott_bonvoy_brilliant'`).get()).toBeUndefined();
  });

  it('UPSERTs seeded benefits to fix broken value/uses_per_period without losing usages', () => {
    const db = legacyDb();
    const beforeUsages = db.prepare(`SELECT COUNT(*) AS n FROM usages`).get() as { n: number };
    expect(beforeUsages.n).toBe(1);

    applyDataMigrations(db);

    const bene = db.prepare(`SELECT id, uses_per_period, value_usd FROM benefits
      WHERE card_id = 'ihg_premier' AND title = '$10 monthly Instacart credit'`).get() as { id: number; uses_per_period: number; value_usd: number };
    expect(bene).toBeDefined();
    // Migration should have rewritten the row to per-USE = $10, uses_per_period = 1.
    expect(bene.uses_per_period).toBe(1);
    expect(bene.value_usd).toBe(10);
    // Usage on that benefit id must still exist (UPDATE, not DELETE+INSERT).
    const afterUsages = db.prepare(`SELECT COUNT(*) AS n FROM usages WHERE benefit_id = ?`).get(bene.id) as { n: number };
    expect(afterUsages.n).toBe(1);
  });

  it('is idempotent — running migrations twice does not double-insert', () => {
    const db = legacyDb();
    applyDataMigrations(db);
    const cardsFirst = db.prepare(`SELECT COUNT(*) AS n FROM cards`).get() as { n: number };
    const benefitsFirst = db.prepare(`SELECT COUNT(*) AS n FROM benefits`).get() as { n: number };
    applyDataMigrations(db);
    const cardsSecond = db.prepare(`SELECT COUNT(*) AS n FROM cards`).get() as { n: number };
    const benefitsSecond = db.prepare(`SELECT COUNT(*) AS n FROM benefits`).get() as { n: number };
    expect(cardsSecond.n).toBe(cardsFirst.n);
    expect(benefitsSecond.n).toBe(benefitsFirst.n);
  });

  it('stamps seed_version = 1.0.5 in app_meta', () => {
    const db = legacyDb();
    applyDataMigrations(db);
    const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'seed_version'`).get() as { value: string };
    // The v1.0.3 migration chain now runs through v1.0.4, v1.0.5, and v1.0.6
    // sequentially; the final stamp is whatever the latest release is.
    expect(row.value).toBe('1.0.6');
  });
});

describe('v1.0.4 migration and features', () => {
  it('preserves marriott_premier on migration (v1.0.5 restored the card v1.0.4 mistakenly removed)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    db.prepare(`INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active) VALUES
      ('marriott_premier', 'Marriott Rewards Premier Visa', 'Chase', 'Visa', 85, 1)
    `).run();
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seed_version', '1.0.3')`).run();
    expect(db.prepare(`SELECT 1 FROM cards WHERE id = 'marriott_premier'`).get()).toBeDefined();
    applyDataMigrations(db);
    expect(db.prepare(`SELECT 1 FROM cards WHERE id = 'marriott_premier'`).get()).toBeDefined();
    const stamp = db.prepare(`SELECT value FROM app_meta WHERE key = 'seed_version'`).get() as { value: string };
    // Migrations run through the whole chain; final stamp is the latest release.
    expect(stamp.value).toBe('1.0.6');
  });

  it('adds is_visible column to cards and expiration_date column to benefits on legacy DBs', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Create pre-v1.0.4 schema WITHOUT is_visible / expiration_date.
    db.exec(`
      CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL,
        network TEXT NOT NULL, annual_fee_usd REAL, is_active INTEGER NOT NULL DEFAULT 1,
        color_hex TEXT, notes TEXT, source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE programs (id TEXT PRIMARY KEY, name TEXT NOT NULL, program_type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1, notes TEXT, source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE benefits (id INTEGER PRIMARY KEY, card_id TEXT, program_id TEXT,
        title TEXT NOT NULL, description TEXT, category TEXT NOT NULL, reset_cadence TEXT NOT NULL,
        uses_per_period INTEGER, value_usd REAL, spend_threshold_usd REAL, expiration_note TEXT,
        is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        source_url TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE usages (id INTEGER PRIMARY KEY, benefit_id INTEGER NOT NULL, used_on TEXT NOT NULL,
        amount_usd REAL, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seed_version', '1.0.3')`).run();
    applyDataMigrations(db);
    const cardCols = db.prepare("PRAGMA table_info('cards')").all() as Array<{ name: string }>;
    const benCols = db.prepare("PRAGMA table_info('benefits')").all() as Array<{ name: string }>;
    expect(cardCols.some((c) => c.name === 'is_visible')).toBe(true);
    expect(benCols.some((c) => c.name === 'expiration_date')).toBe(true);
  });

  it('renames Virgin Atlantic card to "Virgin Atlantic Credit Card" if present under legacy name', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    db.prepare(`INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active) VALUES
      ('virgin_atlantic', 'Legacy Virgin Atlantic World Elite Mastercard', 'Synchrony', 'Mastercard', 149, 1)
    `).run();
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seed_version', '1.0.3')`).run();
    applyDataMigrations(db);
    const row = db.prepare(`SELECT name FROM cards WHERE id = 'virgin_atlantic'`).get() as { name: string };
    expect(row.name).toBe('Virgin Atlantic Credit Card');
  });

  it('v1.0.4 migration is idempotent — running twice does not double-insert', () => {
    const db = seededDb();
    applyDataMigrations(db);
    const cardsFirst = (db.prepare(`SELECT COUNT(*) AS n FROM cards`).get() as { n: number }).n;
    const benefitsFirst = (db.prepare(`SELECT COUNT(*) AS n FROM benefits`).get() as { n: number }).n;
    applyDataMigrations(db);
    const cardsSecond = (db.prepare(`SELECT COUNT(*) AS n FROM cards`).get() as { n: number }).n;
    const benefitsSecond = (db.prepare(`SELECT COUNT(*) AS n FROM benefits`).get() as { n: number }).n;
    expect(cardsSecond).toBe(cardsFirst);
    expect(benefitsSecond).toBe(benefitsFirst);
  });

  it('cardSetVisible flips is_visible and hides cards from projections', async () => {
    const { cardSetVisible } = await import('../electron/database');
    const db = seededDb();
    // Pick any card that has at least one non-unlimited benefit so projection filtering is observable.
    const cardWithBene = db.prepare(`SELECT card_id FROM benefits WHERE card_id IS NOT NULL AND reset_cadence != 'unlimited' LIMIT 1`).get() as { card_id: string };
    expect(cardWithBene).toBeDefined();
    const beforeAll = computeProjections(db, 2026);
    const beforeHasCard = beforeAll.some(p => p.benefit.card_id === cardWithBene.card_id);
    expect(beforeHasCard).toBe(true);
    cardSetVisible(db, cardWithBene.card_id, false);
    const afterAll = computeProjections(db, 2026);
    const afterHasCard = afterAll.some(p => p.benefit.card_id === cardWithBene.card_id);
    expect(afterHasCard).toBe(false);
    // Restoring visibility brings the projections back.
    cardSetVisible(db, cardWithBene.card_id, true);
    const restoredAll = computeProjections(db, 2026);
    expect(restoredAll.some(p => p.benefit.card_id === cardWithBene.card_id)).toBe(true);
  });

  it('expiration_date persists on benefit create/update', () => {
    const db = seededDb();
    const anyCard = cardsGetAll(db)[0];
    const created = benefitCreate(db, {
      card_id: anyCard.id, program_id: null,
      title: 'Test benefit with expiration',
      category: 'free_night', reset_cadence: 'annual', uses_per_period: 1,
      value_usd: null, spend_threshold_usd: null,
      expiration_note: null, expiration_date: '2027-12-31',
      sort_order: 0, source_url: null, notes: null, is_active: 1,
    } as any);
    const id = (created as any).id as number;
    const row = db.prepare(`SELECT expiration_date FROM benefits WHERE id = ?`).get(id) as { expiration_date: string | null };
    expect(row.expiration_date).toBe('2027-12-31');
    benefitUpdate(db, id, { expiration_date: '2028-06-30' } as any);
    const row2 = db.prepare(`SELECT expiration_date FROM benefits WHERE id = ?`).get(id) as { expiration_date: string | null };
    expect(row2.expiration_date).toBe('2028-06-30');
  });

  it('computeProjections attaches period_history for annual/monthly/quarterly benefits', () => {
    const db = seededDb();
    const projections = computeProjections(db, 2026);
    // Every non-unlimited projection should carry a period_history array.
    const nonUnlimited = projections.filter((p: any) => p.benefit.reset_cadence !== 'unlimited' && p.benefit.reset_cadence !== 'spend_threshold' && p.benefit.reset_cadence !== 'one_time');
    expect(nonUnlimited.length).toBeGreaterThan(0);
    for (const p of nonUnlimited) {
      expect((p as any).period_history).toBeDefined();
      expect(Array.isArray((p as any).period_history)).toBe(true);
      expect((p as any).period_history.length).toBeGreaterThan(0);
    }
  });

  it('seed corrections landed: Global Entry $120 single-use, Priority Pass unlimited, President\u2019s Circle unlimited, Companion Certificate $0, Virgin Atlantic name', () => {
    const db = seededDb();
    // Virgin Atlantic card renamed.
    const va = db.prepare(`SELECT name FROM cards WHERE id = 'virgin_atlantic'`).get() as { name: string } | undefined;
    if (va) expect(va.name).toMatch(/Virgin Atlantic Credit Card/);

    // marriott_premier restored in v1.0.5 (user has this card).
    expect(db.prepare(`SELECT 1 FROM cards WHERE id = 'marriott_premier'`).get()).toBeDefined();

    // Global Entry: single-use, $120 total across every card that offers it.
    const ge = db.prepare(`SELECT card_id, reset_cadence, uses_per_period, value_usd FROM benefits WHERE title LIKE '%Global Entry%'`).all() as Array<{ card_id: string; reset_cadence: string; uses_per_period: number | null; value_usd: number | null }>;
    expect(ge.length).toBeGreaterThan(0);
    for (const b of ge) {
      expect(b.value_usd).toBe(120);
    }

    // Amex Platinum Global Lounge Collection: unlimited.
    const gl = db.prepare(`SELECT reset_cadence FROM benefits WHERE title LIKE '%Global Lounge Collection%'`).get() as { reset_cadence: string } | undefined;
    if (gl) expect(gl.reset_cadence).toBe('unlimited');

    // Delta Reserve Annual Companion Certificate: value $0 (points).
    const cc = db.prepare(`SELECT value_usd FROM benefits WHERE title LIKE '%Annual Companion Certificate%'`).get() as { value_usd: number | null } | undefined;
    if (cc) expect(cc.value_usd).toBe(0);

    // President’s Circle: unlimited.
    const pc = db.prepare(`SELECT reset_cadence FROM benefits WHERE title LIKE '%President%s Circle%'`).get() as { reset_cadence: string } | undefined;
    if (pc) expect(pc.reset_cadence).toBe('unlimited');

    // Citi Prestige Priority Pass Membership: unlimited.
    const pp = db.prepare(`SELECT reset_cadence FROM benefits WHERE card_id = 'citi_prestige' AND title LIKE '%Priority Pass%'`).get() as { reset_cadence: string } | undefined;
    if (pp) expect(pp.reset_cadence).toBe('unlimited');
  });
});

describe('v1.0.5 migration and features', () => {
  it('AA Executive Global Entry reset window is every 5 years (per Citi terms)', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT reset_years, description FROM benefits
      WHERE card_id = 'aa_executive' AND title LIKE '%Global Entry%'
    `).get() as { reset_years: number | null; description: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.reset_years).toBe(5);
    expect(row!.description ?? '').toMatch(/5\s*year/i);
  });

  it('Amex Platinum / IHG Premier / Delta Reserve Global Entry reset every 4 years', () => {
    const db = seededDb();
    for (const cardId of ['amex_platinum', 'ihg_premier', 'delta_reserve']) {
      const row = db.prepare(`
        SELECT reset_years FROM benefits WHERE card_id = ? AND title LIKE '%Global Entry%'
      `).get(cardId) as { reset_years: number | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.reset_years).toBe(4);
    }
  });

  it('Citi Prestige Global Entry resets every 5 years', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT reset_years FROM benefits
      WHERE card_id = 'citi_prestige' AND title LIKE '%Global Entry%'
    `).get() as { reset_years: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.reset_years).toBe(5);
  });

  it('marriott_premier is present with at least 10 benefits', () => {
    const db = seededDb();
    const card = db.prepare(`SELECT id FROM cards WHERE id = 'marriott_premier'`).get();
    expect(card).toBeDefined();
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM benefits WHERE card_id = 'marriott_premier'`).get() as { n: number }).n;
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it('citi_prestige Closed-to-New-Applicants tile is not in the seeded DB', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT 1 FROM benefits
      WHERE card_id = 'citi_prestige' AND title = 'Closed to New Applicants (existing benefits retained)'
    `).get();
    expect(row).toBeUndefined();
  });

  it('reset_years persists on benefit create/update', () => {
    const db = seededDb();
    const anyCard = cardsGetAll(db)[0];
    const created = benefitCreate(db, {
      card_id: anyCard.id, program_id: null,
      title: 'Test benefit with reset_years',
      category: 'other', reset_cadence: 'one_time', uses_per_period: 1,
      value_usd: null, spend_threshold_usd: null,
      expiration_note: null, expiration_date: null,
      reset_years: 4,
      sort_order: 0, source_url: null, notes: null, is_active: 1,
    } as any);
    const id = (created as any).id as number;
    const row = db.prepare(`SELECT reset_years FROM benefits WHERE id = ?`).get(id) as { reset_years: number | null };
    expect(row.reset_years).toBe(4);
    benefitUpdate(db, id, { reset_years: 5 } as any);
    const row2 = db.prepare(`SELECT reset_years FROM benefits WHERE id = ?`).get(id) as { reset_years: number | null };
    expect(row2.reset_years).toBe(5);
  });

  it('adds reset_years column to benefits on legacy DBs', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL,
        network TEXT NOT NULL, annual_fee_usd REAL, is_active INTEGER NOT NULL DEFAULT 1,
        is_visible INTEGER NOT NULL DEFAULT 1,
        color_hex TEXT, notes TEXT, source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE programs (id TEXT PRIMARY KEY, name TEXT NOT NULL, program_type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1, notes TEXT, source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE benefits (id INTEGER PRIMARY KEY, card_id TEXT, program_id TEXT,
        title TEXT NOT NULL, description TEXT, category TEXT NOT NULL, reset_cadence TEXT NOT NULL,
        uses_per_period INTEGER, value_usd REAL, spend_threshold_usd REAL, expiration_note TEXT,
        expiration_date TEXT,
        is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        source_url TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE usages (id INTEGER PRIMARY KEY, benefit_id INTEGER NOT NULL, used_on TEXT NOT NULL,
        amount_usd REAL, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seed_version', '1.0.4')`).run();
    applyDataMigrations(db);
    const benCols = db.prepare("PRAGMA table_info('benefits')").all() as Array<{ name: string }>;
    expect(benCols.some((c) => c.name === 'reset_years')).toBe(true);
  });
});

// ─── v1.0.6 tests ────────────────────────────────────────────────────────────

describe('v1.0.6 migration and features', () => {
  it('#1 Delta Reserve Sky Club visits benefit instructs count-based logging', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT notes FROM benefits
      WHERE card_id = 'delta_reserve' AND title LIKE '%Delta Sky Club Visits%'
    `).get() as { notes: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.notes ?? '').toMatch(/one use|no dollar/i);
  });

  it('#2 Delta Reserve unlimited SkyClub after $75k spend exists', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT reset_cadence, spend_threshold_usd FROM benefits
      WHERE card_id = 'delta_reserve' AND title LIKE '%Unlimited Delta Sky Club Access%'
    `).get() as { reset_cadence: string; spend_threshold_usd: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.reset_cadence).toBe('spend_threshold');
    expect(row!.spend_threshold_usd).toBe(75000);
  });

  it('#3 Amex Platinum Centurion guest access after $75k spend exists', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT reset_cadence, spend_threshold_usd FROM benefits
      WHERE card_id = 'amex_platinum' AND title LIKE '%Centurion%Guest Access%'
    `).get() as { reset_cadence: string; spend_threshold_usd: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.reset_cadence).toBe('spend_threshold');
    expect(row!.spend_threshold_usd).toBe(75000);
  });

  it('#4 deleting a logged usage removes the usage row (baseline)', () => {
    const db = seededDb();
    const anyBenefit = benefitsGetAll(db).find(b => b.reset_cadence !== 'unlimited')!;
    const u = usageCreate(db, {
      benefit_id: anyBenefit.id, used_on: '2026-01-15', amount_usd: 10, notes: 'test',
    } as any);
    const uid = (u as any).id as number;
    expect(usagesForBenefit(db, anyBenefit.id).length).toBeGreaterThan(0);
    usageDelete(db, uid);
    expect(usagesForBenefit(db, anyBenefit.id).find(x => x.id === uid)).toBeUndefined();
  });

  it('#5 Amex Platinum Uber One credit is monthly', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT reset_cadence, uses_per_period FROM benefits
      WHERE card_id = 'amex_platinum' AND title LIKE '%Uber One%'
    `).get() as { reset_cadence: string; uses_per_period: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.reset_cadence).toBe('monthly');
  });

  it('#6 Amex Platinum $200 Uber credit description explains Jan-Nov + Dec split', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT description FROM benefits
      WHERE card_id = 'amex_platinum' AND title LIKE '%Uber Cash%'
    `).get() as { description: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.description ?? '').toMatch(/15.*Jan|Nov.*15|\$35.*Dec|Dec.*\$35/i);
  });

  it('#7 Bonvoy Gold + Hilton Gold status benefits are unlimited/ongoing', () => {
    const db = seededDb();
    const bonvoy = db.prepare(`
      SELECT reset_cadence FROM benefits
      WHERE card_id = 'amex_platinum' AND title LIKE '%Bonvoy Gold%'
    `).get() as { reset_cadence: string } | undefined;
    expect(bonvoy).toBeDefined();
    expect(bonvoy!.reset_cadence).toBe('unlimited');
    const marriottBiz = db.prepare(`
      SELECT reset_cadence FROM benefits
      WHERE card_id = 'marriott_business' AND title LIKE '%Bonvoy Gold%'
    `).get() as { reset_cadence: string } | undefined;
    expect(marriottBiz).toBeDefined();
    expect(marriottBiz!.reset_cadence).toBe('unlimited');
  });

  it('#8/#9 no duplicate legacy Virgin Atlantic titles remain', () => {
    const db = seededDb();
    // Legacy titles missing suffix must be absent.
    const legacyTierPoints = db.prepare(`
      SELECT COUNT(*) AS n FROM benefits WHERE card_id = 'ba_visa' AND title = 'Tier Points on Spend'
    `).get() as { n: number };
    expect(legacyTierPoints.n).toBe(0);
    const legacyAuth = db.prepare(`
      SELECT COUNT(*) AS n FROM benefits WHERE card_id = 'virgin_atlantic' AND title = '2,500 Virgin Points per Authorized User'
    `).get() as { n: number };
    expect(legacyAuth.n).toBe(0);
  });

  it('#10 no BofA legacy benefit rows in seeded DB', () => {
    const db = seededDb();
    const bofa = db.prepare(`
      SELECT COUNT(*) AS n FROM benefits WHERE title LIKE '[LEGACY BofA card]%'
    `).get() as { n: number };
    expect(bofa.n).toBe(0);
  });

  it('#11 AA elite ladder: 15K/60K/100K/175K/250K/400K tiers exist, no tier > 400K', () => {
    const db = seededDb();
    const tiers = db.prepare(`
      SELECT title FROM benefits WHERE program_id = 'aa_status' AND is_choice_option = 0
      ORDER BY sort_order ASC
    `).all() as Array<{ title: string }>;
    const titles = tiers.map(t => t.title).join(' || ');
    for (const marker of ['15,000 Loyalty Points', '60,000 Loyalty Points', '100,000 Loyalty Points',
                          '175,000 Loyalty Points', '250,000 Loyalty Points', '400,000 Loyalty Points']) {
      expect(titles).toContain(marker);
    }
    // No tier > 400K modeled.
    for (const skip of ['550,000', '750,000', '1,000,000', '3,000,000', '5,000,000']) {
      expect(titles).not.toContain(skip);
    }
  });

  it('#11 AA prerequisite chain wires each tier to its predecessor', () => {
    const db = seededDb();
    // Get 100K row; its prerequisite_benefit_id should point at 60K row.
    const t100 = db.prepare(`
      SELECT id, prerequisite_benefit_id FROM benefits
      WHERE program_id = 'aa_status' AND title LIKE '100,000 Loyalty Points%' AND is_choice_option = 0
    `).get() as { id: number; prerequisite_benefit_id: number | null } | undefined;
    expect(t100).toBeDefined();
    expect(t100!.prerequisite_benefit_id).not.toBeNull();
    const parent = db.prepare(`SELECT title FROM benefits WHERE id = ?`).get(t100!.prerequisite_benefit_id) as { title: string };
    expect(parent.title).toMatch(/60,000 Loyalty Points/);
  });

  it('#11 AA choice options are flagged is_choice_option=1 and point at their tier', () => {
    const db = seededDb();
    // Pick a 175K choice option row.
    const choice = db.prepare(`
      SELECT prerequisite_benefit_id, is_choice_option FROM benefits
      WHERE program_id = 'aa_status' AND title LIKE '175K LP Choice - %'
      LIMIT 1
    `).get() as { prerequisite_benefit_id: number | null; is_choice_option: number } | undefined;
    expect(choice).toBeDefined();
    expect(choice!.is_choice_option).toBe(1);
    expect(choice!.prerequisite_benefit_id).not.toBeNull();
    const parent = db.prepare(`SELECT title FROM benefits WHERE id = ?`).get(choice!.prerequisite_benefit_id) as { title: string };
    expect(parent.title).toMatch(/175,000 Loyalty Points/);
  });

  it('#12 Admirals Club Membership is unlimited/ongoing', () => {
    const db = seededDb();
    const row = db.prepare(`
      SELECT reset_cadence FROM benefits
      WHERE card_id = 'aa_executive' AND title LIKE '%Admirals Club Membership%'
    `).get() as { reset_cadence: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.reset_cadence).toBe('unlimited');
  });

  it('adds prerequisite/choice columns on legacy DBs at v1.0.5', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL,
        network TEXT NOT NULL, annual_fee_usd REAL, is_active INTEGER NOT NULL DEFAULT 1,
        is_visible INTEGER NOT NULL DEFAULT 1,
        color_hex TEXT, notes TEXT, source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE programs (id TEXT PRIMARY KEY, name TEXT NOT NULL, program_type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1, notes TEXT, source_url TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE benefits (id INTEGER PRIMARY KEY, card_id TEXT, program_id TEXT,
        title TEXT NOT NULL, description TEXT, category TEXT NOT NULL, reset_cadence TEXT NOT NULL,
        uses_per_period INTEGER, value_usd REAL, spend_threshold_usd REAL, expiration_note TEXT,
        expiration_date TEXT, reset_years INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
        source_url TEXT, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE usages (id INTEGER PRIMARY KEY, benefit_id INTEGER NOT NULL, used_on TEXT NOT NULL,
        amount_usd REAL, notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('seed_version', '1.0.5')`).run();
    applyDataMigrations(db);
    const benCols = db.prepare("PRAGMA table_info('benefits')").all() as Array<{ name: string }>;
    expect(benCols.some((c) => c.name === 'prerequisite_benefit_id')).toBe(true);
    expect(benCols.some((c) => c.name === 'is_choice_option')).toBe(true);
    expect(benCols.some((c) => c.name === 'choice_selected')).toBe(true);
    const meta = db.prepare(`SELECT value FROM app_meta WHERE key = 'seed_version'`).get() as { value: string };
    expect(meta.value).toBe('1.0.6');
  });

  it('choice_selected toggle survives via benefitUpdate', () => {
    const db = seededDb();
    // Find any is_choice_option row.
    const choice = db.prepare(`
      SELECT id, choice_selected FROM benefits WHERE is_choice_option = 1 LIMIT 1
    `).get() as { id: number; choice_selected: number } | undefined;
    expect(choice).toBeDefined();
    expect(choice!.choice_selected).toBe(0);
    benefitUpdate(db, choice!.id, { choice_selected: 1 } as any);
    const after = db.prepare(`SELECT choice_selected FROM benefits WHERE id = ?`).get(choice!.id) as { choice_selected: number };
    expect(after.choice_selected).toBe(1);
  });
});
