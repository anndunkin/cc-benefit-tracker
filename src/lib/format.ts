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

// ─── v1.0.16 additions: Bonus Categories + Points Currency Values labels ─────

export const ALL_SPEND_CATEGORIES = [
  'airfare', 'hotels', 'car_rentals', 'dining', 'groceries', 'gas',
  'rideshare_transit', 'streaming_entertainment', 'online_shopping',
  'everyday_everything_else',
] as const;

/** Human label for a SpendCategory bucket, used on the Bonus Categories tab. */
export function spendCategoryLabel(category: string): string {
  switch (category) {
    case 'airfare': return 'Airfare';
    case 'hotels': return 'Hotels';
    case 'car_rentals': return 'Car Rentals';
    case 'dining': return 'Dining';
    case 'groceries': return 'Groceries';
    case 'gas': return 'Gas';
    case 'rideshare_transit': return 'Rideshare & Transit';
    case 'streaming_entertainment': return 'Streaming & Entertainment';
    case 'online_shopping': return 'Online Shopping';
    case 'everyday_everything_else': return 'Everyday / Everything Else';
    default: return categoryLabel(category);
  }
}

/** Human label for a PointsCurrencyType, used on the Points Currency Values tab. */
export function currencyTypeLabel(type: string): string {
  switch (type) {
    case 'transferable': return 'Transferable';
    case 'airline': return 'Airline';
    case 'hotel': return 'Hotel';
    default: return categoryLabel(type);
  }
}

/** Formats cents-per-point as "¢X.X per point" (e.g. 1.7 -> "¢1.7 per point"). */
export function fmtCentsPerPoint(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `¢${cents.toFixed(1)} per point`;
}
