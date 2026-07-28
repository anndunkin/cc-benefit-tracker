import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Benefit, Card, Program } from '../../electron/types';
import { fmtUsd, cadenceLabel, categoryLabel } from '../lib/format';
import BenefitEditor from '../components/BenefitEditor';

export default function ManageBenefits() {
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ mode: 'edit' | 'new'; benefit?: Benefit; ownerType: 'card' | 'program'; ownerId: string } | null>(null);

  async function reload() {
    const [bs, cs, ps] = await Promise.all([
      window.api.benefits.getAll(),
      window.api.cards.getAll(),
      window.api.programs.getAll(),
    ]);
    setBenefits(bs); setCards(cs); setPrograms(ps);
  }
  useEffect(() => { reload(); }, []);

  const cardMap = useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const progMap = useMemo(() => new Map(programs.map(p => [p.id, p])), [programs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return benefits;
    return benefits.filter(b => {
      const owner = b.card_id ? cardMap.get(b.card_id)?.name : progMap.get(b.program_id!)?.name;
      const hay = `${b.title} ${b.description ?? ''} ${owner ?? ''} ${b.category} ${b.reset_cadence}`.toLowerCase();
      return hay.includes(q);
    });
  }, [benefits, query, cardMap, progMap]);

  async function del(b: Benefit) {
    if (!confirm(`Delete "${b.title}"? This also deletes its usage history.`)) return;
    await window.api.benefits.delete(b.id);
    reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold">Manage Benefits</h1>
        <span className="text-sm text-slate-500">{benefits.length} total</span>
        <input className="input max-w-sm ml-auto" placeholder="Filter by title, category, owner…"
          value={query} onChange={e => setQuery(e.target.value)} />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 dark:bg-slate-800/60 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Title</th>
              <th className="text-left px-3 py-2">Owner</th>
              <th className="text-left px-3 py-2">Category</th>
              <th className="text-left px-3 py-2">Cadence</th>
              <th className="text-right px-3 py-2">Value</th>
              <th className="text-center px-3 py-2">Active</th>
              <th className="text-center px-3 py-2">Modified</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {filtered.map(b => {
              const owner = b.card_id ? cardMap.get(b.card_id) : progMap.get(b.program_id!);
              const ownerLink = b.card_id ? `/cards/${b.card_id}` : `/programs/${b.program_id}`;
              return (
                <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <td className="px-3 py-2 font-medium">{b.title}</td>
                  <td className="px-3 py-2">
                    {owner ? <Link to={ownerLink} className="hover:text-primary-600">{owner.name}</Link> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="px-3 py-2">{categoryLabel(b.category)}</td>
                  <td className="px-3 py-2">{cadenceLabel(b.reset_cadence)}{b.uses_per_period ? ` (${b.uses_per_period}x)` : ''}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmtUsd(b.value_usd)}</td>
                  <td className="px-3 py-2 text-center">{b.is_active ? '✓' : '—'}</td>
                  <td className="px-3 py-2 text-center">{b.is_user_modified ? '✎' : ''}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button className="text-slate-500 hover:text-primary-600 text-xs mr-3"
                      onClick={() => setEditor({
                        mode: 'edit', benefit: b,
                        ownerType: b.card_id ? 'card' : 'program',
                        ownerId: (b.card_id ?? b.program_id)!,
                      })}>Edit</button>
                    <button className="text-red-500 hover:text-red-700 text-xs" onClick={() => del(b)}>Delete</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No benefits match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editor && (
        <BenefitEditor
          initial={editor.benefit}
          ownerType={editor.ownerType}
          ownerId={editor.ownerId}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); reload(); }}
        />
      )}
    </div>
  );
}
