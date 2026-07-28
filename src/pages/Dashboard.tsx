import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BenefitProjection, Card, Program } from '../../electron/types';
import { fmtUsd, cadenceLabel, categoryLabel, statusColor, daysUntil } from '../lib/format';
import LogUsageModal from '../components/LogUsageModal';

type SectionKey = 'all' | 'cards' | 'programs';
type CadenceFilter = 'all' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' | 'unlimited' | 'other';

export default function Dashboard() {
  const now = new Date();
  const [refYear, setRefYear] = useState<number>(now.getUTCFullYear());
  const [projections, setProjections] = useState<BenefitProjection[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [section, setSection] = useState<SectionKey>('all');
  const [cadence, setCadence] = useState<CadenceFilter>('all');
  const [showExhausted, setShowExhausted] = useState(true);
  const [modalBenefitId, setModalBenefitId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    const [proj, cs, ps] = await Promise.all([
      window.api.projection.all(refYear),
      window.api.cards.getAll(),
      window.api.programs.getAll(),
    ]);
    setProjections(proj); setCards(cs); setPrograms(ps);
    setLoading(false);
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [refYear]);

  const filtered = useMemo(() => {
    return projections.filter(p => {
      if (section === 'cards' && !p.benefit.card_id) return false;
      if (section === 'programs' && !p.benefit.program_id) return false;
      if (cadence === 'other') {
        if (['annual','semiannual','quarterly','monthly','unlimited'].includes(p.benefit.reset_cadence)) return false;
      } else if (cadence !== 'all') {
        if (p.benefit.reset_cadence !== cadence) return false;
      }
      if (!showExhausted && p.status === 'exhausted') return false;
      return true;
    });
  }, [projections, section, cadence, showExhausted]);

  const grouped = useMemo(() => {
    const map = new Map<string, BenefitProjection[]>();
    for (const p of filtered) {
      const key = p.benefit.card_id ? `card:${p.benefit.card_id}` : `program:${p.benefit.program_id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries()).map(([key, items]) => {
      const isCard = key.startsWith('card:');
      const id = key.split(':')[1];
      const owner: Card | Program | undefined = isCard
        ? cards.find(c => c.id === id)
        : programs.find(p => p.id === id);
      return { key, isCard, id, name: owner?.name ?? '(unknown)', color: (owner as any)?.color_hex ?? null, items };
    });
  }, [filtered, cards, programs]);

  const totals = useMemo(() => {
    let value_remaining = 0, value_used = 0;
    for (const p of filtered) {
      if (p.value_remaining_usd !== null) value_remaining += p.value_remaining_usd;
      value_used += p.value_used_usd;
    }
    return { value_remaining, value_used };
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex gap-1 rounded-lg border border-slate-200 dark:border-slate-800 p-1">
          {[refYear - 1, refYear, refYear + 1].map((y, i) => {
            const target = refYear + (i - 1);
            return (
              <button
                key={target}
                className={`px-3 py-1 rounded text-sm font-medium ${
                  target === refYear
                    ? 'bg-primary-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
                }`}
                onClick={() => setRefYear(target)}
              >
                {target}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex gap-4 text-sm">
          <div className="text-right">
            <div className="text-xs text-slate-500">Value remaining ({refYear})</div>
            <div className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-lg">
              {fmtUsd(totals.value_remaining)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Value used</div>
            <div className="font-mono font-bold text-slate-600 dark:text-slate-400 text-lg">
              {fmtUsd(totals.value_used)}
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center text-sm">
        <div className="flex gap-1 rounded-lg border border-slate-200 dark:border-slate-800 p-1">
          {(['all','cards','programs'] as SectionKey[]).map(s => (
            <button key={s}
              className={`px-3 py-1 rounded text-xs font-medium capitalize ${
                s === section ? 'bg-slate-200 dark:bg-slate-800' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
              onClick={() => setSection(s)}
            >
              {s}
            </button>
          ))}
        </div>
        <select className="input max-w-[10rem]" value={cadence} onChange={e => setCadence(e.target.value as CadenceFilter)}>
          <option value="all">All cadences</option>
          <option value="annual">Annual</option>
          <option value="semiannual">Semi-annual</option>
          <option value="quarterly">Quarterly</option>
          <option value="monthly">Monthly</option>
          <option value="unlimited">Unlimited</option>
          <option value="other">Other</option>
        </select>
        <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={showExhausted} onChange={e => setShowExhausted(e.target.checked)} />
          Show exhausted
        </label>
        {loading && <span className="text-xs text-slate-400">Loading…</span>}
      </div>

      {/* Grouped cards */}
      {grouped.length === 0 ? (
        <div className="card p-8 text-center text-slate-500">
          No benefits match the current filters. Head to <Link to="/benefits" className="text-primary-600 underline">Manage Benefits</Link> to add one.
        </div>
      ) : (
        grouped.map(g => (
          <section key={g.key} className="card p-4">
            <div className="flex items-center gap-3 mb-3">
              {g.color && <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: g.color }} />}
              <h2 className="text-lg font-semibold">
                <Link to={g.isCard ? `/cards/${g.id}` : `/programs/${g.id}`} className="hover:text-primary-600">
                  {g.name}
                </Link>
              </h2>
              <span className="text-xs text-slate-500 uppercase tracking-wide">{g.isCard ? 'Card' : 'Program'}</span>
              <span className="ml-auto text-xs text-slate-500">{g.items.length} benefit{g.items.length === 1 ? '' : 's'}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {g.items.map(p => (
                <BenefitTile key={p.benefit.id} p={p} onLogUsage={() => setModalBenefitId(p.benefit.id)} />
              ))}
            </div>
          </section>
        ))
      )}

      {modalBenefitId !== null && (
        <LogUsageModal
          benefitId={modalBenefitId}
          onClose={() => setModalBenefitId(null)}
          onSaved={() => { setModalBenefitId(null); reload(); }}
        />
      )}
    </div>
  );
}

