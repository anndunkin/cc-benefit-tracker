import { useEffect, useState } from 'react';
import type { Benefit, Usage } from '../../electron/types';
import { fmtUsd } from '../lib/format';
import { isMilestone, tracksEarnedNights, valueAtDate } from '../../electron/benefitRules';
import { localIsoDate } from '../../electron/expiringCredits';
import { certificateDisplay, isCompanionCertificate, isHyattSpendCertificate, isOmniStayBenefit, OMNI_STAY_REQUIREMENT, OMNI_STAY_TERMS } from '../../electron/certificateRules';

export default function LogUsageModal({
  benefitId, onClose, onSaved, refYear,
}: { benefitId: number; onClose: () => void; onSaved: () => void; refYear?: number }) {
  const [benefit, setBenefit] = useState<Benefit | null>(null);
  const [history, setHistory] = useState<Usage[]>([]);
  const today = localIsoDate();
  const [usedOn, setUsedOn] = useState(refYear && refYear !== Number(today.slice(0, 4)) ? `${refYear}-06-15` : today);
  const [quantity, setQuantity] = useState('1');
  const [expiration, setExpiration] = useState('');
  const [amount, setAmount] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [loggingRedemption, setLoggingRedemption] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      window.api.benefits.getById(benefitId),
      window.api.usages.getForBenefit(benefitId),
    ]).then(([b, u]) => {
      setBenefit(b);
      setExpiration(b?.expiration_date ?? '');
      setHistory(u);
      // Only prefill the amount when this is a plain dollar-valued benefit.
      // Count-based benefits (SkyClub visits, upgrade certificates, etc.)
      // record no dollar amount — leave the field empty and hide it.
      // Spend-threshold benefits: leave empty so each entry captures the
      // fresh spend increment (not the total value).
      if (b && b.reset_cadence !== 'spend_threshold' && (b.value_usd ?? 0) > 0) {
        setAmount(String(valueAtDate(b, usedOn) ?? ''));
      } else {
        setAmount('');
      }
    });
  }, [benefitId]);

  // A benefit is "spend-threshold" when its cadence is spend_threshold: the
  // amount field IS the metric (dollars spent toward the threshold), regardless
  // of value_usd. Otherwise a benefit is "count-based" when it has no per-use
  // dollar value (SkyClub visits, systemwide upgrades, etc.) — no dollar field.
  const isSpendThreshold = !!benefit && benefit.reset_cadence === 'spend_threshold';
  const hyattSpend = !!benefit && isHyattSpendCertificate(benefit);
  const omniStay = !!benefit && isOmniStayBenefit(benefit);
  const isCountBased =
    omniStay || (!!benefit &&
    !isSpendThreshold &&
    (benefit.value_usd == null || benefit.value_usd === 0));
  // The amount field is available whenever the user might want to record a
  // dollar amount. Spend-threshold and dollar-valued benefits always show it;
  // count-based benefits (unlimited access, visit-count) omit it by default.
  const showAmountField = !isCountBased;
  const earnedNights = !!benefit && tracksEarnedNights(benefit);
  const milestone = !!benefit && isMilestone(benefit);
  const hasCertificateDate = !!benefit && !omniStay && !milestone && !hyattSpend
    && (benefit.category === 'free_night' || isCompanionCertificate(benefit));
  const certificateDetails = hasCertificateDate && !isSpendThreshold;
  const showUsageFields = !certificateDetails || loggingRedemption;
  const dialogTitle = omniStay ? 'Log Omni stay' : certificateDetails ? 'Certificate details' : milestone ? 'Achievement details' : earnedNights ? 'Log nights earned' : 'Log usage';

  async function saveExpiration() {
    if (saving) return;
    setSaving(true); setErr(null);
    try {
      await window.api.benefits.update(benefitId, { expiration_date: expiration || null });
      onSaved();
    } catch (e) { setErr(String(e)); setSaving(false); }
  }

  async function save() {
    if (saving || (certificateDetails && (!loggingRedemption || !usedOn))) return;
    setSaving(true); setErr(null);
    try {
      await window.api.usages.create({
        benefit_id: benefitId,
        quantity: earnedNights || omniStay ? Number(quantity) : 1,
        ...(hasCertificateDate ? { expiration_date: expiration || null } : {}),
        used_on: usedOn,
        // Count-based benefits never carry a dollar amount.
        amount_usd: isCountBased ? null : (amount === '' ? null : parseFloat(amount)),
        notes: notes.trim() || null,
      });
      // Reset transient inputs so the next entry starts clean. onSaved() closes
      // the modal by default, but clearing here also protects against future
      // refactors that keep it open.
      setAmount('');
      setNotes('');
      onSaved();
    } catch (e) {
      setErr(String(e));
      setSaving(false);
    }
  }

  async function del(id: number) {
    if (!confirm('Delete this usage entry?')) return;
    await window.api.usages.delete(id);
    setHistory(await window.api.usages.getForBenefit(benefitId));
    // v1.0.6 fix: also refresh the dashboard so the deleted usage disappears
    // from the parent card's counters/progress. Previously the modal refreshed
    // its own history but the dashboard state was stale until reload.
    onSaved();
  }

  if (!benefit) return null;
  const certificate = certificateDisplay(benefit);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-label={dialogTitle} className="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-lg font-semibold">{dialogTitle}</h2>
            <div className="text-sm text-slate-500">{certificate.title}</div>
            {certificate.earnedLabel && <div className="text-xs text-slate-500">{certificate.earnedLabel}</div>}
          </div>
          <button className="btn-ghost text-xs" onClick={onClose}>Close</button>
        </div>
        {hasCertificateDate && <div className="mb-4 border-b border-slate-200 pb-4">
          <label className="label" htmlFor="certificate-expiration">Certificate expiration date</label>
          <input id="certificate-expiration" type="date" className="input" value={expiration} onChange={e => setExpiration(e.target.value)} />
          {!certificateDetails && <button className="btn-ghost text-xs mt-2" disabled={saving} onClick={saveExpiration}>Save expiration only</button>}
          <p className="text-xs text-slate-500 mt-1">Save the expiration whether or not you’ve used the certificate. This does not record a redemption.</p>
        </div>}

        {certificateDetails && !loggingRedemption && (
          <button className="btn-ghost text-sm" disabled={saving} onClick={() => { setUsedOn(''); setLoggingRedemption(true); }}>Log redemption…</button>
        )}
        {showUsageFields && <>
        {omniStay && <p className="text-xs text-slate-500 mb-3">{OMNI_STAY_REQUIREMENT} {OMNI_STAY_TERMS}</p>}
        <div className={showAmountField ? 'grid grid-cols-2 gap-3' : ''}>
          <div>
            <label className="label" htmlFor="entry-date">{omniStay ? 'Checkout date' : milestone ? 'Date achieved' : earnedNights ? 'Date earned' : isSpendThreshold ? 'Date spent' : 'Date used'}</label>
            <input id="entry-date" type="date" className="input" value={usedOn} required={certificateDetails || omniStay} max={omniStay ? today : undefined} onChange={e => {
              setUsedOn(e.target.value);
              if (benefit.value_effective_date) setAmount(String(valueAtDate(benefit, e.target.value) ?? ''));
            }} />
          </div>
          {showAmountField && (
            <div>
              <label className="label">Amount (USD)</label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="input"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder={
                  isSpendThreshold
                    ? 'e.g., 1500.00'
                    : (benefit.value_usd?.toString() ?? '0.00')
                }
              />
              {isSpendThreshold && (
                <div className="text-xs text-slate-500 mt-1">
                  Enter new qualifying spend (a purchase or a monthly total), not an amount already logged. Progress toward
                  ${benefit.spend_threshold_usd?.toLocaleString() ?? '—'} accumulates across entries.
                  {hyattSpend && ' The earned certificate will appear separately on the dashboard.'}
                </div>
              )}
            </div>
          )}
        </div>
        {(earnedNights || omniStay) && <div className="mt-3">
          <label className="label" htmlFor={omniStay ? 'omni-stay-nights' : 'earned-nights'}>{omniStay ? 'Consecutive nights on this reservation' : 'Number of nights earned'}</label>
          <input id={omniStay ? 'omni-stay-nights' : 'earned-nights'} type="number" min="1" max="1000000" step="1" className="input" value={quantity} onChange={e => setQuantity(e.target.value)} />
          <p className="text-xs text-slate-500">{omniStay ? 'Enter one completed reservation at a time. Separate stays do not combine.' : 'Enter newly earned nights, not your year-to-date total.'}</p>
        </div>}
        <div className="mt-3">
          <label className="label">Notes</label>
          <input type="text" className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional context (hotel name, purchase, etc.)" />
        </div>
        </>}

        {err && <div role="alert" className="text-sm text-red-600 mt-2">{err}</div>}

        <div className="flex flex-wrap justify-end gap-2 mt-4 sticky bottom-0 bg-white dark:bg-slate-900 py-2">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          {certificateDetails && <button className={loggingRedemption && usedOn ? 'btn-ghost' : 'btn-primary'} onClick={saveExpiration} disabled={saving}>Save expiration</button>}
          {showUsageFields && <button className="btn-primary" onClick={save} disabled={saving || ((certificateDetails || omniStay) && !usedOn) || (milestone && history.some(u => u.used_on.slice(0, 4) === usedOn.slice(0, 4)))}>{saving ? 'Saving…' : omniStay ? 'Save stay' : certificateDetails ? 'Save redemption' : milestone ? 'Save achievement' : 'Save usage'}</button>}
        </div>

        {history.length > 0 && (
          <div className="mt-6">
            <div className="label mb-2">History</div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-200 dark:divide-slate-800 max-h-52 overflow-auto">
              {history.map(u => (
                <div key={u.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="font-mono text-xs w-24 text-slate-500">{u.used_on}</span>
                  {isCountBased ? (
                    <span className="font-mono w-20 text-slate-500">{milestone ? 'Achieved' : `${u.quantity ?? 1} ${earnedNights || omniStay ? 'night(s)' : 'use(s)'}`}</span>
                  ) : (
                    <span className="font-mono w-20">{fmtUsd(u.amount_usd)}</span>
                  )}
                  <span className="text-xs text-slate-500 flex-1 truncate">{u.notes ?? ''}</span>
                  <button className="text-xs text-red-500 hover:text-red-700" onClick={() => del(u.id)}>Delete</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
