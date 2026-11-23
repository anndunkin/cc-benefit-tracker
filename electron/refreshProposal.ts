// refreshProposal.ts — turns a prepared "refresh proposal" into a reviewable
// draft refresh run.
//
// Until v1.0.24 the Quarterly Refresh screen could review a run but nothing in
// the app could ever CREATE one, so no refresh was ever proposed. A proposal is
// a small JSON document listing published benefit changes. It identifies each
// benefit by (card_id | program_id, title) because row ids differ between
// databases. This module:
//   • validates a proposal (it may come from a file the user picked, so it is
//     treated as untrusted input),
//   • compares it with the LIVE database and keeps only real differences,
//   • creates a draft run that the user approves or rejects row by row.
// Nothing here modifies a benefit. Changes reach the benefits table only via
// refreshApplyRun, after the user approves them.

import type Database from 'better-sqlite3';
import type {
  Benefit, Card, PointsCurrency, RefreshChange,
  RefreshProposal, RefreshProposalChange, RefreshProposalResult, RefreshUnmatched,
} from './types';
import {
  refreshStartRun, refreshPendingChanges, refreshApproveChange, refreshApplyRun,
  metaGet, metaSet,
} from './database';
import { BUNDLED_REFRESH_PROPOSALS } from './refreshProposalData';

export const PROPOSAL_FORMAT = 'cc-benefit-tracker-refresh';
export const PROPOSAL_FORMAT_VERSION = 1;
export const MAX_PROPOSAL_BYTES = 2 * 1024 * 1024;
const MAX_CHANGES = 500;

const RESET_CADENCES = ['annual', 'semiannual', 'quarterly', 'monthly', 'spend_threshold', 'unlimited', 'one_time'];
const CATEGORIES = [
  'travel_credit', 'dining_credit', 'retail_credit', 'entertainment_credit', 'rideshare_credit',
  'wellness_credit', 'hotel_credit', 'airline_credit', 'free_night', 'upgrade', 'status_boost',
  'earning_multiplier', 'lounge_access', 'other',
];
const SPEND_CATEGORIES = [
  'airfare', 'hotels', 'car_rentals', 'dining', 'groceries', 'gas', 'rideshare_transit',
  'streaming_entertainment', 'online_shopping', 'everyday_everything_else',
];
const NETWORKS = ['Amex', 'Visa', 'Mastercard', 'Other'];

type FieldKind = 'text' | 'longtext' | 'number' | 'int' | 'date' | 'url' | 'flag'
  | { enum: string[] };
interface FieldRule { kind: FieldKind; nullable: boolean }

