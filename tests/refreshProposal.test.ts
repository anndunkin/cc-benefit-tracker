import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { seededDb } from './helpers';
import {
  applyDataMigrations, benefitCreate, benefitUpdate, benefitsGetAll, cardGetById,
  pointsCurrencyGetById, pointsCurrencyUpdate, refreshGetStatus, refreshPendingChanges,
  refreshApproveChange, refreshRejectChange, refreshApplyRun, refreshDiscardRun,
  buildFilePayload, importFilePayload, ensureRefreshSchema, usageCreate, usagesForBenefit,
  computeProjections, reconcileCertificateAwards,
} from '../electron/database';
import {
  validateProposal, diffProposal, createRunFromProposal, offerBundledProposals,
  importProposalText, MAX_PROPOSAL_BYTES, PROPOSAL_FORMAT,
} from '../electron/refreshProposal';
import { BUNDLED_REFRESH_PROPOSALS } from '../electron/refreshProposalData';
import { isMilestone } from '../electron/benefitRules';
import { airlinePurchaseRequirement, isOmniStayBenefit } from '../electron/certificateRules';
import { buildExpiringReport, utcDateFor } from '../electron/expiringCredits';
import type { RefreshProposal } from '../electron/types';

/** A fully seeded + migrated database, i.e. what a real install looks like. */
function liveDb(): Database.Database {
  const db = seededDb();
  applyDataMigrations(db);
  return db;
}

const SRC = [{ url: 'https://example.com/terms', label: 'Issuer terms', source_type: 'official' }];

/** Adds three plain catalog-style rows to the first card and returns a proposal touching them. */
function fixture(db: Database.Database) {
  const cardId = 'amex_platinum';
  const mk = (title: string, value: number) => benefitCreate(db, {
    card_id: cardId, program_id: null, title, category: 'travel_credit',
    reset_cadence: 'annual', uses_per_period: 1, value_usd: value, description: `${title} description`,
  }, false);
  const a = mk('Fixture Credit A', 100);
  const b = mk('Fixture Credit B', 200);
  const c = mk('Fixture Credit C', 300);
  const proposal = {
    format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'test-2026-q4',
    title: 'Test refresh', prepared_on: '2026-11-22',
    changes: [
      { scope: 'benefit', change_type: 'modified', card_id: cardId, match_title: 'fixture credit a',
        after: { value_usd: 150, description: 'New A description' },
        summary: 'Credit A rose to $150.', effective_date: '2026-10-01', sources: SRC },
      { scope: 'benefit', change_type: 'modified', card_id: cardId, match_title: 'Fixture Credit B',
        after: { value_usd: 200 }, summary: 'No real change.', sources: SRC },
      { scope: 'benefit', change_type: 'removed', card_id: cardId, match_title: 'Fixture Credit C',
        summary: 'Credit C ended.', sources: SRC },
      { scope: 'benefit', change_type: 'added', card_id: cardId,
        after: { title: 'Fixture Credit D', category: 'travel_credit', reset_cadence: 'annual', uses_per_period: 1, value_usd: 50 },
        summary: 'New credit D.', sources: SRC },
      { scope: 'card', change_type: 'modified', card_id: cardId, after: { annual_fee_usd: 995 },
        summary: 'Fee rose.', sources: SRC },
      { scope: 'points_currency', change_type: 'modified', points_currency_id: 'british_airways_avios',
        after: { value_cents_per_point: 1.2 }, summary: 'Valuation lowered.', sources: SRC },
      { scope: 'benefit', change_type: 'modified', card_id: cardId, match_title: 'No Such Benefit',
        after: { value_usd: 1 }, summary: 'Will not match.', sources: SRC },
    ],
  };
  return { cardId, a, b, c, proposal };
}

function approveAll(db: Database.Database, runId: number, overwrite = false) {
  for (const ch of refreshPendingChanges(db, runId)) refreshApproveChange(db, ch.id, undefined, overwrite);
}

it('uses the real approved Omni and IHG catalog rows without changing unrelated benefits', () => {
  const db = liveDb();
  const today = '2026-11-24';
  const isTarget = (c: RefreshProposal['changes'][number]) => c.scope === 'benefit' && c.change_type === 'added'
    && ((c.card_id === 'aa_executive' && c.after.title === 'Omni Free Night Award')
      || (c.card_id === 'ihg_premier' && c.after.title === '$100 Annual Airline Statement Credit'));
  try {
    const selected = BUNDLED_REFRESH_PROPOSALS.flatMap(p => p.changes.filter(isTarget));
    expect(selected).toHaveLength(2);
    const r = createRunFromProposal(db, {
      ...BUNDLED_REFRESH_PROPOSALS[0], proposal_id: 'test-omni-ihg-catalog', changes: selected,
    });
    expect(r.proposed).toBe(2);
    expect(benefitsGetAll(db).some(b => isOmniStayBenefit(b) || airlinePurchaseRequirement(b))).toBe(false);
    approveAll(db, r.run_id!);
    expect(refreshApplyRun(db, r.run_id!).applied).toBe(2);
    const all = benefitsGetAll(db);
    const omni = all.filter(isOmniStayBenefit);
    const ihg = all.filter(b => airlinePurchaseRequirement(b));
    expect(omni).toHaveLength(1);
    expect(ihg).toHaveLength(1);
    usageCreate(db, { benefit_id: omni[0].id, used_on: '2026-11-23', quantity: 2 });
    reconcileCertificateAwards(db, today);
    const p = computeProjections(db, 2026, utcDateFor(today));
    const earned = p.filter(x => x.certificate_kind === 'omni_stay');
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({ uses_count: 0, benefit: { card_id: 'aa_executive', program_id: null, expiration_date: null } });
    const notes = buildExpiringReport(p, today).items.filter(row => row.note?.includes('one flight-ticket purchase of $250'));
    expect(notes.map(row => row.benefit_id)).toEqual([ihg[0].id]);
  } finally {
    db.close();
  }
});

