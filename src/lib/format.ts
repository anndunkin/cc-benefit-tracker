/** Shared formatters used across pages. */

export function fmtUsd(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    maximumFractionDigits: digits, minimumFractionDigits: digits,
  }).format(n);
}

export function cadenceLabel(cadence: string): string {
  switch (cadence) {
    case 'annual': return 'Annual';
    case 'semiannual': return 'Semi-annual';
    case 'quarterly': return 'Quarterly';
    case 'monthly': return 'Monthly';
    case 'spend_threshold': return 'Spend-based';
    case 'unlimited': return 'Unlimited';
    case 'one_time': return 'One-time';
    default: return cadence;
  }
}

export function categoryLabel(category: string): string {
  return category
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const target = new Date(iso + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.ceil((target - now) / 86400000);
}

export function statusColor(status: string): string {
  switch (status) {
    case 'available':  return 'bg-emerald-500';
    case 'partial':    return 'bg-amber-500';
    case 'exhausted':  return 'bg-slate-400 dark:bg-slate-600';
    case 'unlimited':  return 'bg-sky-500';
    case 'locked':     return 'bg-purple-500';
    default:           return 'bg-slate-400';
  }
}

export const ALL_CATEGORIES = [
  'travel_credit','dining_credit','retail_credit','entertainment_credit',
  'rideshare_credit','wellness_credit','hotel_credit','airline_credit',
  'free_night','upgrade','status_boost','earning_multiplier','lounge_access','other',
] as const;

export const ALL_CADENCES = [
  'annual','semiannual','quarterly','monthly','spend_threshold','unlimited','one_time',
] as const;
