// ─── Shared types ────────────────────────────────────────────────────────────
// Every renderer- and main-side call passes through the shapes below.
// Keep changes here in lock-step with the SQLite schema in database.ts and the
// preload/main IPC contract.

export const APP_FILE_VERSION = 1;

/** How often a benefit's usage cap resets. */
export type ResetCadence =
  | 'annual'         // 1 use per calendar year
  | 'semiannual'     // 2 uses per year (H1 / H2)
  | 'quarterly'      // 4 uses per year
  | 'monthly'        // 12 uses per year
  | 'spend_threshold'// unlocks after hitting a $ threshold (e.g., $30k free night)
  | 'unlimited'      // no cap — status perks, earning multipliers, unlimited discounts
  | 'one_time';      // single use across the life of the account (or specific expiration)

/** Broad category — drives icons/colors and dashboard grouping. */
export type BenefitCategory =
  | 'travel_credit'
  | 'dining_credit'
  | 'retail_credit'
  | 'entertainment_credit'
  | 'rideshare_credit'
  | 'wellness_credit'
  | 'hotel_credit'
  | 'airline_credit'
  | 'free_night'
  | 'upgrade'
  | 'status_boost'
  | 'earning_multiplier'
  | 'lounge_access'
  | 'other';

/** Networks / issuers — free-form but common values documented. */
export type CardNetwork = 'Amex' | 'Visa' | 'Mastercard' | 'Other';

// ─── Cards ────────────────────────────────────────────────────────────────────

export interface Card {
  id: string;
  name: string;
  issuer: string;
  network: CardNetwork;
  annual_fee_usd: number | null;
  is_active: number;            // 0 | 1
  is_visible: number;           // 0 | 1 — whether card appears on dashboard/cards page
  color_hex: string | null;     // optional accent color for the UI card
  notes: string | null;
  source_url: string | null;
  created_at: string;
}

export interface CardInput {
  id?: string;                  // if omitted, generated from slugified name
  name: string;
  issuer: string;
  network: CardNetwork;
  annual_fee_usd: number | null;
  color_hex?: string | null;
  notes?: string | null;
  source_url?: string | null;
  is_active?: number;
  is_visible?: number;
}

// ─── Programs (status/loyalty) ────────────────────────────────────────────────

export type ProgramType = 'airline' | 'hotel' | 'other' | 'airline_elite_status' | 'hotel_elite_status' | 'hotel_paid_membership';

export interface Program {
  id: string;
  name: string;
  program_type: ProgramType;
  is_active: number;
  notes: string | null;
  source_url: string | null;
  created_at: string;
}

export interface ProgramInput {
  id?: string;
  name: string;
  program_type: ProgramType;
  notes?: string | null;
  source_url?: string | null;
  is_active?: number;
}

// ─── Benefits ─────────────────────────────────────────────────────────────────
// A benefit belongs to EITHER a card OR a program (exactly one).

export interface Benefit {
  id: number;
  card_id: string | null;
  program_id: string | null;
  title: string;
  description: string | null;
  category: BenefitCategory;
  reset_cadence: ResetCadence;
  uses_per_period: number | null;
  value_usd: number | null;        // per-use dollar value (nullable when unknown / unlimited)
  spend_threshold_usd: number | null;
  expiration_note: string | null;
  expiration_date: string | null;   // YYYY-MM-DD, user-set expiry for time-bound rewards
  reset_years: number | null;       // for one_time benefits: years between resets (4 for Amex/Chase GE, 5 for Citi GE)
  // v1.0.6 additions:
  // prerequisite_benefit_id: if set, this benefit is only shown once the
  //   prerequisite has been marked as achieved (uses_count >= uses_max). Used
  //   to hide AA status tiers until the previous tier is reached, and to
  //   hide AA Loyalty Choice Reward options until their parent tier is
  //   achieved.
  // is_choice_option: 1 when this benefit represents one selectable option of
  //   a Loyalty Choice Reward menu at an AA tier. Choice options stay hidden
  //   unless (a) prerequisite is achieved AND (b) choice_selected = 1.
  // choice_selected: 1 when the user has ticked this specific choice option
  //   as one of the choices they took at that tier.
  prerequisite_benefit_id: number | null;
  is_choice_option: number;         // 0 | 1
  choice_selected: number;          // 0 | 1
  is_active: number;
  sort_order: number;
  source_url: string | null;
  notes: string | null;
  is_user_modified: number;        // 1 if user edited or added — quarterly refresh preserves
  created_at: string;
  updated_at: string;
}

