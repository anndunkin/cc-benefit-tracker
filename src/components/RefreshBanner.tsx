import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

/** Small banner that surfaces a pending quarterly refresh review or an overdue check. */
export default function RefreshBanner() {
  const [state, setState] = useState<{ last_run_at: string | null; next_due: string; pending_run_id: number | null } | null>(null);

  useEffect(() => {
    window.api.refresh.getStatus().then(setState).catch(() => setState(null));
  }, []);

  if (!state) return null;

  const dueDate = new Date(state.next_due + 'T00:00:00Z').getTime();
  const overdue = dueDate < Date.now();

  if (state.pending_run_id) {
    return (
      <div className="bg-amber-100 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 px-6 py-2 text-sm">
        <b>Quarterly refresh in progress.</b>{' '}
        <Link to="/refresh" className="underline hover:no-underline">Review pending changes →</Link>
      </div>
    );
  }
  if (overdue) {
    return (
      <div className="bg-primary-100 dark:bg-primary-950/40 border-b border-primary-200 dark:border-primary-900 text-primary-900 dark:text-primary-200 px-6 py-2 text-sm">
        <b>Time for a quarterly benefit review.</b>{' '}
        <Link to="/refresh" className="underline hover:no-underline">Start refresh →</Link>{' '}
        <span className="text-primary-700/70 dark:text-primary-300/70">
          (last: {state.last_run_at?.slice(0, 10) ?? 'never'})
        </span>
      </div>
    );
  }
  return null;
}
