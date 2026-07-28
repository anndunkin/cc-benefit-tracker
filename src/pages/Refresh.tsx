import { useEffect, useState } from 'react';
import type { RefreshChange } from '../../electron/types';

export default function Refresh() {
  const [status, setStatus] = useState<{ last_run_at: string | null; next_due: string; pending_run_id: number | null } | null>(null);
  const [pending, setPending] = useState<RefreshChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function reload() {
    const s = await window.api.refresh.getStatus();
    setStatus(s);
    if (s.pending_run_id) {
      setPending(await window.api.refresh.getPendingChanges(s.pending_run_id));
    } else {
      setPending([]);
    }
  }
  useEffect(() => { reload(); }, []);

  async function approve(id: number) { await window.api.refresh.approveChange(id); await reload(); }
  async function reject(id: number)  { await window.api.refresh.rejectChange(id);  await reload(); }

  async function apply() {
    if (!status?.pending_run_id) return;
    if (!confirm('Apply all approved changes? Rejected and pending rows will be skipped.')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await window.api.refresh.applyRun(status.pending_run_id);
      setMsg(`Applied ${r.applied} change${r.applied === 1 ? '' : 's'}; skipped ${r.skipped}.`);
      await reload();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  async function discard() {
    if (!status?.pending_run_id) return;
    if (!confirm('Discard this refresh? All pending changes will be lost.')) return;
    setBusy(true);
    try {
      await window.api.refresh.discardRun(status.pending_run_id);
      setMsg('Run discarded.');
      await reload();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Quarterly Refresh</h1>
      <div className="card p-4 space-y-2 text-sm">
        <div className="flex gap-4">
          <div><span className="text-slate-500">Last refresh:</span> {status?.last_run_at ?? 'Never'}</div>
          <div><span className="text-slate-500">Next due:</span> {status?.next_due ?? '—'}</div>
        </div>
        <p className="text-slate-500">
          Refresh runs are prepared outside the app (e.g., by a research assistant) and then reviewed here. Benefits
          you have edited manually are marked with ✎ and are never overwritten by a refresh — even if you approve the change,
          the app will skip them and count them under "skipped".
        </p>
      </div>

      {msg && <div className="text-sm text-primary-600">{msg}</div>}

      {status?.pending_run_id ? (
        <>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">Pending changes ({pending.length})</h2>
            <button className="btn-primary ml-auto text-sm" onClick={apply} disabled={busy}>Apply approved</button>
            <button className="btn-ghost text-sm" onClick={discard} disabled={busy}>Discard run</button>
          </div>
          <div className="card divide-y divide-slate-200 dark:divide-slate-800">
            {pending.map(ch => (
              <ChangeRow key={ch.id} change={ch} onApprove={() => approve(ch.id)} onReject={() => reject(ch.id)} />
            ))}
            {pending.length === 0 && <div className="p-6 text-center text-slate-500">Draft run has no changes.</div>}
          </div>
        </>
      ) : (
        <div className="card p-6 text-slate-500 text-sm">
          No refresh in progress. Quarterly refreshes are proposed by the assistant when new benefits data is available. When one arrives,
          you'll see a banner at the top of every page.
        </div>
      )}
    </div>
  );
}

function ChangeRow({
  change, onApprove, onReject,
}: { change: RefreshChange; onApprove: () => void; onReject: () => void }) {
  const before = change.before_json ? JSON.parse(change.before_json) : null;
  const after  = change.after_json  ? JSON.parse(change.after_json)  : null;
  const title = after?.title ?? before?.title ?? '(untitled)';
  const badge = change.change_type === 'added' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
              : change.change_type === 'modified' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
              : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
  const reviewBadge = change.review_status === 'approved' ? 'text-emerald-600'
                   : change.review_status === 'rejected' ? 'text-red-500'
                   : 'text-slate-500';

  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <span className={`text-xs px-2 py-0.5 rounded uppercase tracking-wide font-semibold ${badge}`}>{change.change_type}</span>
        <span className="font-medium">{title}</span>
        <span className={`ml-auto text-xs uppercase ${reviewBadge}`}>{change.review_status}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2 text-xs font-mono">
        <div>
          <div className="text-slate-500 mb-1">Before</div>
          <pre className="bg-slate-100 dark:bg-slate-800/40 p-2 rounded overflow-auto max-h-40">
            {before ? JSON.stringify(before, null, 2) : '—'}
          </pre>
        </div>
        <div>
          <div className="text-slate-500 mb-1">After</div>
          <pre className="bg-slate-100 dark:bg-slate-800/40 p-2 rounded overflow-auto max-h-40">
            {after ? JSON.stringify(after, null, 2) : '—'}
          </pre>
        </div>
      </div>

      {change.review_status === 'pending' && (
        <div className="flex gap-2 mt-3">
          <button className="btn-primary text-xs py-1 px-2" onClick={onApprove}>Approve</button>
          <button className="btn-ghost text-xs py-1 px-2" onClick={onReject}>Reject</button>
        </div>
      )}
    </div>
  );
}
