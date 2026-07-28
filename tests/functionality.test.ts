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
