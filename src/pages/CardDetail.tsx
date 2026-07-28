import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Benefit, Card, BenefitProjection } from '../../electron/types';
import { fmtUsd, cadenceLabel, categoryLabel, statusColor } from '../lib/format';
import BenefitEditor from '../components/BenefitEditor';
import LogUsageModal from '../components/LogUsageModal';

export default function CardDetail() {
  const { id } = useParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [projections, setProjections] = useState<Map<number, BenefitProjection>>(new Map());
  const [editorBenefit, setEditorBenefit] = useState<Benefit | 'new' | null>(null);
  const [logBenefitId, setLogBenefitId] = useState<number | null>(null);

  async function reload() {
    if (!id) return;
    const [c, bs, projAll] = await Promise.all([
      window.api.cards.getById(id),
      window.api.benefits.getForCard(id),
      window.api.projection.all(new Date().getUTCFullYear()),
    ]);
    setCard(c); setBenefits(bs);
    const map = new Map<number, BenefitProjection>();
    for (const p of projAll) map.set(p.benefit.id, p);
    setProjections(map);
  }
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function delBenefit(b: Benefit) {
    if (!confirm(`Delete "${b.title}" and its usage history?`)) return;
    await window.api.benefits.delete(b.id);
    reload();
  }

  if (!card) return <div className="text-slate-500">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/cards" className="text-sm text-slate-500 hover:text-primary-600">← Cards</Link>
      </div>
      <div className="card p-5">
        <div className="flex items-start gap-4">
          {card.color_hex && <span className="inline-block w-4 h-12 rounded" style={{ backgroundColor: card.color_hex }} />}
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{card.name}</h1>
            <div className="text-sm text-slate-500 mt-1">{card.issuer} · {card.network}</div>
            {card.notes && <div className="text-sm text-slate-500 mt-2">{card.notes}</div>}
            {card.source_url && (
              <a className="text-xs text-primary-600 hover:underline mt-1 inline-block" href={card.source_url} target="_blank" rel="noreferrer">
                Official page ↗
              </a>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Annual fee</div>
            <div className="font-mono text-lg">{fmtUsd(card.annual_fee_usd)}</div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Benefits ({benefits.length})</h2>
        <button className="btn-primary ml-auto text-sm" onClick={() => setEditorBenefit('new')}>+ Add benefit</button>
      </div>

      <div className="card divide-y divide-slate-200 dark:divide-slate-800">
        {benefits.length === 0 && (
          <div className="p-6 text-center text-slate-500">
            No benefits yet. Add one to start tracking usage.
          </div>
        )}
        {benefits.map(b => {
          const p = projections.get(b.id);
          return (
            <div key={b.id} className="p-4 flex items-start gap-4">
              <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${statusColor(p?.status ?? 'available')}`} />
              <div className="flex-1 min-w-0">
                <div className="font-medium leading-tight">
                  {b.title}{b.is_user_modified === 1 && <span className="ml-2 text-xs text-amber-600" title="User modified">✎</span>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {cadenceLabel(b.reset_cadence)} · {categoryLabel(b.category)}
                  {b.value_usd !== null && ` · ${fmtUsd(b.value_usd)}/use`}
                  {p && ` · ${p.uses_count} of ${p.uses_max ?? '∞'} used (${p.period_label})`}
                </div>
                {b.description && <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">{b.description}</div>}
                {b.expiration_note && <div className="text-xs text-amber-700 dark:text-amber-400 mt-1">⏱ {b.expiration_note}</div>}
              </div>
              <div className="flex flex-col items-end gap-1 text-xs">
                <button className="btn-primary text-xs py-1 px-2" onClick={() => setLogBenefitId(b.id)}>+ Log</button>
                <button className="text-slate-500 hover:text-primary-600" onClick={() => setEditorBenefit(b)}>Edit</button>
                <button className="text-red-500 hover:text-red-700" onClick={() => delBenefit(b)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {editorBenefit && (
        <BenefitEditor
          initial={editorBenefit === 'new' ? undefined : editorBenefit}
          ownerType="card"
          ownerId={card.id}
          onClose={() => setEditorBenefit(null)}
          onSaved={() => { setEditorBenefit(null); reload(); }}
        />
      )}
      {logBenefitId !== null && (
        <LogUsageModal benefitId={logBenefitId} onClose={() => setLogBenefitId(null)} onSaved={() => { setLogBenefitId(null); reload(); }} />
      )}
    </div>
  );
}