describe('Refresh proposal validation (untrusted input)', () => {
  const ok = () => fixture(liveDb()).proposal as Record<string, unknown>;

  it('accepts a well-formed proposal and returns only known fields', () => {
    const raw = { ...ok(), surprise: 'x' };
    const p = validateProposal(raw);
    expect(p.changes.length).toBe(7);
    expect((p as unknown as Record<string, unknown>).surprise).toBeUndefined();
    expect(p.not_before).toBeNull();
  });

  it.each([
    ['not an object', 'nope'],
    ['wrong format', { ...ok(), format: 'something-else' }],
    ['wrong version', { ...ok(), format_version: 2 }],
    ['bad id', { ...ok(), proposal_id: 'Has Spaces' }],
    ['bad date', { ...ok(), prepared_on: '11/22/2026' }],
    ['impossible date', { ...ok(), prepared_on: '2026-02-31' }],
    ['no changes', { ...ok(), changes: [] }],
  ])('rejects %s', (_n, raw) => {
    expect(() => validateProposal(raw)).toThrow();
  });

  const withChange = (c: Record<string, unknown>) => ({ ...ok(), changes: [c] });
  const base = { scope: 'benefit', change_type: 'modified', card_id: 'amex_platinum', match_title: 'X', summary: 's', sources: SRC };

  it.each([
    ['an unknown field', { ...base, after: { is_user_modified: 0 } }],
    ['a field that could re-point the row', { ...base, after: { card_id: 'other' } }],
    ['an id field', { ...base, after: { id: 5 } }],
    ['a bad enum value', { ...base, after: { reset_cadence: 'weekly' } }],
    ['a negative amount', { ...base, after: { value_usd: -5 } }],
    ['a non-finite amount', { ...base, after: { value_usd: Number.POSITIVE_INFINITY } }],
    ['a string where a number belongs', { ...base, after: { value_usd: '150' } }],
    ['a null title', { ...base, after: { title: null } }],
    ['an empty after', { ...base, after: {} }],
    ['a non-https benefit link', { ...base, after: { source_url: 'http://example.com' } }],
    ['a javascript: link', { ...base, after: { source_url: 'javascript:alert(1)' } }],
    ['no sources', { ...base, after: { value_usd: 1 }, sources: [] }],
    ['a non-https source', { ...base, after: { value_usd: 1 }, sources: [{ url: 'file:///c:/x' }] }],
    ['both a card and a program', { ...base, program_id: 'hilton_status', after: { value_usd: 1 } }],
    ['neither a card nor a program', { ...base, card_id: null, after: { value_usd: 1 } }],
    ['a missing match_title', { ...base, match_title: undefined, after: { value_usd: 1 } }],
    ['an unknown scope', { ...base, scope: 'usage', after: { value_usd: 1 } }],
    ['removing a card', { scope: 'card', change_type: 'removed', card_id: 'amex_platinum', summary: 's', sources: SRC }],
    ['an added benefit without a category', { scope: 'benefit', change_type: 'added', card_id: 'amex_platinum', after: { title: 'T', reset_cadence: 'annual' }, summary: 's', sources: SRC }],
  ])('rejects a change with %s', (_n, change) => {
    expect(() => validateProposal(withChange(change as Record<string, unknown>))).toThrow();
  });

  it('rejects oversized and non-JSON files before touching the database', () => {
    const db = liveDb();
    expect(() => importProposalText(db, 'not json')).toThrow(/not valid JSON/);
    expect(() => importProposalText(db, ' '.repeat(MAX_PROPOSAL_BYTES + 1))).toThrow(/too large/);
    expect(() => importProposalText(db, JSON.stringify({ format: 'x' }))).toThrow(/not a benefit refresh file/);
    expect(refreshGetStatus(db).pending_run_id).toBeNull();
  });

  it('stores SQL-looking text as plain text', () => {
    const db = liveDb();
    const { proposal, a } = fixture(db);
    const evil = `x'); DROP TABLE benefits; --`;
    proposal.changes = [{ ...proposal.changes[0], after: { description: evil } }];
    const r = importProposalText(db, JSON.stringify(proposal));
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    expect(benefitsGetAll(db).find(x => x.id === a.id)!.description).toBe(evil);
  });
});

describe('Refresh proposal → draft run', () => {
  it('proposes only real differences, reports the rest, and changes nothing until applied', () => {
    const db = liveDb();
    const { proposal, a, c, cardId } = fixture(db);
    const before = JSON.stringify(benefitsGetAll(db));
    const feeBefore = cardGetById(db, cardId)!.annual_fee_usd;

    const r = importProposalText(db, JSON.stringify(proposal));
    expect(r.state).toBe('created');
    expect(r.proposed).toBe(5);            // A, C removed, D added, card fee, Avios
    expect(r.already_current).toBe(1);     // B already matches
    expect(r.unmatched.map(u => u.title)).toEqual(['No Such Benefit']);

    // Creating the draft is read-only as far as benefits are concerned.
    expect(JSON.stringify(benefitsGetAll(db))).toBe(before);
    expect(cardGetById(db, cardId)!.annual_fee_usd).toBe(feeBefore);

    const status = refreshGetStatus(db);
    expect(status.pending_run_id).toBe(r.run_id);
    expect(status.pending_run_notes).toContain('[refresh:test-2026-q4]');
    expect(status.unmatched.length).toBe(1);

    const changes = refreshPendingChanges(db, r.run_id!);
    const modA = changes.find(ch => ch.benefit_id === a.id)!;
    expect(JSON.parse(modA.before_json!)).toEqual({ title: 'Fixture Credit A', value_usd: 100, description: 'Fixture Credit A description' });
    const afterA = JSON.parse(modA.after_json!);
    expect(afterA.value_usd).toBe(150);
    expect(afterA._meta.summary).toBe('Credit A rose to $150.');
    expect(afterA._meta.effective_date).toBe('2026-10-01');
    expect(afterA._meta.sources[0].url).toBe('https://example.com/terms');
    expect(changes.find(ch => ch.benefit_id === c.id)!.change_type).toBe('removed');
  });

  it('applies approved rows field by field and leaves rejected and undecided rows alone', () => {
    const db = liveDb();
    const { proposal, a, c, cardId } = fixture(db);
    usageCreate(db, { benefit_id: c.id, used_on: '2026-04-01', amount_usd: 100 });
    const r = importProposalText(db, JSON.stringify(proposal));
    const changes = refreshPendingChanges(db, r.run_id!);
    for (const ch of changes) {
      if (ch.points_currency_id) refreshRejectChange(db, ch.id, 'keep mine');
      else if (ch.change_type === 'added') continue;                       // left undecided
      else refreshApproveChange(db, ch.id);
    }
    const res = refreshApplyRun(db, r.run_id!);
    expect(res).toEqual({ applied: 3, skipped: 2 });

    const all = benefitsGetAll(db);
    const rowA = all.find(x => x.id === a.id)!;
    expect(rowA.value_usd).toBe(150);
    expect(rowA.description).toBe('New A description');
    expect(rowA.title).toBe('Fixture Credit A');          // untouched field
    expect(rowA.category).toBe('travel_credit');
    expect(rowA.is_user_modified).toBe(0);
    const rowC = all.find(x => x.id === c.id)!;
    expect(rowC.is_active).toBe(0);
    expect(usagesForBenefit(db, c.id).length).toBe(1);    // history kept
    expect(all.some(x => x.title === 'Fixture Credit D')).toBe(false);
    expect(cardGetById(db, cardId)!.annual_fee_usd).toBe(995);
    expect(pointsCurrencyGetById(db, 'british_airways_avios')!.value_cents_per_point).not.toBe(1.2);

    const status = refreshGetStatus(db);
    expect(status.pending_run_id).toBeNull();
    expect(status.last_run_at).not.toBeNull();
    expect(status.unmatched).toEqual([]);
  });

  it('adds new benefits as catalog rows and updates point values', () => {
    const db = liveDb();
    const { proposal } = fixture(db);
    const r = importProposalText(db, JSON.stringify(proposal));
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    const d = benefitsGetAll(db).find(x => x.title === 'Fixture Credit D')!;
    expect(d.card_id).toBe('amex_platinum');
    expect(d.value_usd).toBe(50);
    expect(d.is_user_modified).toBe(0);
    expect(d.is_active).toBe(1);
    const avios = pointsCurrencyGetById(db, 'british_airways_avios')!;
    expect(avios.value_cents_per_point).toBe(1.2);
    expect(avios.source_name).toBe('One Mile at a Time');   // untouched
  });

  it('can clear a nullable field and reports nothing left to do afterwards', () => {
    const db = liveDb();
    const { proposal, a } = fixture(db);
    proposal.changes = [{ ...proposal.changes[0], after: { description: null, value_usd: 150 } }];
    const r = importProposalText(db, JSON.stringify(proposal));
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    expect(benefitsGetAll(db).find(x => x.id === a.id)!.description).toBeNull();
    const again = importProposalText(db, JSON.stringify(proposal));
    expect(again.state).toBe('up_to_date');
    expect(again.already_current).toBe(1);
    expect(refreshGetStatus(db).pending_run_id).toBeNull();
  });

  it('finds a renamed benefit by its new name so a second pass does not report it missing', () => {
    const db = liveDb();
    const { proposal } = fixture(db);
    proposal.changes = [{ ...proposal.changes[0], after: { title: 'Fixture Credit A (renamed)', value_usd: 150 } }];
    const r = importProposalText(db, JSON.stringify(proposal));
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    const again = diffProposal(db, validateProposal(proposal));
    expect(again.changes).toEqual([]);
    expect(again.unmatched).toEqual([]);
    expect(again.already_current).toBe(1);
  });

  it('refuses to start a second run while one is in progress', () => {
    const db = liveDb();
    const { proposal } = fixture(db);
    const first = importProposalText(db, JSON.stringify(proposal));
    const second = importProposalText(db, JSON.stringify(proposal));
    expect(second.state).toBe('draft_exists');
    expect(second.run_id).toBe(first.run_id);
    expect(refreshPendingChanges(db, first.run_id!).length).toBe(5);
  });

  it('discarding leaves every benefit untouched', () => {
    const db = liveDb();
    const { proposal } = fixture(db);
    const before = JSON.stringify(benefitsGetAll(db));
    const r = importProposalText(db, JSON.stringify(proposal));
    approveAll(db, r.run_id!);
    refreshDiscardRun(db, r.run_id!);
    expect(JSON.stringify(benefitsGetAll(db))).toBe(before);
    const s = refreshGetStatus(db);
    expect(s.pending_run_id).toBeNull();
    expect(s.unmatched).toEqual([]);
  });
});

