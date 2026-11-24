import { describe, expect, it } from 'vitest';
import {
  benefitCreate, benefitDelete, benefitGetById, benefitsForCard, benefitUpdate, buildFilePayload, computeProjections,
  importFilePayload, reconcileCertificateAwards, usageCreate, usageUpdate,
} from '../electron/database';
import { buildExpiringReport, utcDateFor } from '../electron/expiringCredits';
import { emptyDb, seededDb } from './helpers';

const project = (db: ReturnType<typeof seededDb>, today: string, year = Number(today.slice(0, 4))) =>
  computeProjections(db, year, utcDateFor(today));
const awards = (db: ReturnType<typeof seededDb>, today: string, year?: number) =>
  project(db, today, year).filter(p => p.certificate_kind);
const marriott = (db: ReturnType<typeof seededDb>) =>
  benefitsForCard(db, 'marriott_premier').find(b => b.category === 'free_night' && b.reset_cadence === 'annual')!;
const hyatt = (db: ReturnType<typeof seededDb>) =>
  benefitsForCard(db, 'hyatt_visa').find(b => b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd === 15000)!;

describe('automatic certificate awards', () => {
  it('waits through the annual expiration day and renews exactly once without carrying usage over', () => {
    const db = seededDb();
    const b = marriott(db);
    const actual = '2026-11-19';
    benefitUpdate(db, b.id, { expiration_date: actual });
    const use = usageCreate(db, { benefit_id: b.id, used_on: '2025-12-10' });
    reconcileCertificateAwards(db, actual);
    expect(awards(db, actual)).toHaveLength(0);
    expect(project(db, actual).find(p => p.benefit.id === b.id)?.uses_count).toBe(1);

    const today = '2026-11-20';
    reconcileCertificateAwards(db, today);
    reconcileCertificateAwards(db, today);
    const latest = awards(db, today);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ certificate_kind: 'annual_renewal', uses_count: 0, status: 'available',
      benefit: { card_id: b.card_id, program_id: null, expiration_date: '2027-11-19' } });
    expect(project(db, today).find(p => p.benefit.id === b.id)).toMatchObject({
      status: 'expired', uses_remaining: 0, usages: [{ id: use.id }],
    });
    const id = latest[0].benefit.id;
    const report = buildExpiringReport(project(db, today), today);
    expect(report.items.some(x => x.benefit_id === b.id)).toBe(false);
    expect(report.items.find(x => x.benefit_id === id)?.expires_on).toBe('2027-11-19');
    expect(() => usageCreate(db, { benefit_id: id, used_on: '2026-11-19' })).toThrow(/before/);
    const newUse = usageCreate(db, { benefit_id: id, used_on: '2027-11-19' });
    expect(() => usageUpdate(db, newUse.id, { used_on: '2027-11-20' })).toThrow(/expired/);
    benefitUpdate(db, id, { expiration_date: '2027-11-23' });
    reconcileCertificateAwards(db, '2027-11-24');
    expect(awards(db, '2027-11-24').map(p => p.benefit.expiration_date)).toContain('2028-11-23');
    db.close();
  });

  it('catches up only the current award and handles a leap-day anniversary safely', () => {
    const db = seededDb();
    benefitUpdate(db, marriott(db).id, { expiration_date: '2024-02-29' });
    reconcileCertificateAwards(db, '2027-03-01');
    expect(awards(db, '2027-03-01').map(p => p.benefit.expiration_date)).toEqual(['2028-02-29']);
    db.close();
  });

  it('renews a dated annual companion certificate and keeps the category', () => {
    const db = seededDb();
    const b = benefitsForCard(db, 'delta_reserve').find(b => b.title === 'Annual Companion Certificate')!;
    benefitUpdate(db, b.id, { expiration_date: '2026-05-18' });
    reconcileCertificateAwards(db, '2026-05-19');
    const [p] = awards(db, '2026-05-19');
    expect(p?.benefit).toMatchObject({ category: b.category, card_id: b.card_id, expiration_date: '2027-05-18' });
    db.close();
  });

  it('does not renew a one-off, a choice award, an undated benefit or a hidden card', () => {
    const db = seededDb();
    const b = marriott(db);
    benefitCreate(db, { card_id: b.card_id, title: 'One-off', category: 'free_night', reset_cadence: 'one_time', expiration_date: '2025-07-01' });
    benefitCreate(db, { card_id: b.card_id, title: 'Choice', category: 'free_night', reset_cadence: 'annual', is_choice_option: 1, expiration_date: '2025-07-01' });
    reconcileCertificateAwards(db, '2026-07-02');
    expect(awards(db, '2026-07-02')).toHaveLength(0);
    benefitUpdate(db, b.id, { expiration_date: '2025-07-01' });
    db.prepare('UPDATE cards SET is_visible = 0 WHERE id = ?').run(b.card_id);
    reconcileCertificateAwards(db, '2026-07-02');
    expect(buildFilePayload(db).certificate_awards).toHaveLength(0);
    db.close();
  });

  it('backfills Hyatt from actual net spend only, once per calendar year, independently of the anniversary award', () => {
    const db = seededDb();
    const t = hyatt(db);
    const log = (used_on: string, amount_usd: number) => usageCreate(db, { benefit_id: t.id, used_on, amount_usd });
    log('2025-12-31', 12_500);
    log('2026-01-01', 14_999.99);
    log('2026-10-10', 0.01);
    log('2026-10-11', -0.01);
    log('2026-10-13', 0.01);
    reconcileCertificateAwards(db, '2026-10-12');
    expect(awards(db, '2026-10-12')).toHaveLength(0);
    reconcileCertificateAwards(db, '2026-11-25');
    const [p] = awards(db, '2026-11-25');
    expect(p).toMatchObject({ certificate_kind: 'hyatt_spend', uses_count: 0, benefit: { expiration_date: null, card_id: 'hyatt_visa', program_id: null } });
    expect(() => usageCreate(db, { benefit_id: p.benefit.id, used_on: '2026-11-25' })).toThrow(/posted expiration/);
    expect(buildExpiringReport(project(db, '2026-11-25'), '2026-11-25').items.some(x => x.benefit_id === p.benefit.id)).toBe(false);
    benefitUpdate(db, p.benefit.id, { expiration_date: '2026-10-25' });
    expect(awards(db, '2026-11-25')[0]).toMatchObject({ status: 'expired', uses_remaining: 0, benefit: { expiration_date: '2026-10-25' } });
    reconcileCertificateAwards(db, '2027-01-01');
    expect(awards(db, '2027-01-01')).toHaveLength(0);
    log('2027-01-02', 15_001);
    log('2027-02-02', 15_001);
    reconcileCertificateAwards(db, '2027-02-03');
    reconcileCertificateAwards(db, '2027-02-03');
    expect(awards(db, '2027-02-03')).toHaveLength(1);
    expect(awards(db, '2027-02-03', 2026)[0].benefit.id).toBe(p.benefit.id);
    db.close();
  });

  it('preserves links, dates and deleted-cycle suppression in a JSON round-trip', () => {
    const db = seededDb();
    const t = hyatt(db);
    benefitUpdate(db, t.id, { expiration_date: '2026-10-25' });
    usageCreate(db, { benefit_id: t.id, used_on: '2026-10-09', amount_usd: 15_000 });
    const today = '2026-11-25';
    reconcileCertificateAwards(db, today);
    const id = awards(db, today)[0].benefit.id;
    expect(benefitGetById(db, id)?.expiration_date).toBe('2026-10-25');
    benefitDelete(db, id);

    const restored = emptyDb();
    const payload = buildFilePayload(db);
    importFilePayload(restored, payload);
    reconcileCertificateAwards(restored, today);
    expect(awards(restored, today)).toHaveLength(0);
    expect(buildFilePayload(restored).certificate_awards).toEqual(payload.certificate_awards);
    const bad = { ...payload, certificate_awards: [{ ...payload.certificate_awards![0], award_id: t.id }] };
    expect(() => importFilePayload(restored, bad)).toThrow(/Invalid certificate/);
    expect(buildFilePayload(restored).certificate_awards).toEqual(payload.certificate_awards);
    db.close();
    restored.close();
  });
});
