import type { Benefit, BenefitInput } from './types';

type RuleBenefit = Pick<BenefitInput, 'card_id' | 'program_id' | 'title' | 'is_choice_option' | 'reset_cadence'>;

export function isMilestone(b: RuleBenefit): boolean {
  if (b.is_choice_option === 1 || b.reset_cadence !== 'annual') return false;
  return (b.program_id === 'aa_status' && /Loyalty Points/i.test(b.title))
    || (b.program_id === 'marriott_status' && /Elite Nights.*Choice Benefit/i.test(b.title))
    || (b.program_id === 'delta_medallion' && /Medallion Choice Benefits/i.test(b.title));
}

export function isDiamondChoices(b: RuleBenefit): boolean {
  return isMilestone(b) && b.program_id === 'delta_medallion' && /^Diamond/i.test(b.title);
}

export function tracksEarnedNights(b: RuleBenefit): boolean {
  return b.card_id === 'marriott_premier' && /^1 Elite Night Credit per/i.test(b.title);
}

export function choiceCost(title: string): number {
  return /\(3 choices\)/i.test(title) ? 3 : /\(2 choices\)/i.test(title) ? 2 : 1;
}

export function valueAtDate(b: Pick<Benefit, 'value_usd' | 'previous_value_usd' | 'value_effective_date'>, date: string): number | null {
  return b.value_effective_date && date < b.value_effective_date
    ? b.previous_value_usd ?? b.value_usd : b.value_usd;
}
