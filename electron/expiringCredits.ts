// Expiring credits and certificates (v1.0.26): the list behind
// File > Print Expiring Credits. Pure functions, no Electron or database
// imports, so the rules can be tested directly (tests/expiringCredits.test.ts).
//
// What is listed: anything shown on Credits & Usages that still has something
// left to use AND has a date by which it must be used. That date is the
// benefit's own expiration date when one is set, otherwise the last day of the
// period it resets on (month, quarter, half-year or calendar year). Rows that
// only track progress (status tiers, milestones, spend thresholds, elite-night
// counters) are not credits and are left out.
import type {
  BenefitCategory, BenefitProjection, ExpiringItem, ExpiringReport,
} from './types';
import { isMilestone, tracksEarnedNights } from './benefitRules';
import { airlinePurchaseRequirement, certificateDisplay, isOmniStayBenefit } from './certificateRules';

/** Categories that count as travel for the "Travel only" choice. */
export const TRAVEL_CATEGORIES: readonly BenefitCategory[] = [
  'travel_credit', 'airline_credit', 'hotel_credit', 'rideshare_credit',
  'free_night', 'upgrade', 'lounge_access',
];

/** Categories listed as a certificate or pass (counted in uses) even when a dollar value is recorded. */
const CERTIFICATE_CATEGORIES: readonly BenefitCategory[] = ['free_night', 'upgrade', 'lounge_access'];

/** Companion certificates are filed under "other" in the starting data but are plainly travel. */
const TRAVEL_TITLE = /\bcompanion\b/i;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date where the user is (not the UTC date). */
export function localIsoDate(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** A Date whose UTC calendar date is the given ISO date (noon, to stay clear of midnight). */
export function utcDateFor(iso: string): Date {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d, 12));
}