/** Benefit columns a refresh may set. Anything else in `after` is rejected. */
export const BENEFIT_FIELDS: Record<string, FieldRule> = {
  title:                { kind: 'text', nullable: false },
  description:          { kind: 'longtext', nullable: true },
  category:             { kind: { enum: CATEGORIES }, nullable: false },
  reset_cadence:        { kind: { enum: RESET_CADENCES }, nullable: false },
  uses_per_period:      { kind: 'int', nullable: true },
  value_usd:            { kind: 'number', nullable: true },
  spend_threshold_usd:  { kind: 'number', nullable: true },
  expiration_note:      { kind: 'longtext', nullable: true },
  reset_years:          { kind: 'int', nullable: true },
  multiplier_rate:      { kind: 'number', nullable: true },
  multiplier_currency:  { kind: 'text', nullable: true },
  spend_category:       { kind: { enum: SPEND_CATEGORIES }, nullable: true },
  spend_category_note:  { kind: 'longtext', nullable: true },
  previous_value_usd:   { kind: 'number', nullable: true },
  value_effective_date: { kind: 'date', nullable: true },
  source_url:           { kind: 'url', nullable: true },
  notes:                { kind: 'longtext', nullable: true },
};
/** Extra columns allowed only when a proposal ADDS a benefit. */
const BENEFIT_ADD_ONLY_FIELDS: Record<string, FieldRule> = {
  sort_order:                 { kind: 'int', nullable: false },
  is_choice_option:           { kind: 'flag', nullable: false },
  prerequisite_benefit_title: { kind: 'text', nullable: true },
};
/** A modified benefit may also be moved under another benefit (v1.0.27), named by title. */
const BENEFIT_MODIFY_EXTRA_FIELDS: Record<string, FieldRule> = {
  prerequisite_benefit_title: { kind: 'text', nullable: false },
};
export const CARD_FIELDS: Record<string, FieldRule> = {
  name:           { kind: 'text', nullable: false },
  issuer:         { kind: 'text', nullable: false },
  network:        { kind: { enum: NETWORKS }, nullable: false },
  annual_fee_usd: { kind: 'number', nullable: true },
  source_url:     { kind: 'url', nullable: true },
  notes:          { kind: 'longtext', nullable: true },
};
const PROGRAM_TYPES = ['airline', 'hotel', 'other', 'airline_elite_status', 'hotel_elite_status', 'hotel_paid_membership'];
/** Columns of a loyalty program that a proposal may set when it ADDS the program. */
export const PROGRAM_FIELDS: Record<string, FieldRule> = {
  name:         { kind: 'text', nullable: false },
  program_type: { kind: { enum: PROGRAM_TYPES }, nullable: false },
  source_url:   { kind: 'url', nullable: true },
  notes:        { kind: 'longtext', nullable: true },
};
export const POINTS_CURRENCY_FIELDS: Record<string, FieldRule> = {
  value_cents_per_point: { kind: 'number', nullable: false },
  source_name:           { kind: 'text', nullable: false },
  source_url:            { kind: 'url', nullable: true },
  notes:                 { kind: 'longtext', nullable: true },
};

const ID_RE = /^[a-z0-9][a-z0-9_.-]{1,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2000) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}
function cleanText(where: string, v: unknown, max: number): string {
  if (typeof v !== 'string') throw new Error(`${where} must be text`);
  const s = v.trim();
  if (!s) throw new Error(`${where} must not be empty`);
  if (s.length > max) throw new Error(`${where} is too long (max ${max} characters)`);
  // Control characters other than tab/newline never belong in benefit text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw new Error(`${where} contains control characters`);
  return s;
}
function cleanId(where: string, v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error(`${where} is not a valid id`);
  return v;
}

function cleanField(where: string, rule: FieldRule, v: unknown): unknown {
  if (v === null) {
    if (!rule.nullable) throw new Error(`${where} cannot be empty`);
    return null;
  }
  const k = rule.kind;
  if (k === 'text') return cleanText(where, v, 300);
  if (k === 'longtext') return cleanText(where, v, 4000);
  if (k === 'number' || k === 'int') {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100_000_000) {
      throw new Error(`${where} must be a number between 0 and 100,000,000`);
    }
    if (k === 'int' && !Number.isInteger(v)) throw new Error(`${where} must be a whole number`);
    return v;
  }
  if (k === 'flag') {
    if (v !== 0 && v !== 1) throw new Error(`${where} must be 0 or 1`);
    return v;
  }
  if (k === 'date') {
    if (!isIsoDate(v)) throw new Error(`${where} must be a date (YYYY-MM-DD)`);
    return v;
  }
  if (k === 'url') {
    if (!isHttpsUrl(v)) throw new Error(`${where} must be an https:// link`);
    return v;
  }
  if (typeof v !== 'string' || !k.enum.includes(v)) {
    throw new Error(`${where} must be one of: ${k.enum.join(', ')}`);
  }
  return v;
}

function cleanAfter(where: string, raw: unknown, rules: Record<string, FieldRule>): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Error(`${where}.after must be an object`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = rules[key];
    if (!rule) throw new Error(`${where}.after has an unsupported field "${key}"`);
    out[key] = cleanField(`${where}.after.${key}`, rule, value);
  }
  return out;
}

