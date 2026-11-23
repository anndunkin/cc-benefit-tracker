import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { seededDb } from './helpers';
import {
  benefitCreate, benefitUpdate, benefitsGetAll, cardSetVisible, computeProjections, usageCreate,
} from '../electron/database';
import {
  buildExpiringReport, dayBefore, endOfMonth, isTravel, localIsoDate, matchesSelection, utcDateFor,
} from '../electron/expiringCredits';
import type { ExpiringSelection } from '../electron/expiringCredits';
import type { BenefitInput, ExpiringItem, ExpiringReport } from '../electron/types';

// The list behind File > Print Expiring Credits (v1.0.26).

const TODAY = '2026-11-22';

function reportFor(db: Database.Database, today = TODAY): ExpiringReport {
  return buildExpiringReport(computeProjections(db, parseInt(today.slice(0, 4), 10), utcDateFor(today)), today);
}
function idOf(db: Database.Database, owner: string, title: RegExp): number {
  const found = benefitsGetAll(db).filter(b => (b.card_id ?? b.program_id) === owner && title.test(b.title));
  if (found.length !== 1) throw new Error(`${owner} ${title}: ${found.length} matches`);
  return found[0].id;
}
function row(r: ExpiringReport, id: number): ExpiringItem | undefined {
  return r.items.find(i => i.benefit_id === id);
}
function pick(r: ExpiringReport, sel: Partial<ExpiringSelection>): ExpiringItem[] {
  const full: ExpiringSelection = { scope: 'month', travelOnly: false, includeLaterCertificates: false, ...sel };
  return r.items.filter(i => matchesSelection(i, r, full));
}
function add(db: Database.Database, input: Partial<BenefitInput> & { title: string }): number {
  return benefitCreate(db, {
    card_id: 'amex_platinum', category: 'retail_credit', reset_cadence: 'monthly', uses_per_period: 1, value_usd: 20, ...input,
  }).id;
}