export interface BenefitInput {
  card_id?: string | null;
  program_id?: string | null;
  title: string;
  description?: string | null;
  category: BenefitCategory;
  reset_cadence: ResetCadence;
  uses_per_period?: number | null;
  value_usd?: number | null;
  spend_threshold_usd?: number | null;
  expiration_note?: string | null;
  expiration_date?: string | null;
  reset_years?: number | null;
  // v1.0.6 additions — see Benefit for semantics. When seeding by title, use
  // prerequisite_benefit_title (resolved to prerequisite_benefit_id at seed
  // time) so the seed file stays human-readable and stable across ids.
  prerequisite_benefit_title?: string | null;
  is_choice_option?: number;
  choice_selected?: number;
  sort_order?: number;
  source_url?: string | null;
  notes?: string | null;
  is_active?: number;
}

// ─── Usage log ───────────────────────────────────────────────────────────────

export interface Usage {
  id: number;
  benefit_id: number;
  used_on: string;                 // YYYY-MM-DD
  amount_usd: number | null;
  period_key: string;              // '2026', '2026-H1', '2026-Q3', '2026-07', 'spend', 'one_time'
  notes: string | null;
  created_at: string;
}

export interface UsageInput {
  benefit_id: number;
  used_on: string;
  amount_usd?: number | null;
  notes?: string | null;
}

// ─── Dashboard projection ─────────────────────────────────────────────────────
// One row per benefit-period combo, with used/remaining counters for a given
// reference year.

export interface BenefitProjection {
  benefit: Benefit;
  card_name: string | null;
  program_name: string | null;
  ref_year: number;
  period_key: string;
  period_label: string;            // human label (e.g., "2026 · Q3", "2026")
  uses_max: number | null;         // null for unlimited (per-period cap)
  uses_count: number;              // usages logged in current period
  uses_remaining: number | null;
  value_used_usd: number;          // dollar value used in current period
  value_remaining_usd: number | null;  // dollar value remaining in current period
  // Yearly aggregates (used by dashboard totals). For year-scoped cadences
  // (annual / one_time / spend_threshold / unlimited) these equal the
  // current-period numbers. For quarterly / monthly / semiannual, these
  // aggregate across all periods in ref_year.
  annual_value_usd: number | null;      // total dollar value across the year (null if not measurable)
  annual_value_used_usd: number;        // dollar value logged across the entire year
  annual_value_remaining_usd: number | null;
  // Progress toward a spend threshold (e.g. Hilton $30K free night).
  // Sum of amount_usd across all logged usages in ref_year; null when the
  // benefit does not track spend.
  spend_progress_usd: number | null;
  // Per-period history for the reference year. Each entry represents one
  // completed or current period (Q1..Q4, Jan..Dec, H1/H2, or the year itself).
  // status: 'used' (>=cap or count>=max), 'partial' (some usage), 'unused'
  // (period elapsed or current with no activity yet), 'future' (period has not started).
  period_history: PeriodHistoryEntry[];
  status: 'available' | 'partial' | 'exhausted' | 'unlimited' | 'locked';
  usages: Usage[];                 // for this period only
  next_reset: string | null;       // ISO date when it resets
}

export interface PeriodHistoryEntry {
  period_key: string;              // '2026-Q1', '2026-07', '2026-H1', '2026'
  period_label: string;            // 'Q1', 'Jan', 'H1', '2026'
  value_used_usd: number;          // dollar amount used in that period
  uses_count: number;              // number of usages logged in that period
  status: 'used' | 'partial' | 'unused' | 'future';
}

// ─── Refresh (quarterly diff & review) ─────────────────────────────────────────