/**
 * Validate an untrusted proposal document. Returns a cleaned copy containing
 * only known fields; throws a readable Error describing the first problem.
 */
export function validateProposal(raw: unknown): RefreshProposal {
  if (!isPlainObject(raw)) throw new Error('This is not a benefit refresh file.');
  if (raw.format !== PROPOSAL_FORMAT) throw new Error('This is not a benefit refresh file.');
  if (raw.format_version !== PROPOSAL_FORMAT_VERSION) {
    throw new Error(`Unsupported refresh file version: ${String(raw.format_version)}`);
  }
  const proposal_id = cleanId('proposal_id', raw.proposal_id);
  const title = cleanText('title', raw.title, 200);
  if (!isIsoDate(raw.prepared_on)) throw new Error('prepared_on must be a date (YYYY-MM-DD)');
  let not_before: string | null = null;
  if (raw.not_before !== undefined && raw.not_before !== null) {
    if (!isIsoDate(raw.not_before)) throw new Error('not_before must be a date (YYYY-MM-DD)');
    not_before = raw.not_before;
  }
  if (!Array.isArray(raw.changes) || raw.changes.length === 0) {
    throw new Error('The refresh file contains no changes.');
  }
  if (raw.changes.length > MAX_CHANGES) throw new Error(`The refresh file has more than ${MAX_CHANGES} changes.`);

  const changes: RefreshProposalChange[] = raw.changes.map((c: unknown, i: number) => {
    const where = `changes[${i}]`;
    if (!isPlainObject(c)) throw new Error(`${where} must be an object`);
    const scope = c.scope;
    const change_type = c.change_type;
    if (scope !== 'benefit' && scope !== 'card' && scope !== 'points_currency' && scope !== 'program') {
      throw new Error(`${where}.scope must be benefit, card, points_currency or program`);
    }
    if (change_type !== 'added' && change_type !== 'modified' && change_type !== 'removed') {
      throw new Error(`${where}.change_type must be added, modified or removed`);
    }
    const summary = cleanText(`${where}.summary`, c.summary, 1000);
    let effective_date: string | null = null;
    if (c.effective_date !== undefined && c.effective_date !== null) {
      if (!isIsoDate(c.effective_date)) throw new Error(`${where}.effective_date must be a date (YYYY-MM-DD)`);
      effective_date = c.effective_date;
    }
    if (!Array.isArray(c.sources) || c.sources.length === 0) {
      throw new Error(`${where} must cite at least one source`);
    }
    if (c.sources.length > 10) throw new Error(`${where} cites too many sources`);
    const sources = c.sources.map((s: unknown, j: number) => {
      if (!isPlainObject(s)) throw new Error(`${where}.sources[${j}] must be an object`);
      if (!isHttpsUrl(s.url)) throw new Error(`${where}.sources[${j}].url must be an https:// link`);
      return {
        url: s.url,
        label: s.label === undefined || s.label === null ? null : cleanText(`${where}.sources[${j}].label`, s.label, 200),
        source_type: s.source_type === 'official' ? 'official' as const : 'secondary' as const,
      };
    });

    const base = { scope, change_type, summary, effective_date, sources } as const;

    if (scope === 'benefit') {
      const card_id = c.card_id === undefined || c.card_id === null ? null : cleanId(`${where}.card_id`, c.card_id);
      const program_id = c.program_id === undefined || c.program_id === null ? null : cleanId(`${where}.program_id`, c.program_id);
      if ((card_id === null) === (program_id === null)) {
        throw new Error(`${where} must name exactly one of card_id or program_id`);
      }
      if (change_type === 'added') {
        const after = cleanAfter(where, c.after, { ...BENEFIT_FIELDS, ...BENEFIT_ADD_ONLY_FIELDS });
        for (const req of ['title', 'category', 'reset_cadence']) {
          if (after[req] === undefined) throw new Error(`${where}.after.${req} is required for an added benefit`);
        }
        return { ...base, card_id, program_id, points_currency_id: null, match_title: null, after };
      }
      const match_title = cleanText(`${where}.match_title`, c.match_title, 300);
      if (change_type === 'removed') {
        return { ...base, card_id, program_id, points_currency_id: null, match_title, after: {} };
      }
      const after = cleanAfter(where, c.after, { ...BENEFIT_FIELDS, ...BENEFIT_MODIFY_EXTRA_FIELDS });
      if (Object.keys(after).length === 0) throw new Error(`${where}.after must change at least one field`);
      return { ...base, card_id, program_id, points_currency_id: null, match_title, after };
    }

    if (scope === 'program') {
      // A proposal can add a loyalty program (and, in the same file, its benefits).
      // Renaming or removing a program is left to the user.
      if (change_type !== 'added') throw new Error(`${where}: only "added" is supported for program`);
      const after = cleanAfter(where, c.after, PROGRAM_FIELDS);
      for (const req of ['name', 'program_type']) {
        if (after[req] === undefined) throw new Error(`${where}.after.${req} is required for an added program`);
      }
      return {
        ...base, card_id: null, program_id: cleanId(`${where}.program_id`, c.program_id),
        points_currency_id: null, match_title: null, after,
      };
    }

    if (change_type !== 'modified') throw new Error(`${where}: only "modified" is supported for ${scope}`);
    if (scope === 'card') {
      const after = cleanAfter(where, c.after, CARD_FIELDS);
      if (Object.keys(after).length === 0) throw new Error(`${where}.after must change at least one field`);
      return {
        ...base, card_id: cleanId(`${where}.card_id`, c.card_id), program_id: null,
        points_currency_id: null, match_title: null, after,
      };
    }
    const after = cleanAfter(where, c.after, POINTS_CURRENCY_FIELDS);
    if (Object.keys(after).length === 0) throw new Error(`${where}.after must change at least one field`);
    return {
      ...base, card_id: null, program_id: null,
      points_currency_id: cleanId(`${where}.points_currency_id`, c.points_currency_id),
      match_title: null, after,
    };
  });

  return { format: PROPOSAL_FORMAT, format_version: PROPOSAL_FORMAT_VERSION, proposal_id, title, prepared_on: raw.prepared_on, not_before, changes };
}

