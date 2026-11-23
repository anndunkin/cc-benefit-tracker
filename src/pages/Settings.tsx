import { useEffect, useState } from 'react';

export default function Settings() {
  const [dbPath, setDbPath] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadPath() { setDbPath(await window.api.file.currentPath()); }
  useEffect(() => { reloadPath(); }, []);
  // Keep the path current when a file is opened or saved from the File menu.
  useEffect(() => window.api.file.onChanged(info => setDbPath(info.path)), []);

  async function wrap<T>(promise: Promise<T>, label: string) {
    setBusy(true); setMsg(null);
    try {
      const r: any = await promise;
      if (r && r.success === false && r.error) setMsg(`${label} failed: ${r.error}`);
      else if (r && r.success === false) setMsg(null);          // cancelled: nothing happened
      else if (r && r.message) setMsg(r.message);
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
        <p className="text-sm text-slate-500">
          Each entry is written to this file as soon as you save it in the app (for example, when you log a usage or
          save an edit), so there is no separate step needed before closing. "Save" makes sure the single .db file on
          disk is complete right now, which is useful before copying it. "Save As…" writes the file to a new location
          and keeps working there; the earlier file stays where it was. "Save a Backup Copy…" writes a copy somewhere
          else and keeps working in this file. The same commands are in the File menu at the top of the window.
        </p>
        <p className="text-sm text-slate-500">
          If you keep this file in a synced folder, use it on one computer at a time and close the app so syncing can
          finish before opening it elsewhere. A safer habit is to keep the working file on this computer and use "Save
          a Backup Copy…" into the synced folder.
        </p>
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold mb-3">File</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.newDb(), 'New file')}>
            New File…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.openDb(), 'Open file')}>
            Open File…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.save(), 'Save')}>
            Save
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.saveAs(), 'Save as')}>
            Save As…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.saveCopy(), 'Save a backup copy')}>
            Save a Backup Copy…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.showInFolder(), 'Show file in folder')}>
            Show File in Folder
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.exportJson(), 'Export JSON')}>
            Export to JSON…
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => wrap(window.api.file.importJson(), 'Import JSON')}>
            Import from JSON…
          </button>
        </div>
        {msg && <div role="status" className="mt-3 text-sm text-slate-600 dark:text-slate-300 [overflow-wrap:anywhere]">{msg}</div>}
      </div>

      <div className="card p-5 text-sm text-slate-500 space-y-2">
        <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">About</h2>
        <div>Credit Card Benefit Tracker — Dunkin Global Advisors</div>
        <div>Data is stored locally as SQLite. No network calls at runtime.</div>
      </div>
    </div>
  );
}
