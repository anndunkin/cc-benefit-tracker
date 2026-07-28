import { useEffect, useState } from 'react';
import type { Benefit, Usage } from '../../electron/types';
import { fmtUsd } from '../lib/format';

export default function LogUsageModal({
  benefitId, onClose, onSaved,
}: { benefitId: number; onClose: () => void; onSaved: () => void }) {
  const [benefit, setBenefit] = useState<Benefit | null>(null);
  const [history, setHistory] = useState<Usage[]>([]);
  const today = new Date().toISOString().slice(0, 10);
  const [usedOn, setUsedOn] = useState(today);
  const [amount, setAmount] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      window.api.benefits.getById(benefitId),
      window.api.usages.getForBenefit(benefitId),
    ]).then(([b, u]) => {
      setBenefit(b);
      setHistory(u);
      // Only prefill the amount when this is a dollar-valued benefit.
      // Count-based benefits (SkyClub visits, upgrade certificates, etc.)
      // record no dollar amount — leave the field empty and hide it.
      if (b && (b.value_usd ?? 0) > 0) setAmount(String(b.value_usd));
    });
  }, [benefitId]);

  // A benefit is "count-based" when it has no per-use dollar value. Logging
  // one of these should not prompt for a dollar amount — it is a visit /
  // certificate / upgrade count only. Applies to SkyClub visits, Centurion
  // guest visits, systemwide upgrades, etc.
  const isCountBased = !!benefit && (benefit.value_usd == null || benefit.value_usd === 0);

  async function save() {
    setSaving(true); setErr(null);
    try {
      await window.api.usages.create({
        benefit_id: benefitId,
        used_on: usedOn,
        // Count-based benefits never carry a dollar amount.
        amount_usd: isCountBased ? null : (amount === '' ? null : parseFloat(amount)),
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  }

  async function del(id: number) {
    if (!confirm('Delete this usage entry?')) return;
    await window.api.usages.delete(id);
    setHistory(await window.api.usages.getForBenefit(benefitId));
    // v1.0.6 fix: also refresh the dashboard so the deleted usage disappears
    // from the parent card's counters/progress. Previously the modal refreshed
    // its own history but the dashboard state was stale until reload.
    onSaved();
  }

  if (!benefit) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">Log usage</h2>
            <div className="text-sm text-slate-500">{benefit.title}</div>
          </div>
          <button className="btn-ghost text-xs" onClick={onClose}>Close</button>
        </div>

        <div className={isCountBased ? '' : 'grid grid-cols-2 gap-3'}>
          <div>
            <label className="label">Date used</label>
            <input type="date" className="input" value={usedOn} onChange={e => setUsedOn(e.target.value)} />
          </div>
          {!isCountBased && (
            <div>
              <label className="label">Amount (USD)</label>
              <input type="number" step="0.01" className="input" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder={benefit.value_usd?.toString() ?? '0.00'} />
            </div>
          )}
        </div>
        <div className="mt-3">
          <label className="label">Notes</label>
          <input type="text" className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional context (hotel name, purchase, etc.)" />
        </div>

        {err && <div className="text-sm text-red-600 mt-2">{err}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>

        {history.length > 0 && (
          <div className="mt-6">
            <div className="label mb-2">History</div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800 max-h-52 overflow-auto">
              {history.map(u => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="font-mono text-xs w-24 text-slate-500">{u.used_on}</span>
                  {isCountBased ? (
                    <span className="font-mono w-20 text-slate-500">1 use</span>
                  ) : (
                    <span className="font-mono w-20">{fmtUsd(u.amount_usd)}</span>
                  )}
                  <span className="text-xs text-slate-500 flex-1 truncate">{u.notes ?? ''}</span>
                  <button className="text-xs text-red-500 hover:text-red-700" onClick={() => del(u.id)}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
