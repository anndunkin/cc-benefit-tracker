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
} from '../electron/database';
import {
  validateProposal, diffProposal, createRunFromProposal, offerBundledProposals,
  importProposalText, MAX_PROPOSAL_BYTES, PROPOSAL_FORMAT,
} from '../electron/refreshProposal';
import { BUNDLED_REFRESH_PROPOSALS } from '../electron/refreshProposalData';
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
