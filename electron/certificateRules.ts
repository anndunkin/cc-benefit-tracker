import type { Benefit } from './types';

type RuleFields = 'card_id' | 'category' | 'reset_cadence' | 'spend_threshold_usd' | 'is_choice_option' | 'prerequisite_benefit_id';

export function isHyattSpendCertificate(b: Pick<Benefit, RuleFields>): boolean {
  return b.card_id === 'hyatt_visa' && b.category === 'free_night'
    && b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd === 15000
    && !b.is_choice_option && !b.prerequisite_benefit_id;
}

/** The reviewed refresh keeps this stable title. This is a card-issued reward,
 * not the general Omni Select Guest 100-credit earning rule. */
export function isOmniStayBenefit(b: Pick<Benefit, 'card_id' | 'category' | 'reset_cadence' | 'title'>): boolean {
  return b.card_id === 'aa_executive' && b.category === 'free_night'
    && b.reset_cadence === 'annual' && /^Omni Free Night Award$/i.test(b.title.trim());
}

export function isOmniAwardRow(b: Pick<Benefit, 'card_id' | 'category' | 'reset_cadence' | 'title'>): boolean {
  return b.card_id === 'aa_executive' && b.category === 'free_night' && b.reset_cadence === 'one_time'
    && /^Omni Free Night Award \((?:earned \d{4}|\d{4} expiration)\)$/i.test(b.title.trim());
}

export const OMNI_STAY_NIGHTS = 2;
export const OMNI_STAY_REQUIREMENT = 'Complete one qualifying stay of 2+ consecutive nights on a single reservation.';
export const OMNI_STAY_TERMS = 'Book directly with Omni in the primary cardmember’s name and include their Omni loyalty number. Activate the Citi Omni Champion benefit before check-in and pay with the Citi AAdvantage Executive card.';

export function airlinePurchaseRequirement(b: Pick<Benefit, 'card_id' | 'category' | 'title'>): string | null {
  return b.card_id === 'ihg_premier' && b.category === 'airline_credit' && /\bairline statement credit\b/i.test(b.title)
    ? 'Requires one flight-ticket purchase of $250 or more booked directly with the airline.' : null;
}

export function isAnnualCertificate(b: Pick<Benefit, RuleFields | 'title'>): boolean {
  return b.card_id !== null && (b.category === 'free_night' || isCompanionCertificate(b)) && b.reset_cadence === 'annual'
    && !b.is_choice_option && !b.prerequisite_benefit_id && !isOmniStayBenefit(b);
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
  let earnedLabel: string | null = null;
  if (isOmniStayBenefit(b)) title = 'Earn an Omni Free Night Award';
  if (b.card_id && b.reset_cadence === 'one_time' && (b.category === 'free_night' || isCompanionCertificate(b))) {
    if (b.card_id === 'hyatt_visa' && b.category === 'free_night') {
      const spend = /^(Hyatt Category 1[–-]4 Free Night Award \(\$15,000 spend), (\d{4})\)$/.exec(title);
      if (spend) {
        title = `${spend[1]})`;
        earnedLabel = `Earned from ${spend[2]} spend`;
      }
      if (/^Carried-over Category 1-4 Free Night \(expires \d{4}-\d{2}-\d{2}\)$/.test(title)) {
        title = title.replace(/ \(expires \d{4}-\d{2}-\d{2}\)$/, '');
        if (note && /^Expires [A-Za-z]+ \d{1,2}, \d{4}; cannot be extended\.$/.test(note)) note = 'Cannot be extended.';
        if (description) description = description.replace(/ Expires [A-Za-z]+ \d{1,2}, \d{4}\.$/, '');
      }
    }
    if (b.card_id === 'aa_executive' && b.category === 'free_night') {
      const stay = /^Omni Free Night Award \(earned (\d{4})\)$/.exec(title);
      if (stay) {
        title = 'Omni Free Night Award';
        earnedLabel = `Earned from a ${stay[1]} Omni stay`;
      }
    }
    title = title.replace(/ \(\d{4} expiration\)$/, '');
  }
  return { title, earnedLabel, note, description };
}