describe('Hand-edited benefits and values', () => {
  it('skips a hand-edited benefit on a normal approval and flags it for the reviewer', () => {
    const db = liveDb();
    const { proposal, a } = fixture(db);
    benefitUpdate(db, a.id, { notes: 'my own note' });
    const r = importProposalText(db, JSON.stringify(proposal));
    const ch = refreshPendingChanges(db, r.run_id!).find(x => x.benefit_id === a.id)!;
    expect(ch.target_user_modified).toBe(1);
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    const row = benefitsGetAll(db).find(x => x.id === a.id)!;
    expect(row.value_usd).toBe(100);
    expect(row.notes).toBe('my own note');
  });

  it('replaces only the listed fields when the reviewer explicitly allows it, and keeps the row marked as hand-edited', () => {
    const db = liveDb();
    const { proposal, a } = fixture(db);
    benefitUpdate(db, a.id, { notes: 'my own note', expiration_note: 'mine' });
    const r = importProposalText(db, JSON.stringify(proposal));
    const ch = refreshPendingChanges(db, r.run_id!).find(x => x.benefit_id === a.id)!;
    const approved = refreshApproveChange(db, ch.id, undefined, true);
    expect(approved.overwrite_user_edit).toBe(1);
    refreshApplyRun(db, r.run_id!);
    const row = benefitsGetAll(db).find(x => x.id === a.id)!;
    expect(row.value_usd).toBe(150);
    expect(row.description).toBe('New A description');
    expect(row.notes).toBe('my own note');
    expect(row.expiration_note).toBe('mine');
    expect(row.is_user_modified).toBe(1);
  });

  it('withdraws overwrite consent when the row is re-approved normally or rejected', () => {
    const db = liveDb();
    const { proposal, a } = fixture(db);
    benefitUpdate(db, a.id, { notes: 'n' });
    const r = importProposalText(db, JSON.stringify(proposal));
    const ch = refreshPendingChanges(db, r.run_id!).find(x => x.benefit_id === a.id)!;
    refreshApproveChange(db, ch.id, undefined, true);
    expect(refreshApproveChange(db, ch.id).overwrite_user_edit).toBe(0);
    refreshApproveChange(db, ch.id, undefined, true);
    expect(refreshRejectChange(db, ch.id).overwrite_user_edit).toBe(0);
  });

  it('does not retire a hand-edited benefit without explicit consent', () => {
    const db = liveDb();
    const { proposal, c } = fixture(db);
    benefitUpdate(db, c.id, { notes: 'still using this' });
    const r = importProposalText(db, JSON.stringify(proposal));
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    expect(benefitsGetAll(db).find(x => x.id === c.id)!.is_active).toBe(1);

    const again = importProposalText(db, JSON.stringify(proposal));
    expect(again.state).toBe('created');
    approveAll(db, again.run_id!, true);
    refreshApplyRun(db, again.run_id!);
    expect(benefitsGetAll(db).find(x => x.id === c.id)!.is_active).toBe(0);
  });

  it('does not overwrite a hand-set point value without explicit consent', () => {
    const db = liveDb();
    const { proposal } = fixture(db);
    pointsCurrencyUpdate(db, 'british_airways_avios', { value_cents_per_point: 1.5 });
    const r = importProposalText(db, JSON.stringify(proposal));
    const ch = refreshPendingChanges(db, r.run_id!).find(x => x.points_currency_id)!;
    expect(ch.target_user_modified).toBe(1);
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    expect(pointsCurrencyGetById(db, 'british_airways_avios')!.value_cents_per_point).toBe(1.5);
  });
});

