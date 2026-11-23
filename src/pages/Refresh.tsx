import { useEffect, useMemo, useState } from 'react';
import type {
  RefreshChange, RefreshProposalResult, RefreshProposalSource, RefreshStatusInfo, RefreshUnmatched,
} from '../../electron/types';
import { cadenceLabel, categoryLabel, fmtUsd } from '../lib/format';

interface ChangeMeta {
  scope?: string;
  summary?: string;
  effective_date?: string | null;
  sources?: RefreshProposalSource[];
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Name',
  name: 'Name',
  program_type: 'Program type',
  description: 'Description',
  category: 'Category',
  reset_cadence: 'Resets',
  uses_per_period: 'Uses per period',
  value_usd: 'Value per period',
  previous_value_usd: 'Earlier value',
  value_effective_date: 'New value starts',
  spend_threshold_usd: 'Spend required',
  expiration_note: 'Expiration',
  reset_years: 'Years between resets',
  multiplier_rate: 'Earning rate',
  multiplier_currency: 'Points earned',
  spend_category: 'Spend category',
  spend_category_note: 'Spend category note',
  source_url: 'Source link',
  notes: 'Notes',
  annual_fee_usd: 'Annual fee',
  issuer: 'Issuer',
  network: 'Network',
  value_cents_per_point: 'Value per point',
  source_name: 'Valuation source',
  prerequisite_benefit_title: 'Unlocked by',
  sort_order: 'List position',
  is_choice_option: 'Choice option',
};

const PROGRAM_TYPE_LABELS: Record<string, string> = {
  airline: 'Airline',
  hotel: 'Hotel',
  airline_elite_status: 'Airline elite status',
  hotel_elite_status: 'Hotel elite status',
  hotel_paid_membership: 'Hotel paid membership',
  other: 'Other',
};

/** A loyalty program that the open refresh proposes to add (v1.0.27). */
interface ProposedProgram { name: string; approved: boolean; benefits: number }

function formatField(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'value_usd' || key === 'previous_value_usd' || key === 'spend_threshold_usd' || key === 'annual_fee_usd') {
    return typeof v === 'number' ? fmtUsd(v, Number.isInteger(v) ? 0 : 2) : String(v);
  }
  if (key === 'value_cents_per_point') return `${v}¢`;
  if (key === 'multiplier_rate') return `${v}x`;
  if (key === 'reset_cadence') return cadenceLabel(String(v));
  if (key === 'program_type') return PROGRAM_TYPE_LABELS[String(v)] ?? String(v);
  if (key === 'category' || key === 'spend_category') return categoryLabel(String(v));
  return String(v);
}

function parseJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** Only https links are ever rendered as links; anything else shows as text. */
function safeHttps(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function resultMessage(r: RefreshProposalResult): string {
  if (r.error) return `Could not load the refresh: ${r.error}`;
  switch (r.state) {
    case 'created':
      return `${r.proposed} proposed change${r.proposed === 1 ? '' : 's'} ready for review`
        + (r.already_current ? ` (${r.already_current} already matched your file)` : '') + '.';
    case 'draft_exists':
      return 'A refresh is already in progress. Apply or discard it before starting another.';
    case 'up_to_date':
      return r.title
        ? `Nothing to change: your benefits already match "${r.title}".`
        : 'Nothing to change: your benefits already match the refresh included with this version.';
    case 'applied':
      return 'Refresh applied.';
    default:
      return '';
  }
}

export default function Refresh() {
  const [status, setStatus] = useState<RefreshStatusInfo | null>(null);
  const [pending, setPending] = useState<RefreshChange[]>([]);
  const [owners, setOwners] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [looseUnmatched, setLooseUnmatched] = useState<RefreshUnmatched[]>([]);

  async function reload() {
    const s = await window.api.refresh.getStatus();
    setStatus(s);
    if (s.pending_run_id) {
      setPending(await window.api.refresh.getPendingChanges(s.pending_run_id));
    } else {
      setPending([]);
    }
  }
  async function loadOwners() {
    const names: Record<string, string> = {};
    try {
      for (const c of await window.api.cards.getAll()) names[c.id] = c.name;
      for (const p of await window.api.programs.getAll()) names[p.id] = p.name;
      for (const pc of await window.api.pointsCurrencies.getAll()) names[pc.id] = pc.name;
    } catch { /* names are a display nicety only */ }
    setOwners(names);
  }
  useEffect(() => { reload(); loadOwners(); }, []);

  // Programs this refresh proposes to add, and how many benefits ride on each.
  const proposedPrograms = useMemo(() => {
    const map: Record<string, ProposedProgram> = {};
    for (const c of pending) {
      const a = parseJson(c.after_json);
      const scope = a && typeof a._meta === 'object' && a._meta ? (a._meta as ChangeMeta).scope : undefined;
      if (scope === 'program' && c.change_type === 'added' && c.program_id) {
        map[c.program_id] = { name: String(a?.name ?? c.program_id), approved: c.review_status === 'approved', benefits: 0 };
      }
    }
    for (const c of pending) {
      if (c.program_id && map[c.program_id] && c.change_type === 'added' && !isProgramChange(c)) map[c.program_id].benefits++;
    }
    return map;
  }, [pending]);

  async function approve(id: number, overwrite = false) {
    await window.api.refresh.approveChange(id, undefined, overwrite);
    await reload();
  }
  async function reject(id: number) { await window.api.refresh.rejectChange(id); await reload(); }

  const undecided = useMemo(() => pending.filter(c => c.review_status === 'pending'), [pending]);
  const approvedCount = pending.filter(c => c.review_status === 'approved').length;

  async function approveAll() {
    if (!undecided.length) return;
    if (!confirm(`Approve all ${undecided.length} undecided change${undecided.length === 1 ? '' : 's'}? Benefits you edited by hand will still be left alone unless you approve them individually with "Approve and replace my edit".`)) return;
    setBusy(true);
    try {
      for (const c of undecided) await window.api.refresh.approveChange(c.id, undefined, false);
      await reload();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  async function apply() {
    if (!status?.pending_run_id) return;
    if (!confirm('Apply all approved changes? Rejected and undecided rows will be skipped.')) return;
    setBusy(true); setMsg(null);
    try {
      const r = await window.api.refresh.applyRun(status.pending_run_id);
      setMsg(`Applied ${r.applied} change${r.applied === 1 ? '' : 's'}; skipped ${r.skipped}.`);
      await reload();
      await loadOwners();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  async function discard() {
    if (!status?.pending_run_id) return;
    if (!confirm('Discard this refresh? All proposed changes in it will be dropped. Your benefits will not change.')) return;
    setBusy(true);
    try {
      await window.api.refresh.discardRun(status.pending_run_id);
      setMsg('Refresh discarded. Your benefits were not changed.');
      await reload();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  async function start(kind: 'bundled' | 'file') {
    setBusy(true); setMsg(null); setLooseUnmatched([]);
    try {
      const r = kind === 'bundled' ? await window.api.refresh.checkBundled() : await window.api.refresh.importProposal();
      if (r.state !== 'cancelled' || r.error) setMsg(resultMessage(r));
      if (r.state !== 'created') setLooseUnmatched(r.unmatched ?? []);
      await reload();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  const unmatched = status?.pending_run_id ? (status.unmatched ?? []) : looseUnmatched;
  const runTitle = status?.pending_run_notes?.replace(/\s*\[refresh:[^\]]*\]\s*$/, '') ?? null;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Quarterly Refresh</h1>
      <div className="card p-4 space-y-2 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <div><span className="text-slate-500">Last refresh:</span> {status?.last_run_at ?? 'Never'}</div>
          <div><span className="text-slate-500">Next due:</span> {status?.next_due ?? '—'}</div>
        </div>
        <p className="text-slate-500">
          A refresh is a researched list of published benefit changes. Nothing changes until you approve a row and
          choose Apply. Benefits you have edited by hand are left alone unless you choose
          "Approve and replace my edit" for that row, and then only the listed fields change.
        </p>
      </div>

      {msg && <div className="text-sm text-primary-600" role="status">{msg}</div>}

      {status?.pending_run_id ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Proposed changes ({pending.length})</h2>
              {runTitle && <div className="text-xs text-slate-500 break-words">{runTitle}</div>}
              <div className="text-xs text-slate-500">
                {approvedCount} approved · {pending.filter(c => c.review_status === 'rejected').length} rejected · {undecided.length} undecided
              </div>
            </div>
            <div className="flex flex-wrap gap-2 ml-auto">
              <button className="btn-ghost text-sm" onClick={approveAll} disabled={busy || undecided.length === 0}>Approve all undecided</button>
              <button className="btn-primary text-sm" onClick={apply} disabled={busy}>Apply approved</button>
              <button className="btn-ghost text-sm" onClick={discard} disabled={busy}>Discard refresh</button>
            </div>
          </div>
          <div className="card divide-y divide-slate-200 dark:divide-slate-800">
            {pending.map(ch => (
              <ChangeRow
                key={ch.id} change={ch} owners={owners} proposedPrograms={proposedPrograms}
                onApprove={(overwrite) => approve(ch.id, overwrite)} onReject={() => reject(ch.id)}
              />
            ))}
            {pending.length === 0 && <div className="p-6 text-center text-slate-500">Draft run has no changes.</div>}
          </div>
        </>
      ) : (
        <div className="card p-6 text-sm space-y-3">
          <p className="text-slate-500">
            No refresh in progress. Each new version of the app includes the latest researched benefit changes and
            proposes them here automatically. You can also check again, or load a refresh file you were sent.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary text-sm" onClick={() => start('bundled')} disabled={busy}>Check for benefit changes</button>
            <button className="btn-ghost text-sm" onClick={() => start('file')} disabled={busy}>Load refresh file…</button>
          </div>
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="card p-4 text-sm space-y-2">
          <h2 className="font-semibold">Could not be matched ({unmatched.length})</h2>
          <p className="text-slate-500">
            These published changes apply to benefits that could not be found in your file, usually because the
            benefit was renamed or deleted. Nothing was changed. Update them by hand if they still apply.
          </p>
          <ul className="space-y-2">
            {unmatched.map((u, i) => (
              <li key={i} className="break-words">
                <div className="font-medium">{u.title} <span className="text-slate-500 font-normal">· {owners[u.owner_id] ?? u.owner_id}</span></div>
                <div>{u.summary}</div>
                <div className="text-xs text-slate-500">{u.reason}</div>
                <SourceLinks sources={u.sources} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function isProgramChange(c: RefreshChange): boolean {
  const a = parseJson(c.after_json);
  return !!a && typeof a._meta === 'object' && !!a._meta && (a._meta as ChangeMeta).scope === 'program';
}

function SourceLinks({ sources }: { sources?: RefreshProposalSource[] }) {
  const links = (sources ?? []).map(s => ({ ...s, safe: safeHttps(s.url) })).filter(s => s.safe);
  if (!links.length) return null;
  return (
    <div className="text-xs text-slate-500 break-words">
      Source{links.length === 1 ? '' : 's'}:{' '}
      {links.map((s, i) => (
        <span key={i}>
          {i > 0 && ', '}
          <a href={s.safe!} target="_blank" rel="noreferrer noopener" className="underline hover:no-underline">
            {s.label || hostOf(s.safe!)}
          </a>
          {s.source_type === 'secondary' && ' (secondary)'}
        </span>
      ))}
    </div>
  );
}

function ChangeRow({
  change, owners, proposedPrograms, onApprove, onReject,
}: {
  change: RefreshChange; owners: Record<string, string>;
  proposedPrograms?: Record<string, ProposedProgram>;
  onApprove: (overwriteUserEdit: boolean) => void; onReject: () => void;
}) {
  const before = parseJson(change.before_json);
  const afterRaw = parseJson(change.after_json);
  const meta = (afterRaw && typeof afterRaw._meta === 'object' && afterRaw._meta ? afterRaw._meta : {}) as ChangeMeta;
  const after: Record<string, unknown> = { ...(afterRaw ?? {}) };
  delete after._meta;
  delete after.card_id;
  delete after.program_id;

  const title = String(after.title ?? before?.title ?? after.name ?? before?.name ?? '(untitled)');
  const ownerId = change.card_id ?? change.program_id ?? change.points_currency_id ?? '';
  const isProgram = meta.scope === 'program';
  // A program this same refresh proposes to add (not in the file yet).
  const newProgram = !owners[ownerId] && change.program_id ? proposedPrograms?.[change.program_id] : undefined;
  const owner = isProgram
    ? `New loyalty program${newProgram && newProgram.benefits > 0 ? ` · ${newProgram.benefits} benefit${newProgram.benefits === 1 ? '' : 's'} proposed with it` : ''}`
    : owners[ownerId] ?? newProgram?.name ?? ownerId;
  // Benefits of a new program are only added if the program itself is approved.
  const needsProgram = !isProgram && !!newProgram && !newProgram.approved && change.review_status !== 'rejected';
  const handEdited = change.target_user_modified === 1 && change.change_type !== 'added';
  const badge = change.change_type === 'added' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
              : change.change_type === 'modified' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
              : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
  const reviewBadge = change.review_status === 'approved' ? 'text-emerald-600'
                   : change.review_status === 'rejected' ? 'text-red-500'
                   : 'text-slate-500';
  const typeLabel = change.change_type === 'added' ? 'New' : change.change_type === 'modified' ? 'Changed' : 'Ended';
  const reviewLabel = change.review_status === 'pending' ? 'Undecided'
    : change.review_status === 'approved' && handEdited && change.overwrite_user_edit !== 1 ? 'Approved · will be skipped (hand-edited)'
    : change.review_status === 'approved' && handEdited ? 'Approved · replaces your edit'
    : change.review_status;

  const keys = change.change_type === 'removed' ? []
    : Object.keys(after).filter(k => change.change_type === 'added' ? after[k] !== null && k !== 'sort_order' && k !== 'is_choice_option' : true);

  return (
    <div className="p-4" data-testid="refresh-change">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`text-xs px-2 py-0.5 rounded uppercase tracking-wide font-semibold ${badge}`}>{typeLabel}</span>
        <span className="font-medium break-words min-w-0">{title}</span>
        <span className={`ml-auto text-xs uppercase ${reviewBadge}`}>{reviewLabel}</span>
      </div>
      {owner && <div className="text-xs text-slate-500 mt-0.5">{owner}</div>}

      {meta.summary && <p className="text-sm mt-2 break-words">{meta.summary}</p>}
      {meta.effective_date && <div className="text-xs text-slate-500 mt-1">Effective {meta.effective_date}</div>}

      {keys.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="font-normal pr-3 py-1 w-36">Field</th>
                {change.change_type === 'modified' && <th className="font-normal pr-3 py-1">Now in your file</th>}
                <th className="font-normal py-1">{change.change_type === 'modified' ? 'Proposed' : 'Details'}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k} className="align-top border-t border-slate-200 dark:border-slate-800">
                  <td className="pr-3 py-1 text-slate-500">{FIELD_LABELS[k] ?? k}</td>
                  {change.change_type === 'modified' && (
                    <td className="pr-3 py-1 break-words whitespace-pre-wrap">{formatField(k, before?.[k])}</td>
                  )}
                  <td className="py-1 break-words whitespace-pre-wrap">{formatField(k, after[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {change.change_type === 'removed' && (
        <p className="text-xs text-slate-500 mt-2">
          Approving retires this benefit from your lists. Its logged usage history is kept.
        </p>
      )}

      <div className="mt-2"><SourceLinks sources={meta.sources} /></div>

      {isProgram && (
        <p className="text-xs text-slate-500 mt-2">
          Approving adds this program to your Programs list. The benefits proposed for it are added only if this
          row is approved.
        </p>
      )}
      {needsProgram && (
        <p className="text-xs text-amber-700 dark:text-amber-300 mt-2" data-testid="needs-program">
          This benefit is added only if the new program "{newProgram!.name}" is also approved.
        </p>
      )}

      {handEdited && (
        <div className="mt-2 text-xs rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 p-2">
          You edited this {change.points_currency_id ? 'value' : 'benefit'} by hand. A normal approval leaves it untouched. Choose "Approve and replace my
          edit" to {change.change_type === 'removed' ? 'retire it anyway.' : 'update only the fields listed above; your other edits stay.'}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-3">
        {change.review_status === 'pending' ? (
          <>
            {handEdited ? (
              <button className="btn-primary text-xs py-1 px-2" onClick={() => onApprove(true)}>Approve and replace my edit</button>
            ) : (
              <button className="btn-primary text-xs py-1 px-2" onClick={() => onApprove(false)}>Approve</button>
            )}
            <button className="btn-ghost text-xs py-1 px-2" onClick={onReject}>Reject</button>
          </>
        ) : (
          <>
            {change.review_status === 'approved' && handEdited && change.overwrite_user_edit !== 1 && (
              <button className="btn-primary text-xs py-1 px-2" onClick={() => onApprove(true)}>Approve and replace my edit</button>
            )}
            {change.review_status === 'approved'
              ? <button className="btn-ghost text-xs py-1 px-2" onClick={onReject}>Reject instead</button>
              : <button className="btn-ghost text-xs py-1 px-2" onClick={() => onApprove(false)}>{handEdited ? 'Approve (keep my edit)' : 'Approve instead'}</button>}
          </>
        )}
      </div>
    </div>
  );
}
