// Period math for benefits. Each benefit has a reset_cadence; usage rows are
// tagged with a period_key at insert time so that "used in the current period"
// queries never have to reason about calendar math.

import type { Benefit, ResetCadence } from './types';

/** Compute the period bucket that `iso_date` (YYYY-MM-DD) falls into. */
export function periodKeyFor(cadence: ResetCadence, iso_date: string): string {
  const [y, mStr, d] = iso_date.split('-');
  const year = parseInt(y, 10);
  const month = parseInt(mStr, 10);
  switch (cadence) {
    case 'annual':
      return `${year}`;
    case 'semiannual':
      return `${year}-H${month <= 6 ? 1 : 2}`;
    case 'quarterly': {
      const q = Math.ceil(month / 3);
      return `${year}-Q${q}`;
    }
    case 'monthly':
      return `${year}-${mStr.padStart(2, '0')}`;
    case 'spend_threshold':
      return 'spend';
    case 'one_time':
      return 'one_time';
    case 'unlimited':
      return `${year}`;
    default:
      return `${year}`;
  }
}

/** Human-friendly label for the given cadence on the given date. */
export function periodLabelFor(cadence: ResetCadence, iso_date: string): string {
  const [y, mStr] = iso_date.split('-');
  const year = parseInt(y, 10);
  const month = parseInt(mStr, 10);
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  switch (cadence) {
    case 'annual':          return `${year}`;
    case 'semiannual':      return `${year} · ${month <= 6 ? 'Jan–Jun' : 'Jul–Dec'}`;
    case 'quarterly':       return `${year} · Q${Math.ceil(month / 3)}`;
    case 'monthly':         return `${monthName} ${year}`;
    case 'spend_threshold': return 'Spend-locked';
    case 'one_time':        return 'One-time';
    case 'unlimited':       return `${year}`;
    default:                return `${year}`;
  }
}

/** Return the ISO date on which the current period resets (start of NEXT period). */
export function nextResetIso(cadence: ResetCadence, iso_date: string): string | null {
  const [y, mStr] = iso_date.split('-');
  const year = parseInt(y, 10);
  const month = parseInt(mStr, 10);
  switch (cadence) {
    case 'annual':
    case 'unlimited':
      return `${year + 1}-01-01`;
    case 'semiannual':
      return month <= 6 ? `${year}-07-01` : `${year + 1}-01-01`;
    case 'quarterly': {
      const q = Math.ceil(month / 3);
      const startMonth = q * 3 + 1; // start of next quarter
      if (startMonth > 12) return `${year + 1}-01-01`;
      return `${year}-${String(startMonth).padStart(2, '0')}-01`;
    }
    case 'monthly': {
      const nextMonth = month + 1;
      if (nextMonth > 12) return `${year + 1}-01-01`;
      return `${year}-${String(nextMonth).padStart(2, '0')}-01`;
    }
    case 'spend_threshold':
    case 'one_time':
      return null;
    default:
      return null;
  }
}

/** Maximum uses per period for this benefit (null when uncapped). */
export function uses_max_for(b: Benefit): number | null {
  if (b.reset_cadence === 'unlimited') return null;
  if (b.uses_per_period !== null && b.uses_per_period !== undefined) return b.uses_per_period;
  // Default caps for cadences when uses_per_period wasn't set
  switch (b.reset_cadence) {
    case 'annual':          return 1;
    case 'semiannual':      return 1; // per half-year
    case 'quarterly':       return 1; // per quarter
    case 'monthly':         return 1; // per month
    case 'spend_threshold': return 1;
    case 'one_time':        return 1;
    default:                return 1;
  }
}