// ─── Comparing a proposal with the live database ─────────────────────────────

type ChangeInput = Omit<RefreshChange, 'id' | 'refresh_run_id' | 'created_at' | 'review_status' | 'review_notes' | 'overwrite_user_edit' | 'target_user_modified'>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}
function metaFor(p: RefreshProposal, c: RefreshProposalChange) {
  return {
    scope: c.scope,
    proposal_id: p.proposal_id,
    summary: c.summary,
    effective_date: c.effective_date ?? null,
    sources: c.sources,
  };
}
function ownerLabel(c: RefreshProposalChange): string {
  return c.card_id ?? c.program_id ?? c.points_currency_id ?? '';
}
function unmatched(c: RefreshProposalChange, reason: string): RefreshUnmatched {
  const after = c.after ?? {};
  return {
    owner_id: ownerLabel(c),
    title: c.match_title ?? (typeof after.title === 'string' ? after.title : ownerLabel(c)),
    summary: c.summary,
    reason,
    sources: c.sources,
  };
}

/**
 * Work out which proposal changes actually differ from the live database.
 * Read-only. `changes` is ready to pass to refreshStartRun.
 */
export function diffProposal(database: Database.Database, proposal: RefreshProposal): {
  changes: ChangeInput[]; already_current: number; unmatched: RefreshUnmatched[];
} {
  const changes: ChangeInput[] = [];
  const unmatchedList: RefreshUnmatched[] = [];
  let already = 0;

  const findBenefits = database.prepare(`
    SELECT * FROM benefits
    WHERE card_id IS ? AND program_id IS ? AND lower(trim(title)) = lower(trim(?))
    ORDER BY is_active DESC, id ASC
  `);
  const titleOf = database.prepare('SELECT title FROM benefits WHERE id = ?');
  const hasCard = database.prepare('SELECT 1 FROM cards WHERE id = ?');
  const hasProgram = database.prepare('SELECT 1 FROM programs WHERE id = ?');

  // Programs this proposal adds that are not in the file yet. Their benefits can
  // be proposed alongside them; they are created only if the program is approved.
  const proposedPrograms = new Set<string>();
  for (const c of proposal.changes) {
    if (c.scope === 'program' && c.program_id && !hasProgram.get(c.program_id)) proposedPrograms.add(c.program_id);
  }
  const programQueued = new Set<string>();

  for (const c of proposal.changes) {
    const after = c.after ?? {};
    const meta = metaFor(proposal, c);

    if (c.scope === 'program') {
      const id = c.program_id as string;
      if (!proposedPrograms.has(id) || programQueued.has(id)) { already++; continue; }
      programQueued.add(id);
      changes.push({
        change_type: 'added', card_id: null, program_id: id, benefit_id: null, points_currency_id: null,
        before_json: null,
        after_json: JSON.stringify({ ...after, _meta: meta }),
      });
      continue;
    }

    if (c.scope === 'card') {
      const card = database.prepare('SELECT * FROM cards WHERE id = ?').get(c.card_id) as Card | undefined;
      if (!card) { unmatchedList.push(unmatched(c, 'This card is not in your file.')); continue; }
      const diff: Record<string, unknown> = {};
      const before: Record<string, unknown> = { name: card.name };
      for (const [k, v] of Object.entries(after)) {
        if (!sameValue((card as unknown as Record<string, unknown>)[k], v)) { diff[k] = v; before[k] = (card as unknown as Record<string, unknown>)[k] ?? null; }
      }
      if (Object.keys(diff).length === 0) { already++; continue; }
      changes.push({
        change_type: 'modified', card_id: card.id, program_id: null, benefit_id: null, points_currency_id: null,
        before_json: JSON.stringify(before),
        after_json: JSON.stringify({ ...diff, _meta: meta }),
      });
      continue;
    }

    if (c.scope === 'points_currency') {
      const pc = database.prepare('SELECT * FROM points_currencies WHERE id = ?').get(c.points_currency_id) as PointsCurrency | undefined;
      if (!pc) { unmatchedList.push(unmatched(c, 'This points currency is not in your file.')); continue; }
      const diff: Record<string, unknown> = {};
      const before: Record<string, unknown> = { name: pc.name };
      for (const [k, v] of Object.entries(after)) {
        if (!sameValue((pc as unknown as Record<string, unknown>)[k], v)) { diff[k] = v; before[k] = (pc as unknown as Record<string, unknown>)[k] ?? null; }
      }
      if (Object.keys(diff).length === 0) { already++; continue; }
      changes.push({
        change_type: 'modified', card_id: null, program_id: null, benefit_id: null, points_currency_id: pc.id,
        before_json: JSON.stringify(before),
        after_json: JSON.stringify({ name: pc.name, ...diff, _meta: meta }),
      });
      continue;
    }

    // ── Benefit changes ──
    const ownerExists = c.card_id
      ? hasCard.get(c.card_id)
      : hasProgram.get(c.program_id) || (c.change_type === 'added' && proposedPrograms.has(c.program_id as string));
    if (!ownerExists) {
      unmatchedList.push(unmatched(c, c.card_id ? 'This card is not in your file.' : 'This program is not in your file.'));
      continue;
    }

    if (c.change_type === 'added') {
      const existing = findBenefits.all(c.card_id ?? null, c.program_id ?? null, String(after.title)) as Benefit[];
      if (existing.length > 0) { already++; continue; }
      changes.push({
        change_type: 'added', card_id: c.card_id ?? null, program_id: c.program_id ?? null,
        benefit_id: null, points_currency_id: null, before_json: null,
        after_json: JSON.stringify({ ...after, card_id: c.card_id ?? null, program_id: c.program_id ?? null, _meta: meta }),
      });
      continue;
    }

    const rows = (findBenefits.all(c.card_id ?? null, c.program_id ?? null, c.match_title) as Benefit[])
      .filter(r => r.is_active === 1);

    if (c.change_type === 'removed') {
      if (rows.length === 0) { already++; continue; }   // already gone or retired
      const row = rows[0];
      changes.push({
        change_type: 'removed', card_id: row.card_id, program_id: row.program_id, benefit_id: row.id,
        points_currency_id: null,
        before_json: JSON.stringify({ title: row.title, description: row.description, value_usd: row.value_usd, reset_cadence: row.reset_cadence }),
        after_json: JSON.stringify({ _meta: meta }),
      });
      continue;
    }

    // modified
    let row: Benefit | undefined = rows[0];
    if (!row && typeof after.title === 'string') {
      // The row may already carry the new title (refresh applied earlier, or a fresh install).
      row = (findBenefits.all(c.card_id ?? null, c.program_id ?? null, after.title) as Benefit[]).find(r => r.is_active === 1);
    }
    if (!row) {
      unmatchedList.push(unmatched(c, 'No benefit with this name was found. It may have been renamed or deleted.'));
      continue;
    }
    const diff: Record<string, unknown> = {};
    const before: Record<string, unknown> = { title: row.title };
    for (const [k, v] of Object.entries(after)) {
      if (k === 'prerequisite_benefit_title') {
        // Compared by the title of the row it currently hangs off, not by id.
        const parent = row.prerequisite_benefit_id
          ? (titleOf.get(row.prerequisite_benefit_id) as { title: string } | undefined)?.title ?? null : null;
        if ((parent ?? '').trim().toLowerCase() !== String(v).trim().toLowerCase()) { diff[k] = v; before[k] = parent; }
        continue;
      }
      const cur = (row as unknown as Record<string, unknown>)[k];
      if (!sameValue(cur, v)) { diff[k] = v; before[k] = cur ?? null; }
    }
    if (Object.keys(diff).length === 0) { already++; continue; }
    changes.push({
      change_type: 'modified', card_id: row.card_id, program_id: row.program_id, benefit_id: row.id,
      points_currency_id: null,
      before_json: JSON.stringify(before),
      after_json: JSON.stringify({ ...diff, _meta: meta }),
    });
  }
  return { changes, already_current: already, unmatched: unmatchedList };
}

