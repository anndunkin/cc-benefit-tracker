import type { Benefit } from './types';

type RuleFields = 'card_id' | 'category' | 'reset_cadence' | 'spend_threshold_usd' | 'is_choice_option' | 'prerequisite_benefit_id';

export function isHyattSpendCertificate(b: Pick<Benefit, RuleFields>): boolean {
  return b.card_id === 'hyatt_visa' && b.category === 'free_night'
    && b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd === 15000
    && !b.is_choice_option && !b.prerequisite_benefit_id;
}

export function isAnnualCertificate(b: Pick<Benefit, RuleFields | 'title'>): boolean {
  return b.card_id !== null && (b.category === 'free_night' || isCompanionCertificate(b)) && b.reset_cadence === 'annual'
    && !b.is_choice_option && !b.prerequisite_benefit_id;
}

export function isCompanionCertificate(b: Pick<Benefit, 'category' | 'title'>): boolean {
  return b.category === 'other' && /\bcompanion certificate\b/i.test(b.title);
}

export function isCertificateDate(iso: string | null | undefined): iso is string {
  return !!iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && Number.isFinite(Date.parse(iso))
    && new Date(iso).toISOString().slice(0, 10) === iso;
}

/** Shift a local calendar date without letting February 29 spill into March. */
export function certificateYearOffset(iso: string, offset: number): string {
  const year = String(Number(iso.slice(0, 4)) + offset).padStart(4, '0');
  const date = year + iso.slice(4);
  return isCertificateDate(date) ? date : `${year}-02-28`;
}

/** Old seeded and generated titles included static dates. Keep the stored names
 * for refresh matching and backups, but show expiration only from expiration_date.
 */
export function certificateDisplay(b: Pick<Benefit, 'title' | 'card_id' | 'category' | 'reset_cadence' | 'expiration_note' | 'description'>) {
  let { title, expiration_note: note, description } = b;
  let earnedYear: string | null = null;
  if (b.card_id && b.reset_cadence === 'one_time' && (b.category === 'free_night' || isCompanionCertificate(b))) {
    if (b.card_id === 'hyatt_visa' && b.category === 'free_night') {
      const spend = /^(Hyatt Category 1[–-]4 Free Night Award \(\$15,000 spend), (\d{4})\)$/.exec(title);
      if (spend) {
        title = `${spend[1]})`;
        earnedYear = spend[2];
      }
      if (/^Carried-over Category 1-4 Free Night \(expires \d{4}-\d{2}-\d{2}\)$/.test(title)) {
        title = title.replace(/ \(expires \d{4}-\d{2}-\d{2}\)$/, '');
        if (note && /^Expires [A-Za-z]+ \d{1,2}, \d{4}; cannot be extended\.$/.test(note)) note = 'Cannot be extended.';
        if (description) description = description.replace(/ Expires [A-Za-z]+ \d{1,2}, \d{4}\.$/, '');
      }
    }
    title = title.replace(/ \(\d{4} expiration\)$/, '');
  }
  return { title, earnedYear, note, description };
}
