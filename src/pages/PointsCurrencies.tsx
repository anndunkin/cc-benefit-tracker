import { useEffect, useState } from 'react';
import type { PointsCurrency, PointsCurrencyInput, PointsCurrencyType } from '../../electron/types';
import { fmtCentsPerPoint, currencyTypeLabel } from '../lib/format';

/**
 * Points Currency Values tab — lists every PointsCurrency row grouped by
 * currency_type (transferable/airline/hotel), sourced from One Mile at a
 * Time (https://onemileatatime.com/guides/value-miles-points/) and refreshed
 * quarterly. Users can inline-edit a currency's value, which sets
 * is_user_modified so future quarterly refreshes never silently overwrite it.
 */
export default function PointsCurrencies() {
  const [currencies, setCurrencies] = useState<PointsCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<PointsCurrency | null>(null);

  async function reload() {
    setCurrencies(await window.api.pointsCurrencies.getAll());
  }
  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  if (loading) return <div className="text-slate-500">Loading…</div>;

  const groups: { type: PointsCurrencyType; label: string }[] = [
    { type: 'transferable', label: currencyTypeLabel('transferable') },
    { type: 'airline', label: currencyTypeLabel('airline') },
    { type: 'hotel', label: currencyTypeLabel('hotel') },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Points Currency Values</h1>
        <p className="text-sm text-slate-500 mt-1">
          Estimated redemption value per point/mile for every currency earned by your cards and programs.
          Values are sourced from{' '}
          <a className="text-primary-600 hover:underline" href="https://onemileatatime.com/guides/value-miles-points/" target="_blank" rel="noreferrer">
            One Mile at a Time
          </a>{' '}
          and refreshed quarterly. Edit a value to override it — your override is preserved across future refreshes.
        </p>
      </div>

      {groups.map(g => {
        const rows = currencies.filter(c => c.currency_type === g.type);
        return (
          <div key={g.type} className="card">
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-lg font-semibold">{g.label}</h2>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.length === 0 && (
                <div className="p-4 text-center text-sm text-slate-500">No currencies in this group.</div>
              )}
              {rows.map(c => (
                <div key={c.id} className="p-4 flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium leading-tight">
                      {c.name}
                      {c.is_user_modified === 1 && <span className="ml-2 text-xs text-amber-600" title="User modified">✎</span>}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {c.source_url ? (
                        <a className="text-primary-600 hover:underline" href={c.source_url} target="_blank" rel="noreferrer">{c.source_name}</a>
                      ) : c.source_name}
                    </div>
                    {c.notes && <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">{c.notes}</div>}
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-lg">{fmtCentsPerPoint(c.value_cents_per_point)}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-xs">
                    <button className="text-slate-500 hover:text-primary-600" onClick={() => setEditing(c)}>Edit</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {editing && (
        <PointsCurrencyEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}

/** Inline edit modal — mirrors the BenefitEditor.tsx create/edit form pattern. */
function PointsCurrencyEditor({
  initial, onClose, onSaved,
}: { initial: PointsCurrency; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<PointsCurrencyInput>(() => ({
    name: initial.name,
    currency_type: initial.currency_type,
    value_cents_per_point: initial.value_cents_per_point,
    source_name: initial.source_name,
    source_url: initial.source_url ?? '',
    notes: initial.notes ?? '',
    is_active: initial.is_active,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!Number.isFinite(form.value_cents_per_point)) { setErr('Value (¢ per point) must be a number.'); return; }
    setSaving(true); setErr(null);
    try {
      const payload: Partial<PointsCurrencyInput> = {
        value_cents_per_point: form.value_cents_per_point,
        source_name: form.source_name?.trim() || 'One Mile at a Time',
        source_url: form.source_url?.trim() || null,
        notes: form.notes?.trim() || null,
      };
      // This sets is_user_modified = 1 server-side (pointsCurrencyUpdate),
      // which future quarterly refreshes will respect and never overwrite.
      await window.api.pointsCurrencies.update(initial.id, payload);
      onSaved();
    } catch (e) { setErr(String(e)); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-lg max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">Edit {initial.name}</h2>
        <p className="text-xs text-slate-500 mb-3">
          Overriding this value marks it as user-modified — future quarterly refreshes will propose new figures
          but will never silently overwrite your override.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Value (¢ per point)</label>
            <input type="number" step="0.1" className="input"
              value={form.value_cents_per_point}
              onChange={e => setForm({ ...form, value_cents_per_point: parseFloat(e.target.value) || 0 })} />
          </div>
          <div className="col-span-2">
            <label className="label">Source name</label>
            <input className="input" value={form.source_name ?? ''}
              onChange={e => setForm({ ...form, source_name: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Source URL</label>
            <input className="input" value={form.source_url ?? ''}
              onChange={e => setForm({ ...form, source_url: e.target.value })}
              placeholder="https://onemileatatime.com/guides/value-miles-points/" />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <textarea className="input min-h-[3rem]" value={form.notes ?? ''}
              onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>

        {err && <div className="text-sm text-red-600 mt-3">{err}</div>}

        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
