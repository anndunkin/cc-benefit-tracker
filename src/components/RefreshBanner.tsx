import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { RefreshStatusInfo } from '../../electron/types';

/** Small banner that surfaces a pending benefit refresh review or an overdue check. */
export default function RefreshBanner() {
  const [state, setState] = useState<RefreshStatusInfo | null>(null);
  const location = useLocation();

  // Re-read on navigation so the banner clears once a refresh is applied or discarded.
  useEffect(() => {
    window.api.refresh.getStatus().then(setState).catch(() => setState(null));
  }, [location.pathname]);

  if (!state) return null;

  const dueDate = new Date(state.next_due + 'T00:00:00Z').getTime();
  const overdue = dueDate < Date.now();

  if (state.pending_run_id) {
    return (
      <div className="bg-amber-100 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-200 px-6 py-2 text-sm">
        <b>Benefit changes are ready for your review.</b>{' '}
        <Link to="/refresh" className="underline hover:no-underline">Review proposed changes →</Link>{' '}
        <span className="opacity-75">Nothing changes until you approve it.</span>
      </div>
    );
  }
  if (overdue) {
    return (
      <div className="bg-primary-100 dark:bg-primary-950/40 border-b border-primary-200 dark:border-primary-900 text-primary-900 dark:text-primary-200 px-6 py-2 text-sm">
        <b>Time for a quarterly benefit review.</b>{' '}
        <Link to="/refresh" className="underline hover:no-underline">Check for benefit changes →</Link>{' '}
        <span className="text-primary-700/70 dark:text-primary-300/70">
          (last: {state.last_run_at?.slice(0, 10) ?? 'never'})
        </span>
      </div>
    );
  }
  return null;
}