describe('dates', () => {
  it('finds month ends, including leap years', () => {
    expect(endOfMonth('2026-11-22')).toBe('2026-11-30');
    expect(endOfMonth('2026-12-31')).toBe('2026-12-31');
    expect(endOfMonth('2027-02-01')).toBe('2027-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
  });

  it("uses the calendar date where the user is, not the UTC date", () => {
    // 8:30 PM on New Year's Eve in a zone behind UTC: still December 31.
    const evening = new Date(2026, 11, 31, 20, 30);
    expect(localIsoDate(evening)).toBe('2026-12-31');
    expect(utcDateFor('2026-12-31').toISOString()).toBe('2026-12-31T12:00:00.000Z');
  });
});

describe('what is listed (starting data, November 22, 2026)', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('reports the period ends and sorts soonest first', () => {
    db = seededDb();
    const r = reportFor(db);
    expect(r).toMatchObject({ today: TODAY, month_end: '2026-11-30', year_end: '2026-12-31', next_year_end: '2027-12-31' });
    const dates = r.items.map(i => i.expires_on);
    expect([...dates].sort()).toEqual(dates);
    expect(r.items.length).toBeGreaterThan(30);
    expect(new Set(r.items.map(i => i.benefit_id)).size).toBe(r.items.length);
  });

  it('lists monthly, quarterly, half-year and annual credits at the end of their period', () => {
    db = seededDb();
    const r = reportFor(db);
    const cases: Array<[string, RegExp, string, number]> = [
      ['amex_platinum', /^\$300 Digital Entertainment Credit/, '2026-11-30', 25],
      ['amex_platinum', /^\$400 Resy Credit/, '2026-12-31', 100],
      ['amex_platinum', /^\$600 Hotel Credit/, '2026-12-31', 300],
      ['amex_platinum', /^\$200 Airline Fee Credit/, '2026-12-31', 200],
    ];
    for (const [owner, title, date, dollars] of cases) {
      const item = row(r, idOf(db, owner, title))!;
      expect(item, String(title)).toBeDefined();
      expect(item).toMatchObject({
        kind: 'credit', expires_on: date, expiry_source: 'period', date_not_recorded: false,
        partially_used: false, value_remaining_usd: dollars, value_total_usd: dollars,
      });
    }
    // In June the same credits end with their own periods.
    const june = reportFor(db, '2026-06-10');
    expect(row(june, idOf(db, 'amex_platinum', /^\$300 Digital Entertainment Credit/))!.expires_on).toBe('2026-06-30');
    expect(row(june, idOf(db, 'amex_platinum', /^\$400 Resy Credit/))!.expires_on).toBe('2026-06-30');
    expect(row(june, idOf(db, 'amex_platinum', /^\$600 Hotel Credit/))!.expires_on).toBe('2026-06-30');
    expect(row(june, idOf(db, 'amex_platinum', /^\$200 Airline Fee Credit/))!.expires_on).toBe('2026-12-31');
    const feb = reportFor(db, '2028-02-03');
    expect(row(feb, idOf(db, 'amex_platinum', /^\$300 Digital Entertainment Credit/))!.expires_on).toBe('2028-02-29');
  });

  it('leaves out status tiers, milestones, spend unlocks, ongoing benefits and anything with no deadline', () => {
    db = seededDb();
    const r = reportFor(db);
    const all = benefitsGetAll(db);
    const byId = new Map(all.map(b => [b.id, b]));
    for (const item of r.items) {
      const b = byId.get(item.benefit_id)!;
      expect(['unlimited', 'spend_threshold']).not.toContain(b.reset_cadence);
      expect(['status_boost', 'earning_multiplier']).not.toContain(b.category);
      expect(b.is_hidden).not.toBe(1);
      if (b.reset_cadence === 'one_time') expect(b.expiration_date).toBeTruthy();
    }
    // A one-time benefit with no expiration date has no deadline to print.
    const oneTime = add(db, { title: 'One-time welcome credit', reset_cadence: 'one_time', value_usd: 100 });
    expect(row(reportFor(db), oneTime)).toBeUndefined();
    benefitUpdate(db, oneTime, { expiration_date: '2026-12-15' });
    expect(row(reportFor(db), oneTime)).toMatchObject({ kind: 'credit', expires_on: '2026-12-15', expiry_source: 'date', value_remaining_usd: 100 });
  });

  it('leaves out hidden benefits, hidden cards and options that were not chosen', () => {
    db = seededDb();
    const resy = idOf(db, 'amex_platinum', /^\$400 Resy Credit/);
    const stays = idOf(db, 'delta_reserve', /^\$200 Delta Stays Credit/);
    expect(row(reportFor(db), resy)).toBeDefined();
    benefitUpdate(db, resy, { is_hidden: 1 });
    expect(row(reportFor(db), resy)).toBeUndefined();
    cardSetVisible(db, 'delta_reserve', false);
    expect(row(reportFor(db), stays)).toBeUndefined();
    // Choice options are listed only once chosen.
    const r = reportFor(db);
    const unchosen = benefitsGetAll(db).filter(b => b.is_choice_option === 1).map(b => b.id);
    expect(unchosen.length).toBeGreaterThan(0);
    for (const id of unchosen) expect(row(r, id)).toBeUndefined();
  });
});