// ─── Creating runs ───────────────────────────────────────────────────────────

function marker(proposalId: string): string { return `[refresh:${proposalId}]`; }

function hasDraftRun(database: Database.Database): number | null {
  const r = database.prepare(`SELECT id FROM refresh_runs WHERE status = 'draft' ORDER BY started_at DESC, id DESC LIMIT 1`).get() as { id: number } | undefined;
  return r?.id ?? null;
}
function proposalSeen(database: Database.Database, proposalId: string): boolean {
  // The marker lives in source_notes so that "already offered" travels with the
  // data through Save As, JSON export and JSON import.
  const needle = marker(proposalId).replace(/[\\%_]/g, m => `\\${m}`);
  return !!database.prepare(`SELECT 1 FROM refresh_runs WHERE source_notes LIKE ? ESCAPE '\\' LIMIT 1`).get(`%${needle}%`);
}
export function unmatchedMetaKey(runId: number): string { return `refresh_unmatched:${runId}`; }

/**
 * Create a draft run from a validated proposal. Returns state 'up_to_date'
 * (and creates nothing) when the live database already matches.
 */
export function createRunFromProposal(database: Database.Database, proposal: RefreshProposal): RefreshProposalResult {
  const draft = hasDraftRun(database);
  if (draft !== null) {
    return { state: 'draft_exists', run_id: draft, title: proposal.title, proposed: 0, already_current: 0, unmatched: [] };
  }
  const diff = diffProposal(database, proposal);
  if (diff.changes.length === 0) {
    return { state: 'up_to_date', run_id: null, title: proposal.title, proposed: 0, already_current: diff.already_current, unmatched: diff.unmatched };
  }
  const tx = database.transaction(() => {
    const { run_id } = refreshStartRun(database, `${proposal.title} — prepared ${proposal.prepared_on} ${marker(proposal.proposal_id)}`, diff.changes);
    if (diff.unmatched.length) metaSet(database, unmatchedMetaKey(run_id), JSON.stringify(diff.unmatched));
    return run_id;
  });
  const run_id = tx();
  return { state: 'created', run_id, title: proposal.title, proposed: diff.changes.length, already_current: diff.already_current, unmatched: diff.unmatched };
}