describe('Offering the refresh bundled with a release', () => {
  const proposals = (db: Database.Database): RefreshProposal[] => {
    const { proposal } = fixture(db);
    const now = validateProposal(proposal);
    const later = validateProposal({
      ...proposal, proposal_id: 'test-2027-01', title: 'January changes', not_before: '2027-01-01',
      changes: [{ scope: 'benefit', change_type: 'modified', card_id: 'amex_platinum', match_title: 'Fixture Credit B',
        after: { value_usd: 250 }, summary: 'B rises in January.', effective_date: '2027-01-01', sources: SRC }],
    });
    return [later, now];
  };

  it('creates one draft for existing data and never offers the same refresh twice', () => {
    const db = liveDb();
    const list = proposals(db);
    const now = new Date(2026, 10, 22);
    const r = offerBundledProposals(db, { proposals: list, now });
    expect(r.state).toBe('created');
    expect(r.title).toBe('Test refresh');
    expect(offerBundledProposals(db, { proposals: list, now }).state).toBe('draft_exists');

    refreshDiscardRun(db, r.run_id!);
    const afterDiscard = offerBundledProposals(db, { proposals: list, now });
    expect(afterDiscard.state).toBe('up_to_date');           // discarded = already offered
    expect(refreshGetStatus(db).pending_run_id).toBeNull();

    // …but the user can ask for it again.
    const forced = offerBundledProposals(db, { proposals: list, now, force: true });
    expect(forced.state).toBe('created');
    expect(forced.proposed).toBe(5);
  });

  it('holds back changes that are not in effect yet, then offers them on their date', () => {
    const db = liveDb();
    const list = proposals(db);
    const first = offerBundledProposals(db, { proposals: list, now: new Date(2026, 11, 31) });
    expect(first.title).toBe('Test refresh');
    approveAll(db, first.run_id!);
    refreshApplyRun(db, first.run_id!);
    expect(offerBundledProposals(db, { proposals: list, now: new Date(2026, 11, 31) }).state).toBe('up_to_date');

    const jan = offerBundledProposals(db, { proposals: list, now: new Date(2027, 0, 1) });
    expect(jan.state).toBe('created');
    expect(jan.title).toBe('January changes');
    expect(jan.proposed).toBe(1);
  });

  it('applies due refreshes directly to a brand-new database but still defers future ones', () => {
    const db = liveDb();
    const list = proposals(db);
    const r = offerBundledProposals(db, { proposals: list, now: new Date(2026, 10, 22), fresh: true });
    expect(r.state).toBe('applied');
    const all = benefitsGetAll(db);
    expect(all.find(x => x.title === 'Fixture Credit A')!.value_usd).toBe(150);
    expect(all.find(x => x.title === 'Fixture Credit B')!.value_usd).toBe(200);   // January change not applied
    expect(all.some(x => x.title === 'Fixture Credit D')).toBe(true);
    expect(refreshGetStatus(db).pending_run_id).toBeNull();
    // Reopening the same file later does not re-offer what was applied.
    expect(offerBundledProposals(db, { proposals: list, now: new Date(2026, 10, 23) }).state).toBe('up_to_date');
  });

  it('survives export and import: decisions, consent and the "already offered" marker travel with the file', () => {
    const db = liveDb();
    const { proposal, a } = fixture(db);
    benefitUpdate(db, a.id, { notes: 'n' });
    const list = [validateProposal(proposal)];
    const r = offerBundledProposals(db, { proposals: list, now: new Date(2026, 10, 22) });
    for (const ch of refreshPendingChanges(db, r.run_id!)) refreshApproveChange(db, ch.id, undefined, ch.benefit_id === a.id);

    const payload = JSON.parse(JSON.stringify(buildFilePayload(db)));
    const db2 = liveDb();
    importFilePayload(db2, payload);
    const s = refreshGetStatus(db2);
    expect(s.pending_run_id).not.toBeNull();
    const imported = refreshPendingChanges(db2, s.pending_run_id!);
    expect(imported.length).toBe(5);
    expect(imported.find(ch => ch.points_currency_id)!.points_currency_id).toBe('british_airways_avios');
    expect(imported.filter(ch => ch.overwrite_user_edit === 1).length).toBe(1);
    expect(offerBundledProposals(db2, { proposals: list, now: new Date(2026, 10, 22) }).state).toBe('draft_exists');
    refreshApplyRun(db2, s.pending_run_id!);
    expect(benefitsGetAll(db2).find(x => x.title === 'Fixture Credit A')!.value_usd).toBe(150);
    expect(offerBundledProposals(db2, { proposals: list, now: new Date(2026, 10, 22) }).state).toBe('up_to_date');
  });

  it('upgrades a refresh table created by an older version', () => {
    const db = liveDb();
    db.exec(`DROP TABLE refresh_changes`);
    db.exec(`CREATE TABLE refresh_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, refresh_run_id INTEGER NOT NULL,
      change_type TEXT NOT NULL, card_id TEXT, program_id TEXT, benefit_id INTEGER,
      before_json TEXT, after_json TEXT, review_status TEXT NOT NULL DEFAULT 'pending',
      review_notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    ensureRefreshSchema(db);
    ensureRefreshSchema(db);   // idempotent
    const { proposal } = fixture(db);
    const r = importProposalText(db, JSON.stringify(proposal));
    expect(r.state).toBe('created');
    approveAll(db, r.run_id!);
    expect(refreshApplyRun(db, r.run_id!).applied).toBe(5);
  });
});

describe('The refresh bundled with this release', () => {
  it('ships at least one proposal and every one passes validation unchanged', () => {
    expect(BUNDLED_REFRESH_PROPOSALS.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const p of BUNDLED_REFRESH_PROPOSALS) {
      const clean = validateProposal(JSON.parse(JSON.stringify(p)));
      expect(clean.changes.length).toBe(p.changes.length);
      expect(ids.has(p.proposal_id)).toBe(false);
      ids.add(p.proposal_id);
      for (const c of p.changes) {
        expect(c.sources.length).toBeGreaterThan(0);
        expect(c.summary.length).toBeGreaterThan(10);
      }
    }
  });

  it('is generated from the JSON files in refresh-proposals/ (run scripts/build-refresh-proposals.mjs)', () => {
    const dir = path.join(__dirname, '..', 'refresh-proposals');
    const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
      .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(BUNDLED_REFRESH_PROPOSALS).toEqual(onDisk);
  });

  it('keeps dollar credits trackable and every link on https', () => {
    for (const p of BUNDLED_REFRESH_PROPOSALS) {
      for (const c of p.changes) {
        for (const s of c.sources) expect(s.url.startsWith('https://')).toBe(true);
        if (c.scope !== 'benefit' || c.change_type !== 'added') continue;
        const a = c.after as Record<string, unknown>;
        // An added credit with a dollar value needs a use count, or the dashboard cannot track it.
        if (typeof a.value_usd === 'number' && a.value_usd > 0 && a.reset_cadence !== 'unlimited') {
          expect(a.uses_per_period, `${a.title}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('matches every change to the catalog of a fully migrated install', () => {
    const db = liveDb();
    for (const p of [...BUNDLED_REFRESH_PROPOSALS].sort((a, b) => (a.not_before ?? '').localeCompare(b.not_before ?? ''))) {
      const d = diffProposal(db, p);
      expect(d.unmatched.map(u => `${u.owner_id}: ${u.title}`)).toEqual([]);
      expect(d.changes.length).toBe(p.changes.length);   // nothing in it is a no-op
      const r = createRunFromProposal(db, p);
      approveAll(db, r.run_id!);
      expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: p.changes.length, skipped: 0 });
      expect(diffProposal(db, p).changes).toEqual([]);   // applying it leaves nothing to propose
    }
  });

  it('leaves a new install with the refreshed catalog and nothing pending', () => {
    const db = liveDb();
    const due = BUNDLED_REFRESH_PROPOSALS.filter(p => !p.not_before);
    const r = offerBundledProposals(db, { fresh: true, now: new Date(2026, 10, 22) });
    if (due.length) expect(r.state).toBe('applied');
    expect(refreshGetStatus(db).pending_run_id).toBeNull();
    for (const p of due) expect(diffProposal(db, p).changes).toEqual([]);
    // No two active benefits on the same card/program share a title.
    const dup = db.prepare(`SELECT card_id, program_id, lower(title) t, COUNT(*) n FROM benefits WHERE is_active = 1
      GROUP BY card_id, program_id, lower(title) HAVING n > 1`).all();
    expect(dup).toEqual([]);
  });
});

describe('A refresh that adds a loyalty program (v1.0.27)', () => {
  const GATE = '20 Qualifying Nights - Milestone Reward unlocked';
  function programProposal(): RefreshProposal {
    return validateProposal({
      format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'test-new-program',
      title: 'New program', prepared_on: '2026-11-23',
      changes: [
        // Deliberately listed before the program row: order in the file must not matter.
        { scope: 'benefit', change_type: 'added', program_id: 'test_hotel_status',
          after: { title: GATE, category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 0, sort_order: 10 },
          summary: 'Milestone gate.', sources: SRC },
        { scope: 'program', change_type: 'added', program_id: 'test_hotel_status',
          after: { name: 'Test Hotel Status', program_type: 'hotel_elite_status', source_url: 'https://example.com/program', notes: 'Program notes' },
          summary: 'Adds the program.', sources: SRC },
        { scope: 'benefit', change_type: 'added', program_id: 'test_hotel_status',
          after: { title: '20 Nights Choice - 2 Club Access Awards', category: 'lounge_access', reset_cadence: 'annual',
            uses_per_period: 2, value_usd: 0, sort_order: 20, is_choice_option: 1, prerequisite_benefit_title: GATE },
          summary: 'Choice option.', sources: SRC },
      ],
    });
  }
  const programIds = (db: Database.Database) => (db.prepare('SELECT id FROM programs ORDER BY id').all() as { id: string }[]).map(r => r.id);
  const rowsFor = (db: Database.Database) => benefitsGetAll(db).filter(b => b.program_id === 'test_hotel_status');

  it('validates the program row strictly', () => {
    const base = { format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'test-program-validate', title: 'Program validation', prepared_on: '2026-11-23' };
    const row = (over: Record<string, unknown>) => ({ ...base, changes: [{
      scope: 'program', change_type: 'added', program_id: 'new_prog',
      after: { name: 'New', program_type: 'hotel_elite_status' }, summary: 's', sources: SRC, ...over }] });
    expect(validateProposal(row({})).changes[0]).toMatchObject({ scope: 'program', program_id: 'new_prog', card_id: null });
    expect(() => validateProposal(row({ change_type: 'removed' }))).toThrow(/only "added"/);
    expect(() => validateProposal(row({ change_type: 'modified' }))).toThrow(/only "added"/);
    expect(() => validateProposal(row({ program_id: undefined }))).toThrow();
    expect(() => validateProposal(row({ program_id: 'bad id; DROP' }))).toThrow();
    expect(() => validateProposal(row({ after: { name: 'New' } }))).toThrow(/program_type is required/);
    expect(() => validateProposal(row({ after: { program_type: 'hotel_elite_status' } }))).toThrow(/name is required/);
    expect(() => validateProposal(row({ after: { name: 'New', program_type: 'casino' } }))).toThrow();
    expect(() => validateProposal(row({ after: { name: 'New', program_type: 'hotel_elite_status', source_url: 'http://example.com' } }))).toThrow();
    expect(() => validateProposal(row({ after: { name: 'New', program_type: 'hotel_elite_status', is_active: 0 } }))).toThrow();
  });

  it('proposes the program with its benefits and adds nothing until it is applied', () => {
    const db = liveDb();
    const before = { programs: programIds(db), benefits: benefitsGetAll(db).length };
    const r = createRunFromProposal(db, programProposal());
    expect(r).toMatchObject({ state: 'created', proposed: 3, unmatched: [] });
    expect(programIds(db)).toEqual(before.programs);
    expect(benefitsGetAll(db).length).toBe(before.benefits);

    approveAll(db, r.run_id!);
    expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: 3, skipped: 0 });
    const prog = db.prepare('SELECT * FROM programs WHERE id = ?').get('test_hotel_status') as Record<string, unknown>;
    expect(prog).toMatchObject({ name: 'Test Hotel Status', program_type: 'hotel_elite_status', source_url: 'https://example.com/program', notes: 'Program notes', is_active: 1 });
    const rows = rowsFor(db);
    expect(rows.map(b => b.title).sort()).toEqual(['20 Nights Choice - 2 Club Access Awards', GATE].sort());
    const gate = rows.find(b => b.title === GATE)!;
    const option = rows.find(b => b.is_choice_option === 1)!;
    expect(option.prerequisite_benefit_id).toBe(gate.id);
    expect(rows.every(b => b.is_user_modified === 0)).toBe(true);
    // Nothing else changed, and a second pass has nothing left to propose.
    expect(benefitsGetAll(db).length).toBe(before.benefits + 2);
    expect(diffProposal(db, programProposal()).changes).toEqual([]);
  });

  it('leaves the benefits out when the program itself is rejected or undecided', () => {
    for (const decision of ['reject', 'leave'] as const) {
      const db = liveDb();
      const before = { programs: programIds(db), benefits: benefitsGetAll(db).length };
      const r = createRunFromProposal(db, programProposal());
      for (const c of refreshPendingChanges(db, r.run_id!)) {
        const isProgram = JSON.parse(c.after_json!)._meta.scope === 'program';
        if (!isProgram) refreshApproveChange(db, c.id);
        else if (decision === 'reject') refreshRejectChange(db, c.id);
      }
      expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: 0, skipped: 3 });
      expect(programIds(db)).toEqual(before.programs);
      expect(benefitsGetAll(db).length).toBe(before.benefits);
      expect(db.prepare('SELECT COUNT(*) n FROM benefits WHERE program_id = ?').get('test_hotel_status')).toEqual({ n: 0 });
    }
  });

  it('adds only the approved benefits when the program is approved', () => {
    const db = liveDb();
    const r = createRunFromProposal(db, programProposal());
    for (const c of refreshPendingChanges(db, r.run_id!)) {
      const a = JSON.parse(c.after_json!);
      if (a.is_choice_option === 1) refreshRejectChange(db, c.id); else refreshApproveChange(db, c.id);
    }
    expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: 2, skipped: 1 });
    expect(rowsFor(db).map(b => b.title)).toEqual([GATE]);
  });

  it('does not propose a program that is already in the file, only its missing benefits', () => {
    const db = liveDb();
    db.prepare(`INSERT INTO programs (id, name, program_type) VALUES ('test_hotel_status', 'My own name', 'hotel')`).run();
    benefitCreate(db, { card_id: null, program_id: 'test_hotel_status', title: GATE, category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 0 }, false);
    const d = diffProposal(db, programProposal());
    expect(d.already_current).toBe(2);
    expect(d.changes.map(c => JSON.parse(c.after_json!).title)).toEqual(['20 Nights Choice - 2 Club Access Awards']);
    const r = createRunFromProposal(db, programProposal());
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    expect(db.prepare('SELECT name, program_type FROM programs WHERE id = ?').get('test_hotel_status')).toEqual({ name: 'My own name', program_type: 'hotel' });
  });

  it('still reports benefits for a program that nobody proposes as unmatched', () => {
    const db = liveDb();
    const p = programProposal();
    const d = diffProposal(db, { ...p, changes: p.changes.filter(c => c.scope !== 'program') });
    expect(d.changes).toEqual([]);
    expect(d.unmatched.map(u => u.reason)).toEqual(['This program is not in your file.', 'This program is not in your file.']);
  });

  it('is applied directly on a brand-new database and is not re-offered after the user deletes the program', () => {
    const db = liveDb();
    const opts = { proposals: [programProposal()], now: new Date(2026, 10, 23) };
    expect(offerBundledProposals(db, { ...opts, fresh: true }).state).toBe('applied');
    expect(rowsFor(db)).toHaveLength(2);
    db.prepare('DELETE FROM benefits WHERE program_id = ?').run('test_hotel_status');
    db.prepare('DELETE FROM programs WHERE id = ?').run('test_hotel_status');
    expect(offerBundledProposals(db, opts).state).toBe('up_to_date');   // automatic check: already offered
    expect(programIds(db)).not.toContain('test_hotel_status');
    // A manual "Check for benefit changes" may offer it again, as a draft to review.
    expect(offerBundledProposals(db, { ...opts, force: true })).toMatchObject({ state: 'created', proposed: 3 });
    expect(programIds(db)).not.toContain('test_hotel_status');
  });

  it('carries a half-reviewed program refresh through export and import', () => {
    const db = liveDb();
    const r = createRunFromProposal(db, programProposal());
    approveAll(db, r.run_id!);
    const payload = JSON.parse(JSON.stringify(buildFilePayload(db)));
    const db2 = liveDb();
    importFilePayload(db2, payload);
    const run = refreshGetStatus(db2).pending_run_id!;
    expect(refreshApplyRun(db2, run)).toEqual({ applied: 3, skipped: 0 });
    expect(rowsFor(db2)).toHaveLength(2);
  });

  // A later chart can put a new first level in front of an existing one.
  const NEW_FIRST = '10 Qualifying Nights - Milestone Reward unlocked';
  function moveProposal(withParent = true, parent = NEW_FIRST): RefreshProposal {
    return validateProposal({
      format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'test-move-gate', title: 'New first level', prepared_on: '2026-11-23',
      changes: [
        // The move is listed before the row it points at: order in the file must not matter.
        { scope: 'benefit', change_type: 'modified', program_id: 'test_hotel_status', match_title: GATE,
          after: { prerequisite_benefit_title: parent }, summary: 'Now follows the 10-night level.', sources: SRC },
        ...(withParent ? [{ scope: 'benefit', change_type: 'added', program_id: 'test_hotel_status',
          after: { title: NEW_FIRST, category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 0, sort_order: 5 },
          summary: 'New first level.', sources: SRC }] : []),
      ],
    });
  }
  function withProgram(): Database.Database {
    const db = liveDb();
    const r = createRunFromProposal(db, programProposal());
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    return db;
  }
  const gateRow = (db: Database.Database) => rowsFor(db).find(b => b.title === GATE)!;

  it('can move an existing row under a row added by the same refresh, keeping its identity and history', () => {
    const db = withProgram();
    const before = gateRow(db);
    usageCreate(db, { benefit_id: before.id, used_on: '2026-12-01', notes: 'reached 20 nights' });
    const d = diffProposal(db, moveProposal());
    const move = d.changes.find(c => c.change_type === 'modified')!;
    expect(JSON.parse(move.before_json!)).toMatchObject({ prerequisite_benefit_title: null });
    expect(JSON.parse(move.after_json!).prerequisite_benefit_title).toBe(NEW_FIRST);

    const r = createRunFromProposal(db, moveProposal());
    expect(gateRow(db).prerequisite_benefit_id).toBeNull();          // nothing moves before approval
    approveAll(db, r.run_id!);
    expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: 2, skipped: 0 });
    const first = rowsFor(db).find(b => b.title === NEW_FIRST)!;
    const after = gateRow(db);
    expect(after.id).toBe(before.id);
    expect(after.prerequisite_benefit_id).toBe(first.id);
    expect(after.is_user_modified).toBe(0);
    expect(after.description).toBe(before.description);
    expect(usagesForBenefit(db, before.id)).toHaveLength(1);
    // The option under the moved row still hangs off it, and nothing is left to propose.
    expect(rowsFor(db).find(b => b.is_choice_option === 1)!.prerequisite_benefit_id).toBe(before.id);
    expect(diffProposal(db, moveProposal()).changes).toEqual([]);
  });

  it('leaves the row where it is when the row it should follow was rejected or does not exist', () => {
    const db = withProgram();
    const r = createRunFromProposal(db, moveProposal());
    for (const c of refreshPendingChanges(db, r.run_id!)) {
      if (c.change_type === 'added') refreshRejectChange(db, c.id); else refreshApproveChange(db, c.id);
    }
    refreshApplyRun(db, r.run_id!);
    expect(gateRow(db).prerequisite_benefit_id).toBeNull();
    expect(rowsFor(db).some(b => b.title === NEW_FIRST)).toBe(false);

    const db2 = withProgram();
    const r2 = createRunFromProposal(db2, moveProposal(false));
    approveAll(db2, r2.run_id!);
    refreshApplyRun(db2, r2.run_id!);
    expect(gateRow(db2).prerequisite_benefit_id).toBeNull();
  });

  it('never links a row to itself, into a loop, or to a row on another card or program', () => {
    const db = withProgram();
    const option = '20 Nights Choice - 2 Club Access Awards';
    // The option already depends on the gate; asking the gate to follow the option would make a loop.
    for (const parent of [GATE, option]) {
      const r = createRunFromProposal(db, moveProposal(false, parent));
      approveAll(db, r.run_id!);
      refreshApplyRun(db, r.run_id!);
      expect(gateRow(db).prerequisite_benefit_id).toBeNull();
    }
    // A row with the same title on a different program is not a valid parent.
    db.prepare(`INSERT INTO programs (id, name, program_type) VALUES ('other_prog', 'Other', 'hotel')`).run();
    benefitCreate(db, { card_id: null, program_id: 'other_prog', title: NEW_FIRST, category: 'other', reset_cadence: 'annual', uses_per_period: 1, value_usd: 0 }, false);
    const r = createRunFromProposal(db, moveProposal(false));
    approveAll(db, r.run_id!);
    refreshApplyRun(db, r.run_id!);
    expect(gateRow(db).prerequisite_benefit_id).toBeNull();
  });

  it('does not move a hand-edited row without consent, and only accepts a real title for the move', () => {
    const db = withProgram();
    benefitUpdate(db, gateRow(db).id, { notes: 'my own note' });
    const r = createRunFromProposal(db, moveProposal());
    approveAll(db, r.run_id!);
    expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: 1, skipped: 1 });
    expect(gateRow(db).prerequisite_benefit_id).toBeNull();
    expect(gateRow(db).notes).toBe('my own note');

    const bad = (after: Record<string, unknown>) => () => validateProposal({
      format: PROPOSAL_FORMAT, format_version: 1, proposal_id: 'test-bad-move', title: 't', prepared_on: '2026-11-23',
      changes: [{ scope: 'benefit', change_type: 'modified', program_id: 'test_hotel_status', match_title: GATE, after, summary: 's', sources: SRC }] });
    expect(bad({ prerequisite_benefit_title: null })).toThrow();
    expect(bad({ prerequisite_benefit_title: 7 })).toThrow();
    expect(bad({ prerequisite_benefit_id: 7 })).toThrow();
    expect(bad({ sort_order: 3 })).toThrow();
    expect(bad({ is_choice_option: 1 })).toThrow();
  });
});

