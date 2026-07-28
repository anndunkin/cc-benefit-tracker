import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Card, CardInput, CardNetwork } from '../../electron/types';
import { fmtUsd } from '../lib/format';

const NETWORKS: CardNetwork[] = ['Amex', 'Visa', 'Mastercard', 'Other'];

export default function Cards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [benefitCounts, setBenefitCounts] = useState<Record<string, number>>({});
  const [showAdd, setShowAdd] = useState(false);

  async function reload() {
    const list = await window.api.cards.getAll();
    setCards(list);
    const all = await window.api.benefits.getAll();
    const counts: Record<string, number> = {};
    for (const b of all) if (b.card_id) counts[b.card_id] = (counts[b.card_id] ?? 0) + 1;
    setBenefitCounts(counts);
  }
  useEffect(() => { reload(); }, []);

  async function del(id: string, name: string) {
    if (!confirm(`Delete "${name}" and all its benefits and usage history? This cannot be undone.`)) return;
    await window.api.cards.delete(id);
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Cards</h1>
        <span className="text-sm text-slate-500">{cards.length} total</span>
        <button className="btn-primary ml-auto" onClick={() => setShowAdd(true)}>+ Add card</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {cards.map(c => (
          <Link key={c.id} to={`/cards/${c.id}`}
            className="card p-4 hover:border-primary-400 transition-colors">
            <div className="flex items-start gap-3">
              {c.color_hex && <span className="inline-block w-3 h-8 rounded" style={{ backgroundColor: c.color_hex }} />}
              <div className="flex-1 min-w-0">
                <div className="font-semibold leading-tight">{c.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{c.issuer} · {c.network}</div>
              </div>
              {!c.is_active && <span className="text-xs bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded">Inactive</span>}
            </div>
            <div className="mt-3 flex justify-between text-sm">
              <span className="text-slate-500">Annual fee</span>
              <span className="font-mono">{fmtUsd(c.annual_fee_usd)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Benefits</span>
              <span>{benefitCounts[c.id] ?? 0}</span>
            </div>
            <div className="mt-2 flex justify-end gap-2 text-xs">
              <button onClick={(e) => { e.preventDefault(); del(c.id, c.name); }}
                className="text-red-500 hover:text-red-700">Delete</button>
            </div>
          </Link>
        ))}
      </div>

      {showAdd && <AddCardModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
    </div>
  );
}

function AddCardModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<CardInput>({
    name: '', issuer: '', network: 'Visa', annual_fee_usd: null, source_url: '', notes: '', color_hex: '#0ea5e9',
  });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!form.name.trim() || !form.issuer.trim()) { setErr('Name and issuer are required.'); return; }
    setSaving(true); setErr(null);
    try {
      await window.api.cards.create({
        ...form,
        name: form.name.trim(),
        issuer: form.issuer.trim(),
        source_url: form.source_url?.trim() || null,
        notes: form.notes?.trim() || null,
      });
      onSaved();
    } catch (e) { setErr(String(e)); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-3">Add card</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Name *</label>
            <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Issuer *</label>
            <input className="input" value={form.issuer} onChange={e => setForm({ ...form, issuer: e.target.value })} />
          </div>
          <div>
            <label className="label">Network</label>
            <select className="input" value={form.network} onChange={e => setForm({ ...form, network: e.target.value as CardNetwork })}>
              {NETWORKS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Annual fee (USD)</label>
            <input type="number" className="input" value={form.annual_fee_usd ?? ''}
              onChange={e => setForm({ ...form, annual_fee_usd: e.target.value === '' ? null : parseFloat(e.target.value) })} />
          </div>
          <div>
            <label className="label">Color</label>
            <input type="color" className="h-10 w-full rounded border border-slate-300 dark:border-slate-700"
              value={form.color_hex ?? '#0ea5e9'} onChange={e => setForm({ ...form, color_hex: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="label">Source URL</label>
            <input className="input" value={form.source_url ?? ''} onChange={e => setForm({ ...form, source_url: e.target.value })}
              placeholder="Official issuer page" />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <input className="input" value={form.notes ?? ''} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        {err && <div className="text-sm text-red-600 mt-2">{err}</div>}
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
