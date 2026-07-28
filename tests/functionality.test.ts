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
  seedIfFresh,
} from '../electron/database';

describe('Seed data loads correctly', () => {
  it('seeds cards, programs, and benefits from the research-generated data', () => {
    const db = seededDb();
    const cards = cardsGetAll(db);
    const programs = programsGetAll(db);
    const benefits = benefitsGetAll(db);
    expect(cards.length).toBeGreaterThanOrEqual(11);   // 11 hand fallback, 13 generated
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

  it('monthly $15 credit (uses_per_period=12) projects annual_value_usd = $180', () => {
    const db = seededDb();
    const card = cardsGetAll(db)[0];
    const b = benefitCreate(db, {
      card_id: card.id, program_id: null,
      title: 'Monthly test', category: 'other',
      reset_cadence: 'monthly', uses_per_period: 12, value_usd: 15,
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
