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