describe('what is left', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('notes the amount remaining on a partly used credit, and drops it once used up', () => {
    db = seededDb();
    const hotel = idOf(db, 'amex_platinum', /^\$600 Hotel Credit/);       // $300 each half-year
    usageCreate(db, { benefit_id: hotel, used_on: '2026-10-03', amount_usd: 120.5 });
    expect(row(reportFor(db), hotel)).toMatchObject({ partially_used: true, value_remaining_usd: 179.5, value_total_usd: 300 });
    // Spending in the first half of the year does not count against the second half.
    usageCreate(db, { benefit_id: hotel, used_on: '2026-03-03', amount_usd: 300 });
    expect(row(reportFor(db), hotel)).toMatchObject({ value_remaining_usd: 179.5 });
    usageCreate(db, { benefit_id: hotel, used_on: '2026-11-20', amount_usd: 179.5 });
    expect(row(reportFor(db), hotel)).toBeUndefined();
  });

  it('treats a use logged without an amount as the full value of one use', () => {
    db = seededDb();
    const uber = idOf(db, 'amex_platinum', /^\$200 Uber Cash/);
    expect(row(reportFor(db), uber)).toMatchObject({ value_remaining_usd: 15 });
    usageCreate(db, { benefit_id: uber, used_on: '2026-11-05' });
    expect(row(reportFor(db), uber)).toBeUndefined();

    const four = add(db, { title: 'Four $50 vouchers', reset_cadence: 'annual', uses_per_period: 4, value_usd: 50 });
    expect(row(reportFor(db), four)).toMatchObject({ value_remaining_usd: 200, value_total_usd: 200, uses_remaining: 4 });
    usageCreate(db, { benefit_id: four, used_on: '2026-05-01', quantity: 2 });   // two vouchers, no amount
    expect(row(reportFor(db), four)).toMatchObject({ partially_used: true, value_remaining_usd: 100, uses_remaining: 2 });
    usageCreate(db, { benefit_id: four, used_on: '2026-06-01', amount_usd: 30 });
    expect(row(reportFor(db), four)).toMatchObject({ value_remaining_usd: 70 });
  });

  it('keeps amounts to whole cents', () => {
    db = seededDb();
    const tiny = add(db, { title: 'One dollar credit', value_usd: 1 });
    for (let i = 0; i < 9; i++) usageCreate(db, { benefit_id: tiny, used_on: '2026-11-10', amount_usd: 0.1 });
    expect(row(reportFor(db), tiny)).toMatchObject({ value_remaining_usd: 0.1, partially_used: true });
    usageCreate(db, { benefit_id: tiny, used_on: '2026-11-11', amount_usd: 0.1 });
    expect(row(reportFor(db), tiny)).toBeUndefined();
  });

  it('counts certificates and passes in uses, whatever dollar value is recorded', () => {
    db = seededDb();
    const visits = idOf(db, 'delta_reserve', /^15 Delta Sky Club Visits/);
    expect(row(reportFor(db), visits)).toMatchObject({ kind: 'certificate', partially_used: false, uses_remaining: 15, uses_max: 15, value_remaining_usd: null });
    for (const day of ['2026-02-01', '2026-03-01', '2026-04-01']) usageCreate(db, { benefit_id: visits, used_on: day });
    expect(row(reportFor(db), visits)).toMatchObject({ partially_used: true, uses_remaining: 12, uses_max: 15 });

    // One of four valued passes logged at more than its own value still leaves three passes.
    const passes = add(db, { title: 'Four lounge passes', category: 'lounge_access', reset_cadence: 'annual', uses_per_period: 4, value_usd: 100 });
    usageCreate(db, { benefit_id: passes, used_on: '2026-04-04', amount_usd: 400 });
    expect(row(reportFor(db), passes)).toMatchObject({ kind: 'certificate', partially_used: true, uses_remaining: 3, uses_max: 4, value_each_usd: 100 });

    const night = idOf(db, 'marriott_business', /^Annual Free Night Award/);
    expect(row(reportFor(db), night)).toMatchObject({ kind: 'certificate', uses_remaining: 1, value_each_usd: 245 });
    usageCreate(db, { benefit_id: night, used_on: '2026-08-08' });
    expect(row(reportFor(db), night)).toBeUndefined();
  });

  it('treats a companion certificate as a certificate even with a dollar value, and a points bonus as neither', () => {
    db = seededDb();
    const companion = idOf(db, 'delta_reserve', /^Annual Companion Certificate/);
    benefitUpdate(db, companion, { value_usd: 500 });
    expect(row(reportFor(db), companion)).toMatchObject({ kind: 'certificate', is_travel: true, value_remaining_usd: null, value_each_usd: 500 });
    const points = idOf(db, 'virgin_atlantic', /^5,000 Virgin Points Anniversary Bonus/);
    // The year end is only how the app tracks a points bonus, not a published deadline.
    expect(row(reportFor(db), points)).toMatchObject({ kind: 'other', is_travel: false, expiry_source: 'period', date_not_recorded: true });
    // Give it a date and that date is printed.
    benefitUpdate(db, points, { expiration_date: '2026-12-15' });
    expect(row(reportFor(db), points)).toMatchObject({ kind: 'other', expires_on: '2026-12-15', expiry_source: 'date', date_not_recorded: false });
  });
});

