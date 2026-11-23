import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ExpiringItem, ExpiringReport } from '../../electron/types';
import { localIsoDate, matchesSelection } from '../../electron/expiringCredits';
import type { ExpiringScope } from '../../electron/expiringCredits';

/**
 * Print Expiring Credits (v1.0.26).
 *
 * The white sheet on this page is what prints; everything else on the page is
 * left off the paper. Choices are remembered between visits, and rows that
 * were unticked stay unticked (per data file) until they are ticked again.
 */

const PREFS_KEY = 'cct.printExpiring.v1';

interface Prefs {
  scope: ExpiringScope;
  travelOnly: boolean;
  includeLater: boolean;
  /**
   * Rows left off the printout, per data file. Each entry is one benefit for
   * one deadline (see rowKey), so leaving this month's credit off does not hide
   * next month's.
   */
  excluded: Record<string, string[]>;
}

const DEFAULT_PREFS: Prefs = { scope: 'month', travelOnly: false, includeLater: false, excluded: {} };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS };
    const excluded: Record<string, string[]> = {};
    if (raw.excluded && typeof raw.excluded === 'object') {
      for (const [file, ids] of Object.entries(raw.excluded)) {
        if (Array.isArray(ids)) excluded[file] = ids.filter((k): k is string => typeof k === 'string' && /^\d+@\d{4}-\d{2}-\d{2}$/.test(k));
      }
    }
    return {
      scope: raw.scope === 'year' ? 'year' : 'month',
      travelOnly: raw.travelOnly === true,
      includeLater: raw.includeLater === true,
      excluded,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* choices simply are not remembered */ }
}

/** One row of the list: a benefit and the day its current balance or certificate runs out. */
export function rowKey(item: Pick<ExpiringItem, 'benefit_id' | 'expires_on'>): string {
  return `${item.benefit_id}@${item.expires_on}`;
}