function isRealDate(iso: string | null | undefined): iso is string {
  if (!iso || !ISO_DATE.test(iso)) return false;
  const d = utcDateFor(iso);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** The day before an ISO date. */
export function dayBefore(iso: string): string {
  const d = utcDateFor(iso);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Last day of the month that `iso` falls in. */
export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
}

export function isTravel(category: BenefitCategory, title: string): boolean {
  return TRAVEL_CATEGORIES.includes(category) || (category === 'other' && TRAVEL_TITLE.test(title));
}

/**
 * The rows the Credits & Usages screen shows with its default filters: not
 * hidden, not an ongoing (unlimited) benefit, prerequisite tier reached, choice
 * option actually chosen, and no status tier beyond the next one to earn.
 * Mirrors the gating in src/components/BenefitDashboard.tsx.
 */
export function visibleOnCredits(projections: BenefitProjection[]): BenefitProjection[] {
  const achieved = new Set<number>();
  for (const p of projections) {
    if (p.uses_max === null || p.uses_count >= p.uses_max) achieved.add(p.benefit.id);
  }

  const usedAsParent = new Set<number>();
  for (const p of projections) {
    if (p.benefit.prerequisite_benefit_id) usedAsParent.add(p.benefit.prerequisite_benefit_id);
  }
  const chainNodes = projections.filter(p =>
    p.benefit.is_choice_option !== 1 &&
    (usedAsParent.has(p.benefit.id) ||
      (p.benefit.prerequisite_benefit_id != null && usedAsParent.has(p.benefit.prerequisite_benefit_id))));
  let chainVisible: Set<number> | null = null;
  if (chainNodes.length > 0) {
    const chainIds = new Set(chainNodes.map(n => n.benefit.id));
    const children = new Map<number, BenefitProjection[]>();
    for (const n of chainNodes) {
      const pid = n.benefit.prerequisite_benefit_id;
      if (pid == null) continue;
      children.set(pid, [...(children.get(pid) ?? []), n]);
    }
    const visible = new Set<number>();
    const walk = (node: BenefitProjection) => {
      if (visible.has(node.benefit.id)) return;
      visible.add(node.benefit.id);
      if (!achieved.has(node.benefit.id)) return;
      for (const child of children.get(node.benefit.id) ?? []) walk(child);
    };
    for (const root of chainNodes) {
      const pid = root.benefit.prerequisite_benefit_id;
      if (pid == null || !chainIds.has(pid)) walk(root);
    }
    chainVisible = visible;
  }

  return projections.filter(p => {
    const b = p.benefit;
    if (b.is_hidden === 1) return false;
    if (b.prerequisite_benefit_id && !achieved.has(b.prerequisite_benefit_id)) return false;
    if (b.is_choice_option === 1 && b.choice_selected !== 1) return false;
    if (chainVisible && b.is_choice_option !== 1) {
      const inChain = b.prerequisite_benefit_id != null || chainVisible.has(b.id) || usedAsParent.has(b.id);
      if (inChain && !chainVisible.has(b.id)) return false;
    }
    return b.reset_cadence !== 'unlimited';
  });
}

/** A certificate or pass: free nights, upgrades, lounge passes and companion certificates. */
export function isCertificate(p: BenefitProjection): boolean {
  return CERTIFICATE_CATEGORIES.includes(p.benefit.category) || TRAVEL_TITLE.test(p.benefit.title);
}

/** Certificate, dollar credit, or something else that has no dollar value recorded. */
export function kindOf(p: BenefitProjection): ExpiringItem['kind'] {
  if (isCertificate(p)) return 'certificate';
  return p.benefit.value_usd !== null && p.benefit.value_usd > 0 ? 'credit' : 'other';
}

const cents = (n: number): number => Math.round(n * 100) / 100;

/**
 * The date by which what is left must be used, or null when the app has no
 * such date (one-time benefits and spend unlocks without an expiration date).
 *
 * A dollar credit that resets each month, quarter, half-year or year loses its
 * balance on the last day of that period, so a later expiration date on the
 * benefit never postpones it; an earlier one brings it forward. A certificate
 * keeps its own recorded expiration date, which is often after the year ends.
 */
export function expiryFor(p: BenefitProjection): { expires_on: string; source: ExpiringItem['expiry_source'] } | null {
  const own = isRealDate(p.benefit.expiration_date) ? p.benefit.expiration_date : null;
  let periodEnd: string | null = null;
  switch (p.benefit.reset_cadence) {
    case 'monthly':
    case 'quarterly':
    case 'semiannual':
    case 'annual':
      periodEnd = isRealDate(p.next_reset) ? dayBefore(p.next_reset) : null;
      break;
    default:
      break;
  }
  if (own && periodEnd && kindOf(p) === 'credit' && periodEnd < own) return { expires_on: periodEnd, source: 'period' };
  if (own) return { expires_on: own, source: 'date' };
  return periodEnd ? { expires_on: periodEnd, source: 'period' } : null;
}

/** One projection as a printable row, or null when it is not an expiring credit or certificate. */
export function toExpiringItem(p: BenefitProjection, todayIso: string): ExpiringItem | null {
  const b = p.benefit;
  if (b.reset_cadence === 'unlimited' || b.reset_cadence === 'spend_threshold') return null;
  if (b.category === 'status_boost' || b.category === 'earning_multiplier') return null;
  if (isMilestone(b) || tracksEarnedNights(b) || isOmniStayBenefit(b)) return null;
  // Whether anything is left is decided below from the dollars or the uses,
  // not from the projection's status: a four-pass benefit with one pass logged
  // at its full dollar value still has three passes left.
  if (p.uses_max === null || p.status === 'locked' || p.status === 'unlimited' || p.status === 'expired') return null;

  const expiry = expiryFor(p);
  if (!expiry || expiry.expires_on < todayIso) return null;

  const perUse = b.value_usd !== null && b.value_usd > 0 ? b.value_usd : null;
  const total = perUse !== null ? perUse * p.uses_max : null;
  const usesRemaining = Math.max(0, p.uses_max - p.uses_count);
  const kind = kindOf(p);
  const counted = kind !== 'credit';

  let partially_used: boolean;
  let value_remaining_usd: number | null = null;
  if (counted) {
    if (usesRemaining <= 0) return null;
    partially_used = p.uses_count > 0;
  } else {
    // Whole cents, so ten 10-cent uses of a $1 credit leave nothing rather than a stray fraction.
    value_remaining_usd = cents(Math.max(0, total! - p.value_used_usd));
    if (value_remaining_usd <= 0) return null;
    partially_used = cents(p.value_used_usd) > 0;
  }

  const isCard = !!b.card_id;
  const label = certificateDisplay(b);
  return {
    benefit_id: b.id,
    title: label.title,
    owner_kind: isCard ? 'card' : 'program',
    owner_id: (isCard ? b.card_id : b.program_id) ?? '',
    owner_name: (isCard ? p.card_name : p.program_name) ?? '(unknown)',
    category: b.category,
    cadence: b.reset_cadence,
    is_travel: isTravel(b.category, b.title),
    kind,
    expires_on: expiry.expires_on,
    expiry_source: expiry.source,
    // Only a dollar credit is known to lapse when its period ends. For a certificate, pass or
    // other benefit the period end is how the app tracks it, not a deadline anyone published.
    date_not_recorded: kind !== 'credit' && expiry.source === 'period',
    partially_used,
    value_remaining_usd,
    value_total_usd: counted ? null : total,
    value_each_usd: counted ? perUse : null,
    uses_remaining: usesRemaining,
    uses_max: p.uses_max,
    note: [label.earnedLabel && `${label.earnedLabel}.`, airlinePurchaseRequirement(b), label.note?.trim()].filter(Boolean).join(' ') || null,
  };
}

/**
 * Everything with something left that must be used between today and the end
 * of next calendar year, soonest first. `projections` must be the current-year
 * projection computed for `todayIso`.
 */
export function buildExpiringReport(projections: BenefitProjection[], todayIso: string): ExpiringReport {
  const year = parseInt(todayIso.slice(0, 4), 10);
  const horizon = `${year + 1}-12-31`;
  const items: ExpiringItem[] = [];
  for (const p of visibleOnCredits(projections)) {
    const item = toExpiringItem(p, todayIso);
    if (item && item.expires_on <= horizon) items.push(item);
  }
  items.sort((a, b) =>
    a.expires_on.localeCompare(b.expires_on) ||
    a.owner_name.localeCompare(b.owner_name) ||
    a.title.localeCompare(b.title) ||
    a.benefit_id - b.benefit_id);
  return { today: todayIso, month_end: endOfMonth(todayIso), year_end: `${year}-12-31`, next_year_end: horizon, items };
}

export type ExpiringScope = 'month' | 'year';

export interface ExpiringSelection {
  scope: ExpiringScope;
  travelOnly: boolean;
  /** Also list certificates and passes that expire after the chosen period, through the end of next year. */
  includeLaterCertificates: boolean;
}

/** Whether an item belongs on the list for the chosen options (before the per-row ticks). */
export function matchesSelection(item: ExpiringItem, report: ExpiringReport, sel: ExpiringSelection): boolean {
  if (sel.travelOnly && !item.is_travel) return false;
  const limit = sel.scope === 'month' ? report.month_end : report.year_end;
  if (item.expires_on <= limit) return true;
  return sel.includeLaterCertificates
    && item.kind === 'certificate'
    && item.expires_on <= report.next_year_end;
}