describe('use-by dates', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it("uses a certificate's own expiration date, and says so when none is recorded", () => {
    db = seededDb();
    const r = reportFor(db);
    const carried = idOf(db, 'hyatt_visa', /^Carried-over Category 1-4 Free Night \(expires 2026-11-26\)/);
    expect(row(r, carried)).toMatchObject({ kind: 'certificate', expires_on: '2026-11-26', expiry_source: 'date', date_not_recorded: false });
    const upgrades = idOf(db, 'marriott_status', /^Nightly Upgrade Awards/);
    expect(row(r, upgrades)).toMatchObject({ expires_on: '2026-12-31', expiry_source: 'date', uses_remaining: 10 });

    // No date on file: listed by the year the app tracks it in, flagged so the
    // printout says "Check certificate" instead of a deadline.
    const annual = idOf(db, 'hilton_aspire', /^Annual Free Night Reward/);
    expect(row(r, annual)).toMatchObject({ kind: 'certificate', expires_on: '2026-12-31', expiry_source: 'period', date_not_recorded: true });
    // Once its date is recorded (often after the year ends) that date is used.
    benefitUpdate(db, annual, { expiration_date: '2027-04-18' });
    expect(row(reportFor(db), annual)).toMatchObject({ expires_on: '2027-04-18', expiry_source: 'date', date_not_recorded: false });
  });

  it('never lets a later date postpone a dollar credit that resets sooner', () => {
    db = seededDb();
    const monthly = add(db, { title: 'Monthly $20 with an end date', expiration_date: '2027-07-15' });
    expect(row(reportFor(db), monthly)).toMatchObject({ expires_on: '2026-11-30', expiry_source: 'period' });
    // An earlier date brings it forward.
    benefitUpdate(db, monthly, { expiration_date: '2026-11-25' });
    expect(row(reportFor(db), monthly)).toMatchObject({ expires_on: '2026-11-25', expiry_source: 'date' });
  });

  it('lists something expiring today, and drops it the day after', () => {
    db = seededDb();
    const carried = idOf(db, 'hyatt_visa', /^Carried-over Category 1-4 Free Night \(expires 2026-11-26\)/);
    expect(row(reportFor(db, '2026-11-26'), carried)).toMatchObject({ expires_on: '2026-11-26' });
    expect(row(reportFor(db, '2026-11-27'), carried)).toBeUndefined();
    const dated = add(db, { title: 'Dated credit', reset_cadence: 'one_time', expiration_date: '2026-11-22' });
    expect(row(reportFor(db), dated)).toBeDefined();
    expect(row(reportFor(db, '2026-11-23'), dated)).toBeUndefined();
  });

  it('on the last evening of the year still lists December, and a use logged that evening counts', () => {
    db = seededDb();
    const ent = idOf(db, 'amex_platinum', /^\$300 Digital Entertainment Credit/);
    const airline = idOf(db, 'amex_platinum', /^\$200 Airline Fee Credit/);
    const r = reportFor(db, '2026-12-31');
    expect(r).toMatchObject({ month_end: '2026-12-31', year_end: '2026-12-31', next_year_end: '2027-12-31' });
    expect(row(r, ent)).toMatchObject({ expires_on: '2026-12-31', value_remaining_usd: 25 });
    expect(row(r, airline)).toMatchObject({ expires_on: '2026-12-31', value_remaining_usd: 200 });
    usageCreate(db, { benefit_id: ent, used_on: '2026-12-31', amount_usd: 25 });
    expect(row(reportFor(db, '2026-12-31'), ent)).toBeUndefined();
    // The next morning everything has reset and the new periods are listed.
    const next = reportFor(db, '2027-01-01');
    expect(row(next, ent)).toMatchObject({ expires_on: '2027-01-31', value_remaining_usd: 25 });
    expect(row(next, airline)).toMatchObject({ expires_on: '2027-12-31' });
  });

  it('ignores an expiration date that is not a real date', () => {
    db = seededDb();
    const bad = add(db, { title: 'Oddly dated', reset_cadence: 'one_time' });
    db.prepare('UPDATE benefits SET expiration_date = ? WHERE id = ?').run('2026-02-30', bad);
    expect(row(reportFor(db), bad)).toBeUndefined();
    db.prepare('UPDATE benefits SET expiration_date = ? WHERE id = ?').run('soon', bad);
    expect(row(reportFor(db), bad)).toBeUndefined();
  });
});

