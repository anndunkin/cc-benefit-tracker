import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { seededDb, emptyDb } from './helpers';
import {
  applyDataMigrations, benefitCreate, benefitGetById, benefitsGetAll, benefitUpdate,
  benefitGetChoices, benefitSetChoices, buildFilePayload, importFilePayload,
  computeProjections, usageCreate, usageUpdate, usagesForBenefit,
} from '../electron/database';
import { isDiamondChoices, isMilestone, tracksEarnedNights, valueAtDate } from '../electron/benefitRules';

let db: Database.Database;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T16:00:00Z'));
  db = seededDb(); applyDataMigrations(db);
});
afterEach(() => { db.close(); vi.useRealTimers(); });
const find = (fn: Parameters<ReturnType<typeof benefitsGetAll>['find']>[0]) => benefitsGetAll(db).find(fn)!;
const project = (id: number, year = 2026) => computeProjections(db, year).find(p => p.benefit.id === id)!;

describe('v1.0.20 benefit controls and persistence', () => {
  it('hides and unhides without changing usage or marking benefit terms user-modified', () => {
    const b = find(b => b.card_id === 'hyatt_visa' && b.title.startsWith('Annual'));
    usageCreate(db, { benefit_id: b.id, used_on: '2026-05-10' });
    benefitUpdate(db, b.id, { is_hidden: 1 });
    expect(project(b.id).benefit.is_hidden).toBe(1);
    expect(benefitGetById(db, b.id)?.is_user_modified).toBe(0);
    expect(project(b.id).uses_count).toBe(1);
    benefitUpdate(db, b.id, { is_hidden: 0 });
    expect(project(b.id).benefit.is_hidden).toBe(0);
  });
  it.each(['hyatt_visa', 'marriott_business'])('sets and clears %s certificate expiry without recording usage', card => {
    const b = find(b => b.card_id === card && b.title.startsWith('Annual'));
    benefitUpdate(db, b.id, { expiration_date: '2027-06-30' });
    applyDataMigrations(db);
    expect(benefitGetById(db, b.id)?.expiration_date).toBe('2027-06-30');
    expect(usagesForBenefit(db, b.id)).toHaveLength(0);
    benefitUpdate(db, b.id, { expiration_date: null });
    expect(benefitGetById(db, b.id)?.expiration_date).toBeNull();
  });
  it.each(['2027-02-30', '2026-13-01', 'bad', "2026-01-01'; DROP TABLE cards;--"])('rejects invalid certificate date %s', date => {
    expect(() => benefitUpdate(db, find(b => b.category === 'free_night').id, { expiration_date: date })).toThrow();
  });
  it('saves certificate expiry and usage atomically and rolls back an invalid date', () => {
    const b = find(b => b.card_id === 'hyatt_visa' && b.title.startsWith('Annual'));
    expect(() => usageCreate(db, { benefit_id: b.id, used_on: '2026-09-01', expiration_date: '2027-02-30' })).toThrow();
    expect(usagesForBenefit(db, b.id)).toHaveLength(0);
    usageCreate(db, { benefit_id: b.id, used_on: '2026-09-01', expiration_date: '2027-02-28' });
    expect(benefitGetById(db, b.id)?.expiration_date).toBe('2027-02-28');
    expect(usagesForBenefit(db, b.id)).toHaveLength(1);
  });
  it('sums quantities, not rows, for uncapped Marriott nights; other benefits retain their accounting', () => {
    const b = find(tracksEarnedNights);
    const u = usageCreate(db, { benefit_id: b.id, used_on: '2026-09-01', quantity: 6 });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-09-02', quantity: 4 });
    usageCreate(db, { benefit_id: b.id, used_on: '2025-09-02', quantity: 7 });
    expect(project(b.id).uses_count).toBe(10);
    expect(project(b.id).uses_max).toBeNull();
    expect(project(b.id).period_history[0].uses_count).toBe(10);
    usageUpdate(db, u.id, { quantity: 8 });
    expect(project(b.id).uses_count).toBe(12);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1000001, '4'])('rejects invalid quantity %s at the database boundary', quantity => {
    expect(() => usageCreate(db, { benefit_id: find(tracksEarnedNights).id, used_on: '2026-09-01', quantity: quantity as number })).toThrow();
  });
  it('accepts boundary quantity and legacy one-night entries', () => {
    const b = find(tracksEarnedNights);
    usageCreate(db, { benefit_id: b.id, used_on: '2026-09-01' });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-09-02', quantity: 1000000 });
    expect(project(b.id).uses_count).toBe(1000001);
  });
  it('uses $10 before September and $15 after, without retroactively inflating 2026', () => {
    const b = find(b => b.card_id === 'aa_executive' && b.title.includes('Lyft'));
    expect(valueAtDate(b, '2026-08-31')).toBe(10);
    expect(valueAtDate(b, '2026-09-01')).toBe(15);
    usageCreate(db, { benefit_id: b.id, used_on: '2026-08-10' });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-09-10' });
    const p = project(b.id);
    expect(p.annual_value_usd).toBe(140);
    expect(p.annual_value_used_usd).toBe(25);
    expect(p.period_history[7].value_used_usd).toBe(10);
    expect(p.period_history[8].value_used_usd).toBe(15);
    expect(project(b.id, 2025).annual_value_usd).toBe(120);
    expect(project(b.id, 2027).annual_value_usd).toBe(180);
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    expect(project(b.id).benefit.value_usd).toBe(10);
  });
  it('merges Platinum duplicate logs and notes, preserves edited fields and runs once', () => {
    const original = find(b => b.card_id === 'amex_platinum' && b.title.startsWith('Unlimited'));
    benefitUpdate(db, original.id, { expiration_date: '2027-01-31', notes: 'Keep my note' });
    const duplicate = benefitCreate(db, { card_id: 'amex_platinum', title: 'Unlimited Skyclub Access', reset_cadence: 'spend_threshold', category: 'lounge_access', notes: 'Older note' });
    const u = usageCreate(db, { benefit_id: duplicate.id, used_on: '2026-08-01', amount_usd: 5000 });
    db.prepare("UPDATE app_meta SET value='1.0.19' WHERE key='seed_version'").run();
    applyDataMigrations(db);
    expect(benefitGetById(db, duplicate.id)).toBeNull();
    expect(usagesForBenefit(db, original.id).find(x => x.id === u.id)?.amount_usd).toBe(5000);
    expect(benefitGetById(db, original.id)?.expiration_date).toBe('2027-01-31');
    expect(benefitGetById(db, original.id)?.notes).toContain('Older note');
    expect(applyDataMigrations(db).migrations_run).toEqual([]);
  });
  it('retires the MQD reference without deleting its records', () => {
    const b = find(b => b.title === 'Medallion Tier MQD Requirements');
    expect(b.is_active).toBe(0);
    expect(project(b.id)).toBeUndefined();
  });
});

