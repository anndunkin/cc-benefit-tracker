import { useEffect, useState } from 'react';
import type { Benefit, BenefitInput, BenefitCategory, ResetCadence } from '../../electron/types';
import { ALL_CATEGORIES, ALL_CADENCES, cadenceLabel, categoryLabel } from '../lib/format';

interface Props {
  initial?: Benefit;                       // if present, editing; else creating
  ownerType: 'card' | 'program';
  ownerId: string;
  onClose: () => void;
  onSaved: () => void;
}

/** Reusable create/edit form used by CardDetail, ProgramDetail, and ManageBenefits. */
export default function BenefitEditor({ initial, ownerType, ownerId, onClose, onSaved }: Props) {
  const [form, setForm] = useState<BenefitInput>(() => ({
    card_id: ownerType === 'card' ? ownerId : null,
    program_id: ownerType === 'program' ? ownerId : null,
    title: initial?.title ?? '',
    description: initial?.description ?? '',
    category: initial?.category ?? 'other',
    reset_cadence: initial?.reset_cadence ?? 'annual',
    uses_per_period: initial?.uses_per_period ?? 1,
    value_usd: initial?.value_usd ?? null,
    spend_threshold_usd: initial?.spend_threshold_usd ?? null,
    expiration_note: initial?.expiration_note ?? '',
    sort_order: initial?.sort_order ?? 0,
    source_url: initial?.source_url ?? '',
    notes: initial?.notes ?? '',
    is_active: initial?.is_active ?? 1,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // When cadence changes, seed sane defaults for uses_per_period.
    setForm((f: BenefitInput) => {
      const next = { ...f };
      const c = f.reset_cadence;
      if (c === 'unlimited') next.uses_per_period = null;
      else if (c === 'monthly' && (!f.uses_per_period || f.uses_per_period === 1 || f.uses_per_period === 12)) next.uses_per_period = 1;
      else if (c === 'quarterly' && (!f.uses_per_period || f.uses_per_period === 4 || f.uses_per_period === 1)) next.uses_per_period = 1;
      else if (c === 'one_time') next.uses_per_period = 1;
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.reset_cadence]);

  async function save() {
    if (!form.title.trim()) { setErr('Title is required.'); return; }
    setSaving(true); setErr(null);
    try {
      const payload: BenefitInput = {
        ...form,
        title: form.title.trim(),
        description: form.description?.trim() || null,
        expiration_note: form.expiration_note?.trim() || null,
        source_url: form.source_url?.trim() || null,
        notes: form.notes?.trim() || null,
      };
      if (initial) await window.api.benefits.update(initial.id, payload);
      else await window.api.benefits.create(payload);
      onSaved();
    } catch (e) { setErr(String(e)); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-2xl max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-3">{initial ? 'Edit benefit' : 'Add benefit'}</h2>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Title *</label>
            <input className="input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Description</label>
            <textarea className="input min-h-[3.5rem]" value={form.description ?? ''} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <label className="label">Category</label>
            <select className="input" value={form.category} onChange={e => setForm({ ...form, category: e.target.value as BenefitCategory })}>
              {ALL_CATEGORIES.map(c => <option key={c} value={c}>{categoryLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Reset cadence</label>
            <select className="input" value={form.reset_cadence}
              onChange={e => setForm({ ...form, reset_cadence: e.target.value as ResetCadence })}>
              {ALL_CADENCES.map(c => <option key={c} value={c}>{cadenceLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Uses per period</label>
            <input type="number" className="input"
              value={form.uses_per_period ?? ''}
              disabled={form.reset_cadence === 'unlimited'}
              onChange={e => setForm({ ...form, uses_per_period: e.target.value === '' ? null : parseInt(e.target.value, 10) })} />
          </div>
          <div>
            <label className="label">Value per use (USD)</label>
            <input type="number" step="0.01" className="input"
              value={form.value_usd ?? ''}
              onChange={e => setForm({ ...form, value_usd: e.target.value === '' ? null : parseFloat(e.target.value) })} />
          </div>
          {form.reset_cadence === 'spend_threshold' && (
            <div className="col-span-2">
              <label className="label">Spend threshold (USD)</label>
              <input type="number" step="0.01" className="input"
                value={form.spend_threshold_usd ?? ''}
                onChange={e => setForm({ ...form, spend_threshold_usd: e.target.value === '' ? null : parseFloat(e.target.value) })} />
            </div>
          )}
          <div className="col-span-2">
            <label className="label">Expiration note</label>
            <input className="input" value={form.expiration_note ?? ''}
              onChange={e => setForm({ ...form, expiration_note: e.target.value })}
              placeholder="e.g., Certificate expires 12/31/2026" />
          </div>
          <div className="col-span-2">
            <label className="label">Source URL</label>
            <input className="input" value={form.source_url ?? ''}
              onChange={e => setForm({ ...form, source_url: e.target.value })}
              placeholder="Official issuer page" />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <textarea className="input min-h-[3rem]" value={form.notes ?? ''}
              onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div>
            <label className="label">Sort order</label>
            <input type="number" className="input" value={form.sort_order ?? 0}
              onChange={e => setForm({ ...form, sort_order: parseInt(e.target.value, 10) || 0 })} />
          </div>
          <div>
            <label className="label">Active</label>
            <select className="input" value={form.is_active ?? 1}
              onChange={e => setForm({ ...form, is_active: parseInt(e.target.value, 10) })}>
              <option value={1}>Active</option>
              <option value={0}>Inactive (hidden)</option>
            </select>
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