describe('The World of Hyatt program refresh bundled with v1.0.27', () => {
  const HYATT = BUNDLED_REFRESH_PROPOSALS.find(p => p.proposal_id === '2026-11-23-world-of-hyatt-program')!;
  const HYATT_2027 = BUNDLED_REFRESH_PROPOSALS.find(p => p.proposal_id === '2027-01-01-world-of-hyatt-milestones')!;
  const hyattRows = (db: Database.Database) => benefitsGetAll(db).filter(b => b.program_id === 'hyatt_status');
  const active = (db: Database.Database) => hyattRows(db).filter(b => b.is_active === 1);
  const hasProgram = (db: Database.Database) => !!db.prepare(`SELECT 1 FROM programs WHERE id = 'hyatt_status'`).get();
  function applyAll(db: Database.Database, p: RefreshProposal) {
    const r = createRunFromProposal(db, p);
    expect(r.state).toBe('created');
    approveAll(db, r.run_id!);
    return { r, result: refreshApplyRun(db, r.run_id!) };
  }

  it('proposes the program first and all of its benefits, and changes nothing until approved', () => {
    expect(HYATT.changes[0]).toMatchObject({ scope: 'program', change_type: 'added', program_id: 'hyatt_status' });
    expect(HYATT.changes.slice(1).every(c => c.scope === 'benefit' && c.change_type === 'added' && c.program_id === 'hyatt_status')).toBe(true);
    const db = liveDb();
    const before = { benefits: benefitsGetAll(db).length, card: benefitsGetAll(db).filter(b => b.card_id === 'hyatt').length };
    expect(hasProgram(db)).toBe(false);
    const r = createRunFromProposal(db, HYATT);
    expect(r).toMatchObject({ state: 'created', proposed: HYATT.changes.length, unmatched: [] });
    expect(hasProgram(db)).toBe(false);
    expect(benefitsGetAll(db).length).toBe(before.benefits);

    approveAll(db, r.run_id!);
    expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: HYATT.changes.length, skipped: 0 });
    expect(db.prepare(`SELECT name, program_type, is_active FROM programs WHERE id = 'hyatt_status'`).get())
      .toEqual({ name: 'World of Hyatt Elite Status & Milestone Rewards', program_type: 'hotel_elite_status', is_active: 1 });
    expect(hyattRows(db)).toHaveLength(HYATT.changes.length - 1);
    // The World of Hyatt Credit Card keeps its own benefits; nothing is copied or moved.
    expect(benefitsGetAll(db).filter(b => b.card_id === 'hyatt').length).toBe(before.card);
    expect(benefitsGetAll(db).length).toBe(before.benefits + HYATT.changes.length - 1);
  });

  it('builds a milestone ladder the dashboard can gate: every reward hangs off its level', () => {
    const db = liveDb();
    applyAll(db, HYATT);
    const rows = hyattRows(db);
    const byId = new Map(rows.map(b => [b.id, b]));
    const gates = rows.filter(isMilestone);
    expect(gates.map(g => Number(g.title.split(' ')[0]))).toEqual([20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
    expect(gates.every(g => g.uses_per_period === 1)).toBe(true);
    // Each level after the first unlocks only once the level below is logged.
    for (const g of gates.slice(1)) {
      expect(byId.get(g.prerequisite_benefit_id!)!.title.startsWith(`${Number(g.title.split(' ')[0]) - 10} Qualifying Nights`)).toBe(true);
    }
    expect(gates[0].prerequisite_benefit_id).toBeNull();
    // Every proposed prerequisite resolved to a real row, and rewards point at their own level.
    for (const c of HYATT.changes.slice(1)) {
      const a = c.after as Record<string, unknown>;
      const row = rows.find(b => b.title === a.title)!;
      if (a.prerequisite_benefit_title) expect(byId.get(row.prerequisite_benefit_id!)!.title).toBe(a.prerequisite_benefit_title);
      else expect(row.prerequisite_benefit_id).toBeNull();
    }
    const rewards = rows.filter(b => /^\d+ Nights (Choice )?- /.test(b.title));
    expect(rewards.length).toBeGreaterThan(50);
    for (const b of rewards) {
      const gate = byId.get(b.prerequisite_benefit_id!)!;
      expect(isMilestone(gate)).toBe(true);
      expect(gate.title.split(' ')[0]).toBe(b.title.split(' ')[0]);
      expect(b.is_choice_option).toBe(b.title.includes(' Choice - ') ? 1 : 0);
      expect(b.uses_per_period).toBeGreaterThan(0);
    }
    // Nothing lands on the Bonus Categories tab, and sort numbers are unique so the order is stable.
    expect(rows.some(b => b.category === 'earning_multiplier')).toBe(false);
    expect(new Set(rows.map(b => b.sort_order)).size).toBe(rows.length);
    expect(rows.every(b => b.is_user_modified === 0 && (b.source_url ?? '').startsWith('https://'))).toBe(true);
  });

  it('adds nothing when the program row is rejected, and does not ask again on its own', () => {
    const db = liveDb();
    const before = benefitsGetAll(db).length;
    const opts = { proposals: [HYATT, HYATT_2027], now: new Date(2027, 0, 5) };
    const r = offerBundledProposals(db, opts);
    expect(r).toMatchObject({ state: 'created', proposed: HYATT.changes.length });
    for (const c of refreshPendingChanges(db, r.run_id!)) {
      if (JSON.parse(c.after_json!)._meta.scope === 'program') refreshRejectChange(db, c.id); else refreshApproveChange(db, c.id);
    }
    expect(refreshApplyRun(db, r.run_id!)).toEqual({ applied: 0, skipped: HYATT.changes.length });
    expect(hasProgram(db)).toBe(false);
    expect(benefitsGetAll(db).length).toBe(before);
    // The 2027 chart has nothing to attach to, so no further draft appears.
    const next = offerBundledProposals(db, opts);
    expect(next.state).toBe('up_to_date');
    expect(next.unmatched.length).toBe(HYATT_2027.changes.length);
    expect(refreshGetStatus(db).pending_run_id).toBeNull();
  });

  it('holds the 2027 chart until January 1, 2027, then offers it after the program is in place', () => {
    const db = liveDb();
    const proposals = [HYATT, HYATT_2027];
    const first = offerBundledProposals(db, { proposals, now: new Date(2026, 10, 23) });
    approveAll(db, first.run_id!);
    refreshApplyRun(db, first.run_id!);
    expect(offerBundledProposals(db, { proposals, now: new Date(2026, 11, 31) }).state).toBe('up_to_date');
    const second = offerBundledProposals(db, { proposals, now: new Date(2027, 0, 1) });
    expect(second).toMatchObject({ state: 'created', proposed: HYATT_2027.changes.length, unmatched: [] });
  });

  it('turns the 2026 rows into the 2027 chart: old options retired, new ones under the right level', () => {
    const db = liveDb();
    applyAll(db, HYATT);
    const usedGate = hyattRows(db).find(b => b.title.startsWith('20 Qualifying Nights'))!;
    const usedOption = hyattRows(db).find(b => b.title === '20 Nights Choice - $25 FIND Experience Credit')!;
    usageCreate(db, { benefit_id: usedGate.id, used_on: '2026-12-01', notes: 'reached 20 nights' });
    usageCreate(db, { benefit_id: usedOption.id, used_on: '2026-12-05', amount_usd: 25, notes: 'tour' });
    const { result } = applyAll(db, HYATT_2027);
    expect(result).toEqual({ applied: HYATT_2027.changes.length, skipped: 0 });

    const now = active(db);
    const titles = now.map(b => b.title);
    const removed = HYATT_2027.changes.filter(c => c.change_type === 'removed').length;
    const added = HYATT_2027.changes.filter(c => c.change_type === 'added').length;
    expect(now.length).toBe(HYATT.changes.length - 1 - removed + added);
    expect(titles.some(t => /American Airlines|AAdvantage/.test(t))).toBe(false);
    expect(titles.filter(t => t.includes('FIND'))).toEqual(['10 Nights Choice - $25 FIND Experience Credit']);
    expect(titles.some(t => /\(automatic\)/.test(t) && !/Guest of Honor/.test(t))).toBe(false);
    const gates = now.filter(isMilestone);
    expect(gates.map(g => Number(g.title.split(' ')[0])).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]);
    const byId = new Map(hyattRows(db).map(b => [b.id, b]));
    for (const b of now.filter(x => /^\d+ Nights (Choice )?- /.test(x.title))) {
      const gate = byId.get(b.prerequisite_benefit_id!)!;
      expect(gate.is_active).toBe(1);
      expect(gate.title.split(' ')[0]).toBe(b.title.split(' ')[0]);
    }
    // The ladder is one chain again: 10 nights is the only root and each level follows the one before it.
    for (const g of gates) {
      const n = Number(g.title.split(' ')[0]);
      if (n === 10) expect(g.prerequisite_benefit_id).toBeNull();
      else expect(byId.get(g.prerequisite_benefit_id!)!.title.startsWith(`${n - 10} Qualifying Nights`)).toBe(true);
    }
    expect(hyattRows(db).find(b => b.title.startsWith('20 Qualifying Nights'))!.id).toBe(usedGate.id);
    // Within a level the rows keep a stable, unique order.
    expect(new Set(now.map(b => b.sort_order)).size).toBe(now.length);
    const level = (n: number) => now.filter(b => b.title.startsWith(`${n} Nights`)).sort((a, b) => a.sort_order - b.sort_order).map(b => b.title.replace(/^\d+ Nights (Choice )?- /, ''));
    expect(level(60)).toEqual(['2 Guest of Honor Awards (automatic)', '2 Category 1-4 Free Night Awards', 'Category 1-7 Free Night Award',
      '7,500 Bonus Points', 'Free Parking Award', '$100 Delta Air Lines eCertificate', '2 Suite Upgrade Awards', 'My Hyatt Concierge']);
    expect(level(10)).toEqual(['Tier-Qualifying Night Credit', '$25 FIND Experience Credit', '$30 Inclusive Collection Spa Credit']);
    // Retired rows keep their history, and usage on surviving rows is untouched.
    expect(hyattRows(db).find(b => b.id === usedOption.id)!.is_active).toBe(0);
    expect(usagesForBenefit(db, usedOption.id)).toHaveLength(1);
    expect(usagesForBenefit(db, usedGate.id)).toHaveLength(1);
    // A second look finds nothing left to do.
    expect(diffProposal(db, HYATT_2027).changes).toEqual([]);
  });

  it('leaves a hand-edited Hyatt row alone in 2027 unless replacing it is approved', () => {
    const db = liveDb();
    applyAll(db, HYATT);
    const row = hyattRows(db).find(b => b.title === '40 Nights - Guest of Honor Award (automatic)')!;
    benefitUpdate(db, row.id, { notes: 'gave this one to Sam' });
    const { result } = applyAll(db, HYATT_2027);
    expect(result).toEqual({ applied: HYATT_2027.changes.length - 1, skipped: 1 });
    const after = hyattRows(db).find(b => b.id === row.id)!;
    expect(after.notes).toBe('gave this one to Sam');
    expect(after.expiration_note).toBe(row.expiration_note);
  });

  it('gives a brand-new file the program, on the chart that applies on the day it is created', () => {
    const y2026 = liveDb();
    expect(offerBundledProposals(y2026, { fresh: true, now: new Date(2026, 10, 23) }).state).toBe('applied');
    expect(active(y2026)).toHaveLength(HYATT.changes.length - 1);
    expect(active(y2026).some(b => b.title.startsWith('10 Qualifying Nights'))).toBe(false);
    expect(refreshGetStatus(y2026).pending_run_id).toBeNull();

    const y2027 = liveDb();
    expect(offerBundledProposals(y2027, { fresh: true, now: new Date(2027, 0, 2) }).state).toBe('applied');
    expect(active(y2027).some(b => b.title.startsWith('10 Qualifying Nights'))).toBe(true);
    expect(active(y2027).some(b => /American Airlines|AAdvantage/.test(b.title))).toBe(false);
    expect(active(y2027).filter(b => isMilestone(b) && b.prerequisite_benefit_id === null).map(b => b.title.split(' ')[0])).toEqual(['10']);
  });
});