describe('choices', () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it('this month is a subset of this year', () => {
    db = seededDb();
    const r = reportFor(db);
    const month = pick(r, { scope: 'month' });
    const year = pick(r, { scope: 'year' });
    expect(month.length).toBeGreaterThan(0);
    expect(year.length).toBeGreaterThan(month.length);
    expect(month.every(i => i.expires_on <= '2026-11-30')).toBe(true);
    expect(year.every(i => i.expires_on <= '2026-12-31')).toBe(true);
    for (const i of month) expect(year).toContain(i);
    expect(pick(r, { scope: 'year' }).some(i => i.expires_on > '2026-12-31')).toBe(false);
  });

  it('travel only keeps airline, hotel, travel and rideshare credits, free nights, upgrades, passes and companion certificates', () => {
    db = seededDb();
    const r = reportFor(db);
    const travel = pick(r, { scope: 'year', travelOnly: true });
    const titles = travel.map(i => i.title);
    expect(titles).toEqual(expect.arrayContaining([
      '$200 Uber Cash', '$15 Monthly Lyft Credit (effective September 2026)', '$200 Airline Fee Credit',
      '$600 Hotel Credit ($300 semiannually)', '$250 Annual Travel Credit', 'Annual Companion Certificate',
      'Annual Free Night Reward', '15 Delta Sky Club Visits per Medallion Year',
    ]));
    for (const t of titles) {
      expect(t).not.toMatch(/Resy|Grubhub|Instacart|lululemon|Equinox|Oura|Walmart|Entertainment|DoorDash|Points Anniversary/);
    }
    expect(travel.every(i => i.is_travel)).toBe(true);
    expect(pick(r, { scope: 'year' }).length).toBeGreaterThan(travel.length);
    expect(isTravel('rideshare_credit', 'x')).toBe(true);
    expect(isTravel('other', 'Annual Companion Certificate')).toBe(true);
    expect(isTravel('other', 'Refer-a-friend bonus')).toBe(false);
    expect(isTravel('dining_credit', 'Companion dinner')).toBe(false);
  });

  it('can add certificates expiring later, through the end of next year, and nothing else', () => {
    db = seededDb();
    const laterCert = idOf(db, 'hyatt_visa', /^Carried-over Category 1-4 Free Night \(expires 2027-03-27\)/);
    const farCert = add(db, { title: 'Far-off upgrade', category: 'upgrade', reset_cadence: 'one_time', value_usd: null, expiration_date: '2028-01-31' });
    const laterCredit = add(db, { title: 'Dated dollar credit', reset_cadence: 'one_time', value_usd: 75, expiration_date: '2027-05-01' });
    const lastDay = add(db, { title: 'Last-day pass', category: 'lounge_access', reset_cadence: 'one_time', value_usd: null, expiration_date: '2027-12-31' });
    const r = reportFor(db);

    for (const scope of ['month', 'year'] as const) {
      const plain = pick(r, { scope }).map(i => i.benefit_id);
      expect(plain).not.toContain(laterCert);
      const withLater = pick(r, { scope, includeLaterCertificates: true });
      const ids = withLater.map(i => i.benefit_id);
      expect(ids).toContain(laterCert);
      expect(ids).toContain(lastDay);
      expect(ids).not.toContain(farCert);        // beyond next year
      expect(ids).not.toContain(laterCredit);    // a dollar credit, not a certificate
      for (const id of plain) expect(ids).toContain(id);
      // Everything it added is a certificate dated after the chosen period.
      const limit = scope === 'month' ? r.month_end : r.year_end;
      for (const i of withLater.filter(x => !plain.includes(x.benefit_id))) {
        expect(i.kind).toBe('certificate');
        expect(i.expires_on > limit && i.expires_on <= '2027-12-31').toBe(true);
      }
    }
    // With "this month" it also brings in this year's remaining certificates, but not this year's dollar credits.
    const monthPlus = pick(r, { scope: 'month', includeLaterCertificates: true }).map(i => i.title);
    expect(monthPlus).toContain('Nightly Upgrade Awards (10 earned in 2025)');
    expect(monthPlus).not.toContain('$200 Airline Fee Credit');
    // Travel only still applies.
    const travelLater = pick(r, { scope: 'month', travelOnly: true, includeLaterCertificates: true });
    expect(travelLater.every(i => i.is_travel)).toBe(true);
    expect(travelLater.map(i => i.benefit_id)).toContain(laterCert);
  });
});
