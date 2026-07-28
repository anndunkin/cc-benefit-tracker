import { useEffect, useState } from 'react';

export default function Settings() {
  const [dbPath, setDbPath] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadPath() { setDbPath(await window.api.file.currentPath()); }
  useEffect(() => { reloadPath(); }, []);

  async function wrap<T>(promise: Promise<T>, label: string) {
    setBusy(true); setMsg(null);
    try {
      const r: any = await promise;
      if (r && r.success === false && r.error) setMsg(`${label} failed: ${r.error}`);
      else if (r && r.filePath) setMsg(`${label} succeeded → ${r.filePath}`);
      else setMsg(`${label} complete.`);
      await reloadPath();
    } catch (e) {
      setMsg(`${label} failed: ${String(e)}`);
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="card p-5 space-y-3">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Current database</div>
          <div className="font-mono text-sm break-all">{dbPath || '—'}</div>
        </div>
        <p className="text-sm text-slate-500">
          Your benefits and usage history live in a SQLite file. Keep it on OneDrive, iCloud, or your preferred backup
          folder to preserve it across machines. Use "Save As…" to move it to a new location — the app will remember the
          new location for future launches.
        </p>
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold mb-3">File</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.newDb(), 'New database')}>
            New database…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.openDb(), 'Open database')}>
            Open database…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.saveAs(), 'Save as')}>
            Save as…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.exportJson(), 'Export JSON')}>
            Export JSON…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.importJson(), 'Import JSON')}>
            Import JSON…
          </button>
        </div>
        {msg && <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">{msg}</div>}
      </div>

      <div className="card p-5 text-sm text-slate-500 space-y-2">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">About</h2>
        <div>Credit Card Benefit Tracker — Dunkin Global Advisors</div>
        <div>Data is stored locally as SQLite. No network calls at runtime.</div>
      </div>
    </div>
  );
}
