import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Benefit, Card, PointsCurrency } from '../../electron/types';
import {
  ALL_SPEND_CATEGORIES, spendCategoryLabel,
  MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID, perDollarValue, fmtPerDollarValue,
} from '../lib/format';

/**
 * Bonus Categories tab — groups every `earning_multiplier` benefit that has a
 * structured `spend_category` across ALL cards into one bucket per
 * SpendCategory. Within each bucket, rows are ranked by their per-dollar cash
 * value (multiplier_rate x the point's cents-per-point value from the Points
 * Currency Values tab), most valuable first — not just by raw points
 * multiplier, since e.g. 3x Delta SkyMiles (¢1.1/pt → 3.3¢/$1) can beat 5x
 * IHG points (¢0.5/pt → 2.5¢/$1). Rows whose currency has no recorded point
 * value sort to the bottom of their bucket. Statement-credit benefits (any
 * other category) are intentionally excluded; this page only covers earning
 * multipliers. Modeled after CardDetail.tsx / ProgramDetail.tsx for
 * consistent card-list styling.
 */
export default function BonusCategories() {
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [currencies, setCurrencies] = useState<PointsCurrency[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([window.api.benefits.getAll(), window.api.cards.getAll(), window.api.pointsCurrencies.getAll()])
      .then(([bs, cs, pcs]) => { setBenefits(bs); setCards(cs); setCurrencies(pcs); })
      .finally(() => setLoading(false));
  }, []);

  const cardById = useMemo(() => {
    const m = new Map<string, Card>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

  /** cents-per-point lookup keyed by a benefit's multiplier_currency label. */
  const centsPerPointByLabel = useMemo(() => {
    const byId = new Map<string, PointsCurrency>();
    for (const c of currencies) byId.set(c.id, c);
    const m = new Map<string, number>();
    for (const [label, currencyId] of Object.entries(MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID)) {
      const currency = byId.get(currencyId);
      if (currency) m.set(label, currency.value_cents_per_point);
    }
    return m;
  }, [currencies]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, Benefit[]>();
    for (const cat of ALL_SPEND_CATEGORIES) buckets.set(cat, []);
    for (const b of benefits) {
      if (b.category !== 'earning_multiplier') continue;
      if (!b.spend_category) continue; // only structured rows can be grouped
      const list = buckets.get(b.spend_category);
      if (list) list.push(b);
    }
    for (const list of buckets.values()) {
      list.sort((a, z) => {
        const aValue = perDollarValue(a.multiplier_rate, a.multiplier_currency ? centsPerPointByLabel.get(a.multiplier_currency) : undefined);
        const zValue = perDollarValue(z.multiplier_rate, z.multiplier_currency ? centsPerPointByLabel.get(z.multiplier_currency) : undefined);
        // Known values rank above unknown ones; ties/unknowns fall back to the
        // raw points multiplier so the ordering still makes sense.
        if (aValue !== null && zValue !== null) return zValue - aValue;
        if (aValue !== null) return -1;
        if (zValue !== null) return 1;
        return (z.multiplier_rate ?? 0) - (a.multiplier_rate ?? 0);
      });
    }
    return buckets;
  }, [benefits, centsPerPointByLabel]);

  if (loading) return <div className="text-slate-500">Loading…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Bonus Categories</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every card's points-earning multiplier, grouped by spend category and ranked by real cash-back
          value — the points multiplier times each currency's per-point value from the Points Currency
          Values tab — so you can see at a glance which card actually pays the most for a given purchase.
          Statement credits and other non-earning benefits are not shown here — see each card's detail page
          for those.
        </p>
      </div>

      {ALL_SPEND_CATEGORIES.map(cat => {
        const rows = grouped.get(cat) ?? [];
        return (
          <div key={cat} className="card">
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-lg font-semibold">{spendCategoryLabel(cat)}</h2>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.length === 0 && (
                <div className="p-4 text-center text-sm text-slate-500">No earning multipliers recorded for this category.</div>
              )}
              {rows.map(b => {
                const card = b.card_id ? cardById.get(b.card_id) : null;
                const centsPerPoint = b.multiplier_currency ? centsPerPointByLabel.get(b.multiplier_currency) : undefined;
                const value = perDollarValue(b.multiplier_rate, centsPerPoint);
                return (
                  <div key={b.id} className="p-4 flex items-start gap-4">
                    <div className="w-24 shrink-0 text-right">
                      <span className="font-mono text-xl font-bold text-primary-600">
                        {b.multiplier_rate ?? '—'}x
                      </span>
                      <div className={`text-xs font-medium mt-0.5 ${value !== null ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 italic'}`}>
                        {fmtPerDollarValue(value)}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium leading-tight">
                        {card ? (
                          <Link to={`/cards/${card.id}`} className="hover:text-primary-600">{card.name}</Link>
                        ) : (
                          <span>{b.title}</span>
                        )}
                        {card && <span className="text-slate-500 font-normal"> — {b.multiplier_currency ?? 'points'}</span>}
                      </div>
                      {card && <div className="text-xs text-slate-500 mt-0.5">{card.issuer} · {card.network}</div>}
                      {b.spend_category_note && (
                        <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">{b.spend_category_note}</div>
                      )}
                      {b.source_url && (
                        <a className="text-xs text-primary-600 hover:underline mt-1 inline-block" href={b.source_url} target="_blank" rel="noreferrer">
                          Official source ↗
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