export type RefreshChangeType = 'added' | 'modified' | 'removed';
export type RefreshStatus = 'pending' | 'approved' | 'rejected';

export interface RefreshRun {
  id: number;
  started_at: string;
  completed_at: string | null;
  source_notes: string | null;      // e.g., "2026-Q3 refresh — sourced from Amex Aug 2026 T&Cs"
  status: 'draft' | 'applied' | 'discarded';
}

export interface RefreshChange {
  id: number;
  refresh_run_id: number;
  change_type: RefreshChangeType;
  card_id: string | null;
  program_id: string | null;
  benefit_id: number | null;        // null for 'added' until applied
  before_json: string | null;
  after_json: string | null;
  review_status: RefreshStatus;
  review_notes: string | null;
  created_at: string;
}

// ─── File management ─────────────────────────────────────────────────────────

export interface AppFilePayload {
  version: number;
  exported_at: string;
  cards: Card[];
  programs: Program[];
  benefits: Benefit[];
  usages: Usage[];
  refresh_runs: RefreshRun[];
  refresh_changes: RefreshChange[];
}

export interface FileResult {
  success: boolean;
  filePath?: string;
  error?: string;
  payload?: AppFilePayload;
}

// ─── Renderer <-> Main IPC contract ──────────────────────────────────────────

export interface WindowApi {
  cards: {
    getAll: () => Promise<Card[]>;
    getById: (id: string) => Promise<Card | null>;
    create: (data: CardInput) => Promise<Card>;
    update: (id: string, data: Partial<CardInput>) => Promise<Card>;
    delete: (id: string) => Promise<{ ok: true }>;
    setVisible: (id: string, visible: boolean) => Promise<Card>;
  };
  programs: {
    getAll: () => Promise<Program[]>;
    getById: (id: string) => Promise<Program | null>;
    create: (data: ProgramInput) => Promise<Program>;
    update: (id: string, data: Partial<ProgramInput>) => Promise<Program>;
    delete: (id: string) => Promise<{ ok: true }>;
  };
  benefits: {
    getAll: () => Promise<Benefit[]>;
    getForCard: (cardId: string) => Promise<Benefit[]>;
    getForProgram: (programId: string) => Promise<Benefit[]>;
    getById: (id: number) => Promise<Benefit | null>;
    create: (data: BenefitInput) => Promise<Benefit>;
    update: (id: number, data: Partial<BenefitInput>) => Promise<Benefit>;
    delete: (id: number) => Promise<{ ok: true }>;
  };
  usages: {
    getForBenefit: (benefitId: number) => Promise<Usage[]>;
    create: (data: UsageInput) => Promise<Usage>;
    update: (id: number, data: Partial<UsageInput>) => Promise<Usage>;
    delete: (id: number) => Promise<{ ok: true }>;
  };
  projection: {
    all: (refYear?: number) => Promise<BenefitProjection[]>;
  };
  refresh: {
    getStatus: () => Promise<{ last_run_at: string | null; next_due: string; pending_run_id: number | null }>;
    startRun: (sourceNotes: string, changes: Array<Omit<RefreshChange, 'id' | 'refresh_run_id' | 'created_at' | 'review_status' | 'review_notes'>>) =>
      Promise<{ run_id: number }>;
    getPendingChanges: (runId: number) => Promise<RefreshChange[]>;
    approveChange: (changeId: number, notes?: string) => Promise<RefreshChange>;
    rejectChange: (changeId: number, notes?: string) => Promise<RefreshChange>;
    applyRun: (runId: number) => Promise<{ applied: number; skipped: number }>;
    discardRun: (runId: number) => Promise<{ ok: true }>;
  };
  file: {
    currentPath: () => Promise<string>;
    newDb: () => Promise<FileResult>;
    openDb: () => Promise<FileResult>;
    saveAs: () => Promise<FileResult>;
    exportJson: () => Promise<FileResult>;
    importJson: () => Promise<FileResult>;
  };
  app: {
    getVersion: () => Promise<string>;
    showAbout: () => Promise<void>;
  };
}

declare global {
  interface Window {
    api: WindowApi;
  }
}