function todayIso(now: Date): string {
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface OfferOptions {
  /** A database seeded moments ago has no user data: apply instead of asking. */
  fresh?: boolean;
  /** Re-offer proposals that were already applied or discarded (manual "check again"). */
  force?: boolean;
  now?: Date;
  proposals?: RefreshProposal[];
}

/**
 * Offer the refresh proposals bundled with this version of the app.
 *  • Existing data: the first proposal that is due, not yet offered, and
 *    actually differs from the database becomes a draft run for review.
 *  • Fresh database: every due proposal is applied directly, because there
 *    are no user edits or usage to protect and a new install should start
 *    from the current catalog.
 * Proposals whose not_before date is in the future wait until that date.
 */
export function offerBundledProposals(database: Database.Database, opts: OfferOptions = {}): RefreshProposalResult {
  const today = todayIso(opts.now ?? new Date());
  const proposals = (opts.proposals ?? BUNDLED_REFRESH_PROPOSALS)
    .filter(p => !p.not_before || p.not_before <= today)
    .sort((a, b) => (a.not_before ?? a.prepared_on).localeCompare(b.not_before ?? b.prepared_on));

  const none: RefreshProposalResult = { state: 'up_to_date', run_id: null, title: null, proposed: 0, already_current: 0, unmatched: [] };

  if (opts.fresh) {
    let last = none;
    for (const p of proposals) {
      if (proposalSeen(database, p.proposal_id)) continue;
      const r = createRunFromProposal(database, p);
      if (r.state !== 'created' || r.run_id === null) continue;
      for (const ch of refreshPendingChanges(database, r.run_id)) refreshApproveChange(database, ch.id);
      refreshApplyRun(database, r.run_id);
      last = { ...r, state: 'applied' };
    }
    return last;
  }

  const draft = hasDraftRun(database);
  if (draft !== null) return { ...none, state: 'draft_exists', run_id: draft };

  let carried: RefreshProposalResult = none;
  for (const p of proposals) {
    if (!opts.force && proposalSeen(database, p.proposal_id)) continue;
    const r = createRunFromProposal(database, p);
    if (r.state === 'created') return r;
    // Nothing to propose from this one; remember what could not be matched so
    // a manual check can still report it.
    carried = {
      ...carried, title: r.title,
      already_current: carried.already_current + r.already_current,
      unmatched: [...carried.unmatched, ...r.unmatched],
    };
  }
  return carried;
}

/** Parse + validate proposal text read from a user-chosen file, then create a run. */
export function importProposalText(database: Database.Database, text: string): RefreshProposalResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_PROPOSAL_BYTES) throw new Error('The refresh file is too large.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  return createRunFromProposal(database, validateProposal(raw));
}

/** Unmatched items recorded for a run (shown on the Refresh page). */
export function unmatchedForRun(database: Database.Database, runId: number | null): RefreshUnmatched[] {
  if (runId === null) return [];
  try {
    const raw = metaGet(database, unmatchedMetaKey(runId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as RefreshUnmatched[] : [];
  } catch { return []; }
}