function BenefitTile({ p, onLogUsage }: { p: BenefitProjection; onLogUsage: () => void }) {
  const b = p.benefit;
  const usesMax = p.uses_max;
  const usesCount = p.uses_count;
  const pct = usesMax === null ? 100 : Math.min(100, (usesCount / Math.max(1, usesMax)) * 100);
  const daysToReset = daysUntil(p.next_reset);

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex flex-col gap-2 bg-slate-50 dark:bg-slate-900/40">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${statusColor(p.status)}`} title={p.status} />
        <div className="flex-1 min-w-0">
          <div className="font-medium leading-tight break-words">{b.title}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {cadenceLabel(b.reset_cadence)} · {categoryLabel(b.category)} · {p.period_label}
          </div>
        </div>
        {b.value_usd !== null && (
          <div className="text-right shrink-0">
            <div className="text-xs text-slate-500">per use</div>
            <div className="font-mono text-sm">{fmtUsd(b.value_usd)}</div>
          </div>
        )}
      </div>

      {b.reset_cadence !== 'unlimited' && (
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-500">
              {usesCount} of {usesMax ?? '∞'} used
            </span>
            <span className="text-slate-500">
              {p.value_remaining_usd !== null ? `${fmtUsd(p.value_remaining_usd)} left` : ''}
            </span>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
            <div
              className={`h-full ${p.status === 'exhausted' ? 'bg-slate-400' : 'bg-primary-500'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {b.expiration_note && (
        <div className="text-xs text-amber-700 dark:text-amber-400">⏱ {b.expiration_note}</div>
      )}
      {daysToReset !== null && p.status !== 'unlimited' && daysToReset <= 30 && daysToReset >= 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400">Resets in {daysToReset} day{daysToReset === 1 ? '' : 's'}</div>
      )}
      {b.spend_threshold_usd !== null && (
        <div className="text-xs text-purple-700 dark:text-purple-400">
          Unlocks at {fmtUsd(b.spend_threshold_usd)} spend
        </div>
      )}

      <div className="flex items-center gap-2 mt-1">
        <button className="btn-primary text-xs py-1 px-2" onClick={onLogUsage}>
          + Log usage
        </button>
        {b.source_url && (
          <a href={b.source_url} target="_blank" rel="noreferrer noopener" className="text-xs text-slate-500 hover:text-primary-600">
            Source ↗
          </a>
        )}
        {p.usages.length > 0 && (
          <span className="ml-auto text-xs text-slate-400">
            last: {p.usages[0].used_on}
            {p.usages[0].amount_usd !== null ? ` · ${fmtUsd(p.usages[0].amount_usd)}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}
