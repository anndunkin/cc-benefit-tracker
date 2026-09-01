import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Benefit, Card } from '../../electron/types';
import { ALL_SPEND_CATEGORIES, spendCategoryLabel } from '../lib/format';

/**
 * Bonus Categories tab — groups every `earning_multiplier` benefit that has a
 * structured `spend_category` across ALL cards into one bucket per
 * SpendCategory, sorted by `multiplier_rate` descending within each bucket.
 * Statement-credit benefits (any other category) are intentionally excluded;
 * this page only covers earning multipliers. Modeled after CardDetail.tsx /
 * ProgramDetail.tsx for consistent card-list styling.
 */
export default function BonusCategories() {
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([window.api.benefits.getAll(), window.api.cards.getAll()])
      .then(([bs, cs]) => { setBenefits(bs); setCards(cs); })
      .finally(() => setLoading(false));
  }, []);

  const cardById = useMemo(() => {
    const m = new Map<string, Card>();
    for (const c of cards) m.set(c.id, c);
    return m;
  }, [cards]);

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
      list.sort((a, z) => (z.multiplier_rate ?? 0) - (a.multiplier_rate ?? 0));
    }
    return buckets;
  }, [benefits]);

  if (loading) return <div className="text-slate-500">Loading…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Bonus Categories</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every card's points-earning multiplier, grouped by spend category, so you can see at a glance
          which card to pull out for a given purchase. Statement credits and other non-earning benefits
          are not shown here — see each card's detail page for those.
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
                return (
                  <div key={b.id} className="p-4 flex items-start gap-4">
                    <div className="w-16 shrink-0 text-right">
                      <span className="font-mono text-xl font-bold text-primary-600">
                        {b.multiplier_rate ?? '—'}x
                      </span>
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