describe('milestones and Diamond choices', () => {
  it('requires one achievement, not one usage per reward, for AA, Marriott and Delta', () => {
    const milestones = benefitsGetAll(db).filter(isMilestone);
    expect(new Set(milestones.map(b => b.program_id)).size).toBe(3);
    for (const b of milestones) {
      usageCreate(db, { benefit_id: b.id, used_on: '2026-09-01' });
      expect(project(b.id).uses_max).toBe(1);
      expect(project(b.id).uses_count).toBe(1);
    }
    expect(isMilestone(find(b => b.is_choice_option === 1))).toBe(false);
  });
  it('accepts three choice inputs separately from one Diamond toggle and scopes them by year', () => {
    const parent = find(isDiamondChoices);
    const children = benefitsGetAll(db).filter(b => b.prerequisite_benefit_id === parent.id);
    const ids = children.filter(b => !b.title.includes('Membership')).slice(0, 3).map(b => b.id);
    expect(() => benefitSetChoices(db, parent.id, 2026, ids)).toThrow(/achieved/);
    usageCreate(db, { benefit_id: parent.id, used_on: '2026-09-01' });
    benefitSetChoices(db, parent.id, 2026, ids);
    expect(benefitGetChoices(db, parent.id, 2026)).toEqual(ids);
    expect(benefitGetChoices(db, parent.id, 2027)).toEqual([]);
    for (const id of ids) {
      expect(project(id).benefit.choice_selected).toBe(1);
      expect(project(id, 2027).benefit.choice_selected).toBe(0);
    }
    expect(project(parent.id).uses_count).toBe(1);
    expect(() => benefitSetChoices(db, parent.id, 2026, [...ids, ids[0]])).toThrow();
    expect(() => benefitSetChoices(db, parent.id, 2026, [find(tracksEarnedNights).id])).toThrow();
  });
  it('accounts for repeated selections and two/three-choice membership costs', () => {
    const parent = find(isDiamondChoices);
    const reward = find(b => b.prerequisite_benefit_id === parent.id && b.title.includes('40,000'));
    const executive = find(b => b.prerequisite_benefit_id === parent.id && b.title.includes('(3 choices)'));
    usageCreate(db, { benefit_id: parent.id, used_on: '2026-09-01' });
    benefitSetChoices(db, parent.id, 2026, [reward.id, reward.id, reward.id]);
    expect(project(reward.id).uses_max).toBe(3);
    benefitSetChoices(db, parent.id, 2026, [executive.id]);
    expect(() => benefitSetChoices(db, parent.id, 2026, [executive.id, reward.id])).toThrow(/three selections/);
    expect(benefitGetChoices(db, parent.id, 2026)).toEqual([executive.id]);
  });
  it('round-trips hidden flags, quantities, dates, pricing and year-specific choices', () => {
    const b = find(tracksEarnedNights);
    benefitUpdate(db, b.id, { is_hidden: 1 });
    usageCreate(db, { benefit_id: b.id, used_on: '2026-09-01', quantity: 5 });
    const parent = find(isDiamondChoices);
    usageCreate(db, { benefit_id: parent.id, used_on: '2026-09-01' });
    benefitSetChoices(db, parent.id, 2026, [find(b => b.prerequisite_benefit_id === parent.id).id]);
    const payload = buildFilePayload(db);
    const other = emptyDb();
    try {
      importFilePayload(other, payload);
      const roundTrip = buildFilePayload(other);
      expect(roundTrip.benefits).toEqual(payload.benefits);
      expect(roundTrip.usages).toEqual(payload.usages);
      expect(roundTrip.benefit_choices).toEqual(payload.benefit_choices);
    } finally { other.close(); }
  });
  it('accepts old JSON without new fields, with safe defaults', () => {
    const payload = buildFilePayload(db);
    for (const b of payload.benefits) {
      delete (b as any).is_hidden; delete (b as any).previous_value_usd; delete (b as any).value_effective_date;
    }
    delete payload.benefit_choices;
    const other = emptyDb();
    try { importFilePayload(other, payload); expect(benefitsGetAll(other).every(b => b.is_hidden === 0)).toBe(true); }
    finally { other.close(); }
  });
});