function parts(iso: string): Date {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function fmtDate(iso: string, month: 'short' | 'long' = 'short'): string {
  return parts(iso).toLocaleDateString('en-US', { month, day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function fmtMonth(iso: string): string {
  return parts(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parts(toIso).getTime() - parts(fromIso).getTime()) / 86400000);
}
function money(n: number): string {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(n);
}

/** What is left, in words. Partly used items always say how much remains. */
export function remainingText(item: ExpiringItem): string {
  if (item.kind === 'credit') {
    const left = money(item.value_remaining_usd ?? 0);
    return item.partially_used ? `${left} left of ${money(item.value_total_usd ?? 0)}` : left;
  }
  const each = item.value_each_usd ? ` (valued at ${money(item.value_each_usd)}${item.uses_max > 1 ? ' each' : ''})` : '';
  if (item.partially_used) return `${item.uses_remaining} of ${item.uses_max}${item.kind === 'other' ? ' uses' : ''} left${each}`;
  return (item.uses_max === 1 ? 'Unused' : `All ${item.uses_max} unused`) + each;
}

function whyThen(item: ExpiringItem): string {
  if (item.expiry_source === 'date') return 'expiration date';
  switch (item.cadence) {
    case 'monthly': return 'end of month';
    case 'quarterly': return 'end of quarter';
    case 'semiannual': return 'end of half-year';
    default: return 'end of year';
  }
}

function daysLeftText(today: string, expires: string): string {
  const n = daysBetween(today, expires);
  return n <= 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
}

interface Totals { dollars: number; credits: number; certificates: number; certificateUses: number; others: number }

/** The bold line at the foot of the list. */
export function summaryText(t: Totals): string {
  const bits: string[] = [];
  if (t.credits > 0) bits.push(`Dollar credits remaining: ${money(t.dollars)} across ${t.credits} credit${t.credits === 1 ? '' : 's'}`);
  if (t.certificates > 0) {
    const rows = `${t.certificates} certificate${t.certificates === 1 ? '' : 's'} or pass${t.certificates === 1 ? '' : 'es'}`;
    bits.push(t.certificateUses > t.certificates ? `${rows} (${t.certificateUses} uses in all)` : rows);
  }
  if (t.others > 0) bits.push(`${t.others} other benefit${t.others === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/** Identifies one list for one data file, to tell whether a fresh read differs from what is shown. */
const listKey = (path: string, report: ExpiringReport): string => JSON.stringify([path, report]);

/** Column widths shared by every table on the sheet, so the groups line up. */
const COLUMNS = (
  <colgroup>
    <col style={{ width: '2.75rem' }} />
    <col />
    <col style={{ width: '13rem' }} />
    <col style={{ width: '11rem' }} />
  </colgroup>
);

interface Group { key: string; name: string; kind: 'card' | 'program'; items: ExpiringItem[] }

export default function PrintExpiring() {
  const [report, setReport] = useState<ExpiringReport | null>(null);
  const [filePath, setFilePath] = useState('');
  const [loadError, setLoadError] = useState('');
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState('');

  const [notice, setNotice] = useState('');
  const live = useRef(true);
  const printRef = useRef<() => Promise<void>>(async () => {});
  const busy = useRef(false);   // true from choosing Print until the print dialog has closed
  const requests = useRef(0);   // only the newest reload may replace what is shown
  // The list and file that are on screen right now (set after each render is
  // drawn), so printing can tell whether the sheet matches a fresh read.
  const onScreen = useRef('');
  const renderedKey = useMemo(() => (report ? listKey(filePath, report) : ''), [filePath, report]);
  useLayoutEffect(() => { onScreen.current = loadError ? '' : renderedKey; });

  /**
   * Read the list and the data file again and show them. Resolves with what
   * was read: 'ok' and its key, 'failed' when it could not be read, 'left'
   * when the page was closed in the meantime, or 'overtaken' when a newer read
   * started before this one came back (the screen is left to the newer one).
   */
  const load = useCallback(async (): Promise<{ status: 'ok' | 'failed' | 'left' | 'overtaken'; key: string }> => {
    const mine = ++requests.current;
    try {
      const [r, p] = await Promise.all([window.api.expiring.list(), window.api.file.currentPath()]);
      if (!live.current) return { status: 'left', key: '' };
      if (mine !== requests.current) return { status: 'overtaken', key: '' };
      setReport(r); setFilePath(p); setLoadError('');
      return { status: 'ok', key: listKey(p, r) };
    } catch (err) {
      if (!live.current) return { status: 'left', key: '' };
      if (mine !== requests.current) return { status: 'overtaken', key: '' };
      setLoadError(String(err instanceof Error ? err.message : err));
      return { status: 'failed', key: '' };
    }
  }, []);

  // The list is kept current: when another file is opened or saved under a new
  // name, when the window is used again after a while, when the menu command is
  // chosen again, and when the date changes while the page is open.
  useEffect(() => {
    live.current = true;
    void load();
    const again = () => { void load(); };
    const stopFile = window.api.file.onChanged(again);
    // Ctrl+P (File > Print Expiring Credits) while this page is open prints it.
    const stopNav = window.api.app.onNavigate(route => { if (route === 'print-expiring') void printRef.current(); });
    window.addEventListener('focus', again);
    const clock = window.setInterval(() => {
      if (onScreen.current && !onScreen.current.includes(`"today":"${localIsoDate()}"`)) again();
    }, 60_000);
    return () => {
      live.current = false;
      stopFile(); stopNav();
      window.removeEventListener('focus', again);
      window.clearInterval(clock);
    };
  }, [load]);

  function update(change: Partial<Prefs>) {
    if (busy.current) return;   // the choices are fixed once Print has been chosen
    setPrefs(prev => { const next = { ...prev, ...change }; savePrefs(next); return next; });
  }

  const excluded = useMemo(() => new Set(prefs.excluded[filePath] ?? []), [prefs.excluded, filePath]);
  /** Change the unticked rows for the open file, dropping entries whose deadline has passed. */
  function changeExcluded(change: (set: Set<string>) => void) {
    if (busy.current) return;
    setPrefs(prev => {
      const set = new Set(prev.excluded[filePath] ?? []);
      change(set);
      const today = report?.today ?? '';
      const kept = Array.from(set).filter(k => k.slice(k.indexOf('@') + 1) >= today).sort();
      const next = { ...prev, excluded: { ...prev.excluded, [filePath]: kept } };
      savePrefs(next);
      return next;
    });
  }

  const matching = useMemo(() => {
    if (!report) return [];
    return report.items.filter(i => matchesSelection(i, report, {
      scope: prefs.scope, travelOnly: prefs.travelOnly, includeLaterCertificates: prefs.includeLater,
    }));
  }, [report, prefs.scope, prefs.travelOnly, prefs.includeLater]);

  const selected = useMemo(() => matching.filter(i => !excluded.has(rowKey(i))), [matching, excluded]);
  const leftOff = matching.length - selected.length;

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const item of matching) {
      const key = `${item.owner_kind}:${item.owner_id}`;
      const g = map.get(key) ?? { key, name: item.owner_name, kind: item.owner_kind, items: [] };
      g.items.push(item);
      map.set(key, g);
    }
    // Soonest group first; items inside a group are already soonest first.
    return Array.from(map.values()).sort((a, b) =>
      a.items[0].expires_on.localeCompare(b.items[0].expires_on) || a.name.localeCompare(b.name));
  }, [matching]);

  const totals = useMemo(() => {
    let dollars = 0, credits = 0, certificates = 0, certificateUses = 0, others = 0, partly = 0, undated = 0;
    for (const i of selected) {
      if (i.kind === 'credit') { dollars += i.value_remaining_usd ?? 0; credits++; }
      else if (i.kind === 'certificate') { certificates++; certificateUses += i.uses_remaining; }
      else others++;
      if (i.partially_used) partly++;
      if (i.date_not_recorded) undated++;
    }
    return { dollars, credits, certificates, certificateUses, others, partly, undated };
  }, [selected]);

  function toggle(item: ExpiringItem, on: boolean) {
    changeExcluded(set => { if (on) set.delete(rowKey(item)); else set.add(rowKey(item)); });
  }
  function setAll(on: boolean) {
    changeExcluded(set => { for (const i of matching) { if (on) set.delete(rowKey(i)); else set.add(rowKey(i)); } });
  }

  async function print() {
    if (busy.current || printing || !report) return;
    setPrintError('');
    if (selected.length === 0) {
      setNotice(matching.length === 0 ? 'There is nothing on the list to print.' : 'Tick at least one row to print.');
      return;
    }
    setNotice('');
    busy.current = true;
    setPrinting(true);
    try {
      // Never print a list that has gone out of date while the page was open,
      // and never print whatever else is on screen: if the list could not be
      // read again, or this page was left while it was being read, stop.
      // The sheet may be printed only if it is the one the user was looking at
      // when Print was chosen and a fresh read says it is still correct.
      const looking = onScreen.current;
      const fresh = await load();
      if (fresh.status === 'left' || fresh.status === 'failed' || !live.current) return;
      if (fresh.status === 'overtaken' || fresh.key !== looking || onScreen.current !== fresh.key) {
        setNotice('The list was just brought up to date because the date or your data changed. Check it, then choose Print again.');
        return;
      }
      const result = await window.api.app.print();
      if (!live.current) return;
      if (!result.success && !result.cancelled) {
        setPrintError(`Printing did not start${result.error ? ` (${result.error})` : ''}. Check that a printer is set up in Windows; "Microsoft Print to PDF" also works.`);
      }
    } catch (err) {
      if (live.current) setPrintError(`Printing did not start (${err instanceof Error ? err.message : String(err)}).`);
    } finally {
      busy.current = false;
      if (live.current) setPrinting(false);
    }
  }

  printRef.current = print;

  if (loadError) {
    return <div className="card p-6 text-sm text-red-700 dark:text-red-300" role="alert">The list could not be prepared: {loadError}</div>;
  }
  if (!report) return <div className="text-sm text-slate-500">Preparing the list…</div>;

  const nextYear = report.next_year_end.slice(0, 4);
  const through = prefs.scope === 'month' ? report.month_end : report.year_end;
  const heading = prefs.scope === 'month'
    ? `Credits and certificates expiring in ${fmtMonth(report.today)}`
    : `Credits and certificates expiring in ${report.today.slice(0, 4)}`;
  const described = [
    `Use by ${fmtDate(through, 'long')}`,
    prefs.includeLater ? `plus certificates expiring through ${fmtDate(report.next_year_end, 'long')}` : null,
    prefs.travelOnly ? 'travel only' : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-4 print:space-y-0">
      {/* ── Choices (never printed) ─────────────────────────────────────── */}
      <div className="space-y-4 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold">Print Expiring Credits</h1>
            <div className="mt-0.5 text-sm text-slate-500">
              Choose what goes on the list. The white sheet below is exactly what will print.
            </div>
          </div>
          <Link to="/" className="btn-ghost ml-auto text-sm">Back to Credits &amp; Usages</Link>
        </div>

        <div className="card space-y-4 p-4">
          <fieldset>
            <legend className="label">Expiring</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="expiring-scope" checked={prefs.scope === 'month'} onChange={() => update({ scope: 'month' })} disabled={printing} />
                This month <span className="text-slate-500">(by {fmtDate(report.month_end)})</span>
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="expiring-scope" checked={prefs.scope === 'year'} onChange={() => update({ scope: 'year' })} disabled={printing} />
                This year <span className="text-slate-500">(by {fmtDate(report.year_end)})</span>
              </label>
            </div>
          </fieldset>

          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={prefs.travelOnly} onChange={e => update({ travelOnly: e.target.checked })} disabled={printing} />
              <span>
                Travel only
                <span className="block text-xs text-slate-500">Airline, hotel, general travel and rideshare credits, free nights, upgrades, lounge passes and companion certificates.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={prefs.includeLater} onChange={e => update({ includeLater: e.target.checked })} disabled={printing} />
              <span>
                Also include certificates expiring through {fmtDate(report.next_year_end)}
                <span className="block text-xs text-slate-500">
                  Adds free nights, upgrades, lounge passes and companion certificates that expire after the period above, up to the end of {nextYear}. Certificates with no expiration date recorded are included and marked "Check certificate".
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
            <button className="btn-primary" onClick={print} disabled={printing || selected.length === 0}>
              {printing ? 'Opening print dialog…' : 'Print…'}
            </button>
            <button className="btn-ghost" onClick={() => setAll(true)} disabled={printing || leftOff === 0}>Select all</button>
            <button className="btn-ghost" onClick={() => setAll(false)} disabled={printing || selected.length === 0}>Clear all</button>
            <span className="text-sm text-slate-600 dark:text-slate-300" role="status">
              {selected.length} of {matching.length} will print
              {leftOff > 0 ? ` · ${leftOff} left off (unticked)` : ''}
            </span>
          </div>
          {notice && <div className="text-sm text-amber-800 dark:text-amber-300" role="status">{notice}</div>}
          {printError && <div className="text-sm text-red-700 dark:text-red-300" role="alert">{printError}</div>}
          <div className="text-xs text-slate-500">
            Untick a row to leave it off. That is remembered until the row's use-by date passes, so next month's credit is listed again. To save a PDF instead of paper, pick "Microsoft Print to PDF" in the print dialog.
            A row marked "Check certificate" or "Check terms" has no expiration date recorded; add one under Manage Benefits to print its expiration date.
          </div>
        </div>
      </div>

      {/* ── The sheet (this is what prints) ─────────────────────────────── */}
      <section
        aria-label="Printable list"
        className="print-sheet mx-auto max-w-4xl rounded-lg border border-slate-300 bg-white p-6 text-black shadow-sm print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none"
      >
        <header className="mb-4 border-b border-black pb-2">
          <h2 className="text-xl font-bold">{heading}</h2>
          <div className="text-sm">{described}</div>
          <div className="text-xs text-slate-600">Prepared {fmtDate(report.today, 'long')} · Credit Card Benefit Tracker</div>
        </header>

        {matching.length === 0 ? (
          <p className="py-6 text-sm">Nothing with a balance left is expiring in this period with these choices.</p>
        ) : selected.length === 0 ? (
          <p className="py-6 text-sm">Every row is unticked, so there is nothing to print. Tick the rows you want.</p>
        ) : null}

        {/* One table per card or program. Its heading row is a table header, so
            when a long group runs onto the next sheet the name and the column
            headings are printed again at the top of that sheet. */}
        {matching.length > 0 && (
          <div>
            {groups.map(g => {
              const anySelected = g.items.some(i => !excluded.has(rowKey(i)));
              return (
                <table key={g.key} className={`w-full table-fixed border-collapse text-sm ${anySelected ? '' : 'print:hidden'}`}>
                  {COLUMNS}
                  <thead>
                    <tr className="align-bottom">
                      <th colSpan={2} scope="colgroup" className="pb-1 pr-3 pt-4 text-left text-base font-semibold [overflow-wrap:anywhere]">
                        {g.name}
                        <span className="ml-2 text-xs font-normal uppercase tracking-wide text-slate-600">{g.kind === 'card' ? 'Card' : 'Program'}</span>
                      </th>
                      <th scope="col" className="pb-1 pr-3 pt-4 text-left text-xs font-normal uppercase tracking-wide text-slate-600">Use by</th>
                      <th scope="col" className="pb-1 pt-4 text-left text-xs font-normal uppercase tracking-wide text-slate-600">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map(item => {
                      const on = !excluded.has(rowKey(item));
                      return (
                        <tr
                          key={rowKey(item)}
                          data-benefit-id={item.benefit_id}
                          className={`break-inside-avoid border-t border-slate-300 align-top ${on ? '' : 'opacity-50 print:hidden'}`}
                        >
                          <td className="py-1.5 pr-2">
                            <input
                              type="checkbox"
                              className="print:hidden"
                              checked={on}
                              onChange={e => toggle(item, e.target.checked)}
                              disabled={printing}
                              aria-label={`Print ${item.title} (${item.owner_name})`}
                            />
                            {/* On paper: an empty box to tick off once the credit has been used. */}
                            <span className="hidden h-3.5 w-3.5 border border-black align-middle print:inline-block" aria-hidden="true" />
                          </td>
                          <td className="py-1.5 pr-3">
                            <div className="font-medium [overflow-wrap:anywhere]">{item.title}</div>
                            {item.note && <div className="text-xs text-slate-600 [overflow-wrap:anywhere]">{item.note}</div>}
                          </td>
                          <td className="py-1.5 pr-3">
                            {item.date_not_recorded ? (
                              <>
                                <div className="font-medium">{item.kind === 'certificate' ? 'Check certificate' : 'Check terms'}</div>
                                <div className="text-xs text-slate-600">no date recorded · tracked through {fmtDate(item.expires_on)}</div>
                              </>
                            ) : (
                              <>
                                <div className="whitespace-nowrap font-medium">{fmtDate(item.expires_on)}</div>
                                <div className="text-xs text-slate-600">{whyThen(item)} · {daysLeftText(report.today, item.expires_on)}</div>
                              </>
                            )}
                          </td>
                          <td className="py-1.5">
                            <div className="font-medium">{remainingText(item)}</div>
                            {item.partially_used && <div className="text-xs font-semibold uppercase tracking-wide">Partly used</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              );
            })}
          </div>
        )}

        {selected.length > 0 && (
          <footer className="mt-4 break-inside-avoid border-t border-black pt-2 text-sm">
            <div className="font-semibold">{summaryText(totals)}</div>
            {totals.partly > 0 && <div>{totals.partly} partly used; the amount still available is shown.</div>}
            {leftOff > 0 && <div>{leftOff} other expiring item{leftOff === 1 ? ' was' : 's were'} left off this list by choice.</div>}
            <div className="mt-1 text-xs text-slate-600">
              "Use by" is the benefit's own expiration date when one is recorded; otherwise, for a dollar credit, the last day of the month, quarter, half-year or year it resets on.
              A credit that resets during the year shows only what is left in its current period.
              {totals.undated > 0 && <> "Check certificate" or "Check terms" means no expiration date is recorded for that certificate, pass or other benefit. It is listed by the year the app tracks it in, but it may expire on a different day (often a year after it was issued).</>}
            </div>
          </footer>
        )}
      </section>
    </div>
  );
}
