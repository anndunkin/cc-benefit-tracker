import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Program, ProgramInput, ProgramType } from '../../electron/types';

const TYPES: ProgramType[] = ['airline', 'hotel', 'airline_elite_status', 'hotel_elite_status', 'hotel_paid_membership', 'other'];
const TYPE_LABELS: Record<ProgramType, string> = {
  airline: 'Airline',
  hotel: 'Hotel',
  airline_elite_status: 'Airline elite status',
  hotel_elite_status: 'Hotel elite status',
  hotel_paid_membership: 'Hotel paid membership',
  other: 'Other',
};

export default function Programs() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [benefitCounts, setBenefitCounts] = useState<Record<string, number>>({});
  const [showAdd, setShowAdd] = useState(false);

  async function reload() {
    setPrograms(await window.api.programs.getAll());
    const all = await window.api.benefits.getAll();
    const counts: Record<string, number> = {};
    for (const b of all) if (b.program_id) counts[b.program_id] = (counts[b.program_id] ?? 0) + 1;
    setBenefitCounts(counts);
  }
  useEffect(() => { reload(); }, []);

  async function del(id: string, name: string) {
    if (!confirm(`Delete "${name}" and all its benefits? This cannot be undone.`)) return;
    await window.api.programs.delete(id);
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Programs</h1>
        <span className="text-sm text-slate-500">Status &amp; loyalty benefits (not tied to a card)</span>
        <button className="btn-primary ml-auto" onClick={() => setShowAdd(true)}>+ Add program</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {programs.map(p => (
          <Link key={p.id} to={`/programs/${p.id}`} className="card p-4 hover:border-primary-400 transition-colors">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-semibold leading-tight">{p.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{TYPE_LABELS[p.program_type] ?? p.program_type}</div>
              </div>
              {!p.is_active && <span className="text-xs bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded">Inactive</span>}
            </div>
            <div className="mt-3 flex justify-between text-sm">
              <span className="text-slate-500">Benefits</span>
              <span>{benefitCounts[p.id] ?? 0}</span>
            </div>
            <div className="mt-2 flex justify-end gap-2 text-xs">
              <button onClick={(e) => { e.preventDefault(); del(p.id, p.name); }}
                className="text-red-500 hover:text-red-700">Delete</button>
            </div>
          </Link>
        ))}
      </div>

      {showAdd && <AddProgramModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
    </div>
  );
}

function AddProgramModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ProgramInput>({ name: '', program_type: 'airline', source_url: '', notes: '' });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!form.name.trim()) { setErr('Name is required.'); return; }
    setSaving(true); setErr(null);
    try {
      await window.api.programs.create({
        ...form, name: form.name.trim(),
        source_url: form.source_url?.trim() || null,
        notes: form.notes?.trim() || null,
      });
      onSaved();
    } catch (e) { setErr(String(e)); setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-3">Add program</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="label">Name *</label>
            <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Type</label>
            <select className="input" value={form.program_type} onChange={e => setForm({ ...form, program_type: e.target.value as ProgramType })}>
              {TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Source URL</label>
            <input className="input" value={form.source_url ?? ''} onChange={e => setForm({ ...form, source_url: e.target.value })} />
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
