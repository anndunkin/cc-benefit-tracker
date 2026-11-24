import Database from 'better-sqlite3';
import path from 'path';
import type {
  Card, CardInput, Program, ProgramInput,
  Benefit, BenefitInput, Usage, UsageInput,
  BenefitProjection, RefreshChange, RefreshRun, RefreshChangeType, RefreshStatusInfo, RefreshUnmatched,
  AppFilePayload, ResetCadence, CardNetwork,
  PointsCurrency, PointsCurrencyInput, CertificateAward,
} from './types';
import { APP_FILE_VERSION } from './types';
import { choiceCost, isDiamondChoices, isMilestone, tracksEarnedNights, valueAtDate } from './benefitRules';
import { ensureRelease20Schema, migrateRelease20 } from './release20';
import { periodKeyFor, periodLabelFor, nextResetIso, uses_max_for } from './periods';
import { SEED_CARDS, SEED_PROGRAMS, SEED_BENEFITS, SEED_POINTS_CURRENCIES } from './benefitsSeed';
import { requireWebLinkOrBlank, safeWebLinkOrNull } from './linkPolicy';
import { certificateYearOffset, isAnnualCertificate, isCertificateDate, isCompanionCertificate, isHyattSpendCertificate, isOmniStayBenefit, OMNI_STAY_NIGHTS } from './certificateRules';
import { localIsoDate } from './expiringCredits';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    const dbPath = path.join(app.getPath('userData'), 'cc-benefit-tracker.db');
    openDatabaseAt(dbPath);
  }
  return db!;
}

export function openDatabaseAt(dbPath: string, options: { mustExist?: boolean } = {}): Database.Database {
  // v1.0.25: open and prepare the new file BEFORE letting go of the current
  // one. If the new file cannot be opened or migrated, the error is thrown and
  // the database that was open stays open and usable.
  // `mustExist` is for a file the user picked: if it has vanished since it was
  // checked, fail rather than quietly create a new, empty tracker in its place.
  const next = new Database(dbPath, { fileMustExist: options.mustExist === true });
  let seeded = false;
  try {
    // SQLite opens a file it cannot write to as read-only without complaint.
    // Find out now, while the previous file is still open.
    // The probe really writes (a table that is immediately rolled back);
    // starting a transaction alone does not reveal a read-only file.
    try {
      next.exec('BEGIN IMMEDIATE');
      try { next.exec('CREATE TABLE cct_write_probe (x)'); }
      finally { next.exec('ROLLBACK'); }
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (code.startsWith('SQLITE_READONLY') || code === 'SQLITE_CANTOPEN') {
        throw new Error(`The file cannot be changed (it or its folder is read-only): ${dbPath}`);
      }
      throw err;
    }
    next.pragma('journal_mode = WAL');
    next.pragma('foreign_keys = ON');
    initSchema(next);
    seeded = seedIfFresh(next);
    applyDataMigrations(next);
  } catch (err) {
    try { next.close(); } catch { /* ignore */ }
    throw err;
  }
  const previous = db;
  db = next;
  lastOpenSeeded = seeded;
  if (previous && previous !== next) { try { previous.close(); } catch { /* ignore */ } }
  return db;
}

/**
 * Build a brand-new, fully prepared tracker file at `dbPath` without touching
 * the open database. The result is one complete .db file (v1.0.25, New File).
 */
export function createFreshDatabaseFile(dbPath: string): void {
  const fresh = new Database(dbPath);
  try {
    fresh.pragma('journal_mode = WAL');
    fresh.pragma('foreign_keys = ON');
    initSchema(fresh);
    seedIfFresh(fresh);
    applyDataMigrations(fresh);
    fresh.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    try { fresh.close(); } catch { /* ignore */ }
  }
}

/** Close the open database (used when the app quits). */
export function closeDatabase(): void {
  if (!db) return;
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  db = null;
}

let lastOpenSeeded = false;
/** True when the most recent openDatabaseAt() created and seeded a brand-new database. */
export function lastOpenWasFresh(): boolean { return lastOpenSeeded; }

/** For tests: inject an in-memory database. */
export function setDatabase(testDb: Database.Database): void {
  db = testDb;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const CERTIFICATE_AWARDS_TABLE = `
  CREATE TABLE IF NOT EXISTS certificate_awards (
    source_id INTEGER NOT NULL REFERENCES benefits(id) ON DELETE CASCADE,
    award_id INTEGER NOT NULL UNIQUE REFERENCES benefits(id) ON DELETE CASCADE,
    cycle_year INTEGER NOT NULL CHECK(cycle_year BETWEEN 1000 AND 9999),
    starts_on TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('annual_renewal', 'hyatt_spend', 'omni_stay')),
    CHECK(source_id <> award_id),
    PRIMARY KEY(source_id, kind, cycle_year)
  );
`;

export function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      issuer TEXT NOT NULL,
      network TEXT NOT NULL CHECK(network IN ('Amex','Visa','Mastercard','Other')),
      annual_fee_usd REAL,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_visible INTEGER NOT NULL DEFAULT 1,
      color_hex TEXT,
      notes TEXT,
      source_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      program_type TEXT NOT NULL CHECK(program_type IN ('airline','hotel','other','airline_elite_status','hotel_elite_status','hotel_paid_membership')),
      is_active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      source_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS benefits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
      program_id TEXT REFERENCES programs(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      reset_cadence TEXT NOT NULL CHECK(reset_cadence IN (
        'annual','semiannual','quarterly','monthly','spend_threshold','unlimited','one_time'
      )),
      uses_per_period INTEGER,
      value_usd REAL,
      spend_threshold_usd REAL,
      expiration_note TEXT,
      expiration_date TEXT,
      reset_years INTEGER,
      multiplier_rate REAL,
      multiplier_currency TEXT,
      spend_category TEXT,
      spend_category_note TEXT,
      prerequisite_benefit_id INTEGER REFERENCES benefits(id) ON DELETE SET NULL,
      is_choice_option INTEGER NOT NULL DEFAULT 0,
      choice_selected INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      source_url TEXT,
      notes TEXT,
      is_user_modified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (card_id IS NOT NULL AND program_id IS NULL) OR
        (card_id IS NULL AND program_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_benefits_card    ON benefits(card_id);
    CREATE INDEX IF NOT EXISTS idx_benefits_program ON benefits(program_id);

    ${CERTIFICATE_AWARDS_TABLE}

    CREATE TABLE IF NOT EXISTS usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      benefit_id INTEGER NOT NULL REFERENCES benefits(id) ON DELETE CASCADE,
      used_on TEXT NOT NULL,
      amount_usd REAL,
      period_key TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usages_benefit ON usages(benefit_id);
    CREATE INDEX IF NOT EXISTS idx_usages_period  ON usages(benefit_id, period_key);

    CREATE TABLE IF NOT EXISTS refresh_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      source_notes TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','applied','discarded'))
    );

    CREATE TABLE IF NOT EXISTS refresh_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refresh_run_id INTEGER NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
      change_type TEXT NOT NULL CHECK(change_type IN ('added','modified','removed')),
      card_id TEXT,
      program_id TEXT,
      benefit_id INTEGER,
      points_currency_id TEXT,
      before_json TEXT,
      after_json TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
      review_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      overwrite_user_edit INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS points_currencies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency_type TEXT NOT NULL CHECK(currency_type IN ('transferable','airline','hotel')),
      value_cents_per_point REAL NOT NULL,
      source_name TEXT NOT NULL DEFAULT 'One Mile at a Time',
      source_url TEXT,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_user_modified INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  ensureRelease20Schema(database);
  ensureRefreshSchema(database);
  const awardsTable = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'certificate_awards'").get() as { sql: string };
  if (!awardsTable.sql.includes("'omni_stay'")) {
    database.transaction(() => {
      database.exec(`ALTER TABLE certificate_awards RENAME TO certificate_awards_previous;
        ${CERTIFICATE_AWARDS_TABLE}
        INSERT INTO certificate_awards (source_id, award_id, cycle_year, starts_on, kind)
          SELECT source_id, award_id, cycle_year, starts_on, kind FROM certificate_awards_previous;
        DROP TABLE certificate_awards_previous;`);
    }).immediate();
  }
}

/**
 * v1.0.24 additive upgrade for databases created by an older version:
 * refresh_changes gains points_currency_id (also added by the v1.0.16
 * migration) and overwrite_user_edit. Safe to run repeatedly.
 */
export function ensureRefreshSchema(database: Database.Database): void {
  const cols = database.prepare(`PRAGMA table_info(refresh_changes)`).all() as { name: string }[];
  if (cols.length === 0) return;   // table not created yet
  if (!cols.some(c => c.name === 'points_currency_id')) {
    database.exec(`ALTER TABLE refresh_changes ADD COLUMN points_currency_id TEXT`);
  }
  if (!cols.some(c => c.name === 'overwrite_user_edit')) {
    database.exec(`ALTER TABLE refresh_changes ADD COLUMN overwrite_user_edit INTEGER NOT NULL DEFAULT 0`);
  }
}

export function metaGet(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function metaSet(database: Database.Database, key: string, value: string): void {
  database.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/**
 * Parse a dotted-numeric version string (e.g. "1.0.9") into a tuple. Any
 * non-numeric segment sorts as 0 so malformed values don't crash — they just
 * behave as older than any valid version and get all migrations applied.
 */
function parseVersion(v: string | null | undefined): number[] {
  if (!v) return [0, 0, 0];
  return v.split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * Returns true if the stored seed_version is strictly less than `target`.
 * Migrations should be gated on `seedVersionLt(db, 'X.Y.Z')` so they run
 * once per install and never re-run after `seed_version` has advanced past
 * their target. The historical `!==` check re-ran migrations on every
 * startup and clobbered user edits (v1.0.10 fix).
 */
function seedVersionLt(database: Database.Database, target: string): boolean {
  const current = parseVersion(metaGet(database, 'seed_version'));
  const tgt = parseVersion(target);
  const len = Math.max(current.length, tgt.length);
  for (let i = 0; i < len; i++) {
    const a = current[i] ?? 0;
    const b = tgt[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

// v1.0.12: seedIfFresh currently stamps the newest version. Any per-version
// data migration lives in applyDataMigrations below.
export function seedIfFresh(database: Database.Database): boolean {
  // v1.0.25: a file is "fresh" only if it has never been seeded and holds
  // nothing. Counting cards alone treated a file whose cards had all been
  // deleted as new, and reseeding it then failed on the programs still there,
  // which left the file impossible to open.
  if (metaGet(database, 'seed_version') !== null) return false;
  for (const table of ['cards', 'programs', 'benefits', 'points_currencies']) {
    const n = (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    if (n > 0) return false;
  }

  const insertCard = database.prepare(`
    INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active, color_hex, notes, source_url)
    VALUES (@id, @name, @issuer, @network, @annual_fee_usd, 1, @color_hex, @notes, @source_url)
  `);
  const insertProgram = database.prepare(`
    INSERT INTO programs (id, name, program_type, is_active, notes, source_url)
    VALUES (@id, @name, @program_type, 1, @notes, @source_url)
  `);
  const insertBenefit = database.prepare(`
    INSERT INTO benefits (
      card_id, program_id, title, description, category, reset_cadence, uses_per_period,
      value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
      multiplier_rate, multiplier_currency, spend_category, spend_category_note,
      is_choice_option, sort_order, source_url, notes, previous_value_usd, value_effective_date
    ) VALUES (
      @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
      @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
      @multiplier_rate, @multiplier_currency, @spend_category, @spend_category_note,
      @is_choice_option, @sort_order, @source_url, @notes, @previous_value_usd, @value_effective_date
    )
  `);
  const insertPointsCurrency = database.prepare(`
    INSERT INTO points_currencies (id, name, currency_type, value_cents_per_point, source_name, source_url, notes, is_active)
    VALUES (@id, @name, @currency_type, @value_cents_per_point, @source_name, @source_url, @notes, 1)
  `);

  const tx = database.transaction(() => {
    for (const c of SEED_CARDS) insertCard.run({
      id: c.id,
      name: c.name,
      issuer: c.issuer,
      network: c.network,
      annual_fee_usd: c.annual_fee_usd ?? null,
      color_hex: (c as any).color_hex ?? null,
      notes: (c as any).notes ?? null,
      source_url: (c as any).source_url ?? null,
    });
    for (const p of SEED_PROGRAMS) insertProgram.run({
      id: p.id,
      name: p.name,
      program_type: p.program_type,
      notes: (p as any).notes ?? null,
      source_url: (p as any).source_url ?? null,
    });
    for (const b of SEED_BENEFITS) insertBenefit.run({
      previous_value_usd: b.previous_value_usd ?? null,
      value_effective_date: b.value_effective_date ?? null,
      card_id: b.card_id ?? null,
      program_id: b.program_id ?? null,
      description: b.description ?? null,
      uses_per_period: b.uses_per_period ?? null,
      value_usd: b.value_usd ?? null,
      spend_threshold_usd: b.spend_threshold_usd ?? null,
      expiration_note: b.expiration_note ?? null,
      expiration_date: (b as any).expiration_date ?? null,
      reset_years: (b as any).reset_years ?? null,
      multiplier_rate: b.multiplier_rate ?? null,
      multiplier_currency: b.multiplier_currency ?? null,
      spend_category: b.spend_category ?? null,
      spend_category_note: b.spend_category_note ?? null,
      is_choice_option: (b as any).is_choice_option ?? 0,
      sort_order: b.sort_order ?? 0,
      source_url: b.source_url ?? null,
      notes: b.notes ?? null,
      title: b.title,
      category: b.category,
      reset_cadence: b.reset_cadence,
    });
    for (const pc of SEED_POINTS_CURRENCIES) insertPointsCurrency.run({
      id: pc.id,
      name: pc.name,
      currency_type: pc.currency_type,
      value_cents_per_point: pc.value_cents_per_point,
      source_name: pc.source_name ?? 'One Mile at a Time',
      source_url: pc.source_url ?? null,
      notes: pc.notes ?? null,
    });

    // Resolve prerequisite_benefit_title → prerequisite_benefit_id for fresh DBs.
    const findRow = database.prepare('SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?');
    const updateFk = database.prepare('UPDATE benefits SET prerequisite_benefit_id = ? WHERE id = ?');
    for (const b of SEED_BENEFITS) {
      const parentTitle = (b as any).prerequisite_benefit_title as string | undefined;
      if (!parentTitle) continue;
      const child = findRow.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
      const parent = findRow.get(b.card_id ?? null, b.program_id ?? null, parentTitle) as { id: number } | undefined;
      if (child && parent) updateFk.run(parent.id, child.id);
    }
  });
  tx();

  metaSet(database, 'seed_version', '1.0.16');
  metaSet(database, 'last_refresh_check', new Date().toISOString());
  metaSet(database, 'installed_at', new Date().toISOString());
  return true;
}

export function applyDataMigrations(database: Database.Database): { migrations_run: string[] } {
  ensureRelease20Schema(database);
  ensureRefreshSchema(database);
  const run: string[] = [];
  // v1.0.0 — schema is initial; no data migrations needed.
  if (!metaGet(database, 'schema_version')) {
    metaSet(database, 'schema_version', '1.0.0');
    run.push('init_schema_version_1_0_0');
  }

  // v1.0.3 seed refresh: purge deprecated Marriott cards and UPSERT every
  // seeded benefit by (card_id, title) so installed DBs (v1.0.0/v1.0.1/v1.0.2)
  // pick up value/cadence/uses_per_period corrections without touching user
  // usages. v1.0.2 shipped with the same seed data as v1.0.1 but the migration
  // itself was missing — v1.0.3 both writes the correct seed and installs the
  // migration path so existing DBs converge.
  // v1.0.10 fix: guards below use seedVersionLt so each migration runs at
  // most once. The historical `!==` pattern re-ran the entire chain on every
  // startup, silently wiping user edits (bug #5 in the v1.0.10 fix set).
  if (seedVersionLt(database, '1.0.3')) {
    const tx = database.transaction(() => {
      // 1) Purge deprecated Marriott card ids. FKs cascade to benefits and usages.
      const deprecatedIds = ['marriott_bonvoy_brilliant', 'marriott_bonvoy_boundless', 'marriott_bonvoy_bevy'];
      const delCard = database.prepare('DELETE FROM cards WHERE id = ?');
      let purged = 0;
      for (const id of deprecatedIds) {
        const r = delCard.run(id);
        purged += r.changes;
      }
      if (purged > 0) run.push(`v1_0_3_purged_${purged}_marriott_cards`);

      // 2) Ensure every seeded card and program exists (adds marriott_business/premier
      //    if missing, plus any programs referenced by seeded benefits).
      const insertCard = database.prepare(`
        INSERT OR IGNORE INTO cards (id, name, issuer, network, annual_fee_usd, is_active, color_hex, notes, source_url)
        VALUES (@id, @name, @issuer, @network, @annual_fee_usd, 1, @color_hex, @notes, @source_url)
      `);
      for (const c of SEED_CARDS) insertCard.run({
        id: c.id,
        name: c.name,
        issuer: c.issuer,
        network: c.network,
        annual_fee_usd: c.annual_fee_usd ?? null,
        color_hex: (c as any).color_hex ?? null,
        notes: (c as any).notes ?? null,
        source_url: (c as any).source_url ?? null,
      });
      const insertProgram = database.prepare(`
        INSERT OR IGNORE INTO programs (id, name, program_type, is_active, notes, source_url)
        VALUES (@id, @name, @program_type, 1, @notes, @source_url)
      `);
      for (const p of SEED_PROGRAMS) insertProgram.run({
        id: p.id,
        name: p.name,
        program_type: p.program_type,
        notes: (p as any).notes ?? null,
        source_url: (p as any).source_url ?? null,
      });

      // 3) UPSERT seeded benefits by (card_id, title). Preserves benefit.id (usages FK).
      const findBenefit = database.prepare(`
        SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?
      `);
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @sort_order, @source_url, @notes
        )
      `);
      let updated = 0, inserted = 0;
      for (const b of SEED_BENEFITS) {
        // Only reseed for cards/programs that still exist (skip if user deleted the parent).
        if (b.card_id) {
          const cardExists = database.prepare('SELECT 1 FROM cards WHERE id = ?').get(b.card_id);
          if (!cardExists) continue;
        }
        if (b.program_id) {
          const progExists = database.prepare('SELECT 1 FROM programs WHERE id = ?').get(b.program_id);
          if (!progExists) continue;
        }
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        const params = {
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        };
        if (existing) {
          updateBenefit.run({ ...params, id: existing.id });
          updated++;
        } else {
          insertBenefit.run(params);
          inserted++;
        }
      }
      if (updated > 0) run.push(`v1_0_3_upserted_${updated}_benefits`);
      if (inserted > 0) run.push(`v1_0_3_inserted_${inserted}_benefits`);

      metaSet(database, 'seed_version', '1.0.3');
      run.push('v1_0_3_seed_refresh');
    });
    tx();
  }

  // v1.0.4 — add is_visible + expiration_date columns for existing DBs; purge
  // marriott_premier (closed to new applicants; user does not have it); re-run
  // the brilliant/boundless/bevy purge idempotently; refresh seed with the
  // v1.0.4 corrections (Global Entry $120 single-use, Priority Pass unlimited,
  // President's Circle unlimited, Global Lounge unlimited, Companion Certificate
  // $0, Virgin Atlantic card renamed). Also re-title Virgin Atlantic in cards.
  if (seedVersionLt(database, '1.0.4')) {
    const tx = database.transaction(() => {
      // 1) Add columns on existing DBs (idempotent via PRAGMA table_info).
      const cardCols = database.prepare("PRAGMA table_info('cards')").all() as Array<{ name: string }>;
      if (!cardCols.some((c) => c.name === 'is_visible')) {
        database.exec("ALTER TABLE cards ADD COLUMN is_visible INTEGER NOT NULL DEFAULT 1");
        run.push('v1_0_4_added_cards_is_visible');
      }
      const benCols = database.prepare("PRAGMA table_info('benefits')").all() as Array<{ name: string }>;
      if (!benCols.some((c) => c.name === 'expiration_date')) {
        database.exec("ALTER TABLE benefits ADD COLUMN expiration_date TEXT");
        run.push('v1_0_4_added_benefits_expiration_date');
      }

      // 2) Purge cards the user does not have. FKs cascade to benefits and usages.
      // (Note: marriott_premier was purged in v1.0.4 by mistake; v1.0.5 restores it.)
      const purgeIds = ['marriott_bonvoy_brilliant', 'marriott_bonvoy_boundless', 'marriott_bonvoy_bevy'];
      const delCard = database.prepare('DELETE FROM cards WHERE id = ?');
      let purged = 0;
      for (const id of purgeIds) {
        const r = delCard.run(id);
        purged += r.changes;
      }
      if (purged > 0) run.push(`v1_0_4_purged_${purged}_deprecated_cards`);

      // 3) Rename Virgin Atlantic card if present under legacy name.
      const vaRename = database.prepare("UPDATE cards SET name = 'Virgin Atlantic Credit Card' WHERE id = 'virgin_atlantic' AND name != 'Virgin Atlantic Credit Card'").run();
      if (vaRename.changes > 0) run.push('v1_0_4_renamed_virgin_atlantic');

      // 4) Ensure every currently-seeded card exists (INSERT OR IGNORE), then
      //    UPSERT every seeded benefit by (card_id, program_id, title) so the
      //    v1.0.4 corrections land in existing DBs (Global Entry, Priority Pass,
      //    President's Circle, Global Lounge, Companion Certificate, etc.).
      const insertCard = database.prepare(`
        INSERT OR IGNORE INTO cards (id, name, issuer, network, annual_fee_usd, is_active, is_visible, color_hex, notes, source_url)
        VALUES (@id, @name, @issuer, @network, @annual_fee_usd, 1, 1, @color_hex, @notes, @source_url)
      `);
      for (const c of SEED_CARDS) insertCard.run({
        id: c.id,
        name: c.name,
        issuer: c.issuer,
        network: c.network,
        annual_fee_usd: c.annual_fee_usd ?? null,
        color_hex: (c as any).color_hex ?? null,
        notes: (c as any).notes ?? null,
        source_url: (c as any).source_url ?? null,
      });
      const insertProgram = database.prepare(`
        INSERT OR IGNORE INTO programs (id, name, program_type, is_active, notes, source_url)
        VALUES (@id, @name, @program_type, 1, @notes, @source_url)
      `);
      for (const p of SEED_PROGRAMS) insertProgram.run({
        id: p.id,
        name: p.name,
        program_type: p.program_type,
        notes: (p as any).notes ?? null,
        source_url: (p as any).source_url ?? null,
      });

      const findBenefit = database.prepare(`
        SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?
      `);
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @sort_order, @source_url, @notes
        )
      `);
      let updated = 0, inserted = 0;
      for (const b of SEED_BENEFITS) {
        if (b.card_id) {
          const cardExists = database.prepare('SELECT 1 FROM cards WHERE id = ?').get(b.card_id);
          if (!cardExists) continue;
        }
        if (b.program_id) {
          const progExists = database.prepare('SELECT 1 FROM programs WHERE id = ?').get(b.program_id);
          if (!progExists) continue;
        }
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        const params = {
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        };
        if (existing) {
          updateBenefit.run({ ...params, id: existing.id });
          updated++;
        } else {
          insertBenefit.run(params);
          inserted++;
        }
      }
      if (updated > 0) run.push(`v1_0_4_upserted_${updated}_benefits`);
      if (inserted > 0) run.push(`v1_0_4_inserted_${inserted}_benefits`);

      metaSet(database, 'seed_version', '1.0.4');
      run.push('v1_0_4_seed_refresh');
    });
    tx();
  }

  // v1.0.5 — restore Marriott Rewards Premier Visa (user does have it; removed
  // in v1.0.4 by mistake); add reset_years column for one_time benefits with
  // multi-year reset windows (Global Entry: 4yr Amex/Chase, 5yr Citi); delete
  // the citi_prestige 'Closed to New Applicants' informational tile; refresh
  // seed so AA Executive Global Entry moves to a 5-year reset window.
  if (seedVersionLt(database, '1.0.5')) {
    const tx = database.transaction(() => {
      // 1) Add reset_years column (idempotent).
      const benCols = database.prepare("PRAGMA table_info('benefits')").all() as Array<{ name: string }>;
      if (!benCols.some((c) => c.name === 'reset_years')) {
        database.exec("ALTER TABLE benefits ADD COLUMN reset_years INTEGER");
        run.push('v1_0_5_added_benefits_reset_years');
      }

      // 2) Delete the citi_prestige 'Closed to New Applicants' informational tile.
      const delCloseTile = database.prepare(
        "DELETE FROM benefits WHERE card_id = 'citi_prestige' AND title = 'Closed to New Applicants (existing benefits retained)'"
      ).run();
      if (delCloseTile.changes > 0) run.push('v1_0_5_removed_prestige_closed_tile');

      // 3) Re-insert marriott_premier card if missing, then UPSERT every seeded
      //    benefit so reset_years lands + AA Exec becomes 5yr + marriott_premier
      //    benefit rows reappear.
      const insertCard = database.prepare(`
        INSERT OR IGNORE INTO cards (id, name, issuer, network, annual_fee_usd, is_active, is_visible, color_hex, notes, source_url)
        VALUES (@id, @name, @issuer, @network, @annual_fee_usd, 1, 1, @color_hex, @notes, @source_url)
      `);
      for (const c of SEED_CARDS) insertCard.run({
        id: c.id,
        name: c.name,
        issuer: c.issuer,
        network: c.network,
        annual_fee_usd: c.annual_fee_usd ?? null,
        color_hex: (c as any).color_hex ?? null,
        notes: (c as any).notes ?? null,
        source_url: (c as any).source_url ?? null,
      });
      const insertProgram = database.prepare(`
        INSERT OR IGNORE INTO programs (id, name, program_type, is_active, notes, source_url)
        VALUES (@id, @name, @program_type, 1, @notes, @source_url)
      `);
      for (const p of SEED_PROGRAMS) insertProgram.run({
        id: p.id,
        name: p.name,
        program_type: p.program_type,
        notes: (p as any).notes ?? null,
        source_url: (p as any).source_url ?? null,
      });

      const findBenefit = database.prepare(`
        SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?
      `);
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          reset_years = @reset_years,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, reset_years, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @reset_years, @sort_order, @source_url, @notes
        )
      `);
      let updated = 0, inserted = 0;
      for (const b of SEED_BENEFITS) {
        if (b.card_id) {
          const cardExists = database.prepare('SELECT 1 FROM cards WHERE id = ?').get(b.card_id);
          if (!cardExists) continue;
        }
        if (b.program_id) {
          const progExists = database.prepare('SELECT 1 FROM programs WHERE id = ?').get(b.program_id);
          if (!progExists) continue;
        }
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        const params = {
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          reset_years: (b as any).reset_years ?? null,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        };
        if (existing) {
          updateBenefit.run({ ...params, id: existing.id });
          updated++;
        } else {
          insertBenefit.run(params);
          inserted++;
        }
      }
      if (updated > 0) run.push(`v1_0_5_upserted_${updated}_benefits`);
      if (inserted > 0) run.push(`v1_0_5_inserted_${inserted}_benefits`);

      metaSet(database, 'seed_version', '1.0.5');
      run.push('v1_0_5_seed_refresh');
    });
    tx();
  }

  // v1.0.6 — add prerequisite_benefit_id / is_choice_option / choice_selected
  // columns to existing DBs; delete legacy Virgin Atlantic duplicates and any
  // BofA legacy rows still lingering from v1.0.0; UPSERT every seed benefit
  // (which now includes the AA prereq/choice-split rewrite plus the two new
  // Amex Plat + Delta Reserve $75k spend unlocks); resolve prerequisite_benefit_title
  // → prerequisite_benefit_id by title lookup.
  if (seedVersionLt(database, '1.0.6')) {
    const tx = database.transaction(() => {
      // 1) Add prerequisite/choice columns idempotently.
      const benCols = database.prepare("PRAGMA table_info('benefits')").all() as Array<{ name: string }>;
      if (!benCols.some((c) => c.name === 'prerequisite_benefit_id')) {
        database.exec('ALTER TABLE benefits ADD COLUMN prerequisite_benefit_id INTEGER REFERENCES benefits(id) ON DELETE SET NULL');
        run.push('v1_0_6_added_prerequisite_benefit_id');
      }
      if (!benCols.some((c) => c.name === 'is_choice_option')) {
        database.exec('ALTER TABLE benefits ADD COLUMN is_choice_option INTEGER NOT NULL DEFAULT 0');
        run.push('v1_0_6_added_is_choice_option');
      }
      if (!benCols.some((c) => c.name === 'choice_selected')) {
        database.exec('ALTER TABLE benefits ADD COLUMN choice_selected INTEGER NOT NULL DEFAULT 0');
        run.push('v1_0_6_added_choice_selected');
      }

      // 2) Delete legacy duplicate / removed benefit rows by title (items #8, #9, #10).
      //    Virgin Atlantic duplicates: legacy titles missing the newer suffixes.
      const delQueries: Array<{ title: string; cardId: string | null }> = [
        // #8: legacy "Tier Points on Spend" (superseded by "($1,500 per £5,000…)" title)
        { title: 'Tier Points on Spend', cardId: 'ba_visa' },
        // #9: legacy "2,500 Virgin Points per Authorized User" (superseded by "(up to 4 users)")
        { title: '2,500 Virgin Points per Authorized User', cardId: 'virgin_atlantic' },
        // #10: any remaining BofA legacy rows
        { title: '[LEGACY BofA card] 7,500 bonus miles at $15,000 spend', cardId: null },
        { title: '[LEGACY BofA card] Companion award ticket at $25,000 spend', cardId: null },
      ];
      let deletedLegacy = 0;
      const delByTitle = database.prepare('DELETE FROM benefits WHERE title = ? AND (? IS NULL OR card_id = ?)');
      for (const q of delQueries) {
        const r = delByTitle.run(q.title, q.cardId, q.cardId);
        deletedLegacy += r.changes;
      }
      // Also delete any row whose title starts with the legacy BofA marker.
      const delLegacyPrefix = database.prepare("DELETE FROM benefits WHERE title LIKE '[LEGACY BofA card]%'").run();
      deletedLegacy += delLegacyPrefix.changes;
      if (deletedLegacy > 0) run.push(`v1_0_6_deleted_${deletedLegacy}_legacy_benefits`);

      // 3) UPSERT all seed cards + programs first (in case new ones were added).
      const insertCard = database.prepare(`
        INSERT OR IGNORE INTO cards (id, name, issuer, network, annual_fee_usd, is_active, is_visible, color_hex, notes, source_url)
        VALUES (@id, @name, @issuer, @network, @annual_fee_usd, 1, 1, @color_hex, @notes, @source_url)
      `);
      for (const c of SEED_CARDS) insertCard.run({
        id: c.id,
        name: c.name,
        issuer: c.issuer,
        network: c.network,
        annual_fee_usd: c.annual_fee_usd ?? null,
        color_hex: (c as any).color_hex ?? null,
        notes: (c as any).notes ?? null,
        source_url: (c as any).source_url ?? null,
      });
      const insertProgram = database.prepare(`
        INSERT OR IGNORE INTO programs (id, name, program_type, is_active, notes, source_url)
        VALUES (@id, @name, @program_type, 1, @notes, @source_url)
      `);
      for (const p of SEED_PROGRAMS) insertProgram.run({
        id: p.id,
        name: p.name,
        program_type: p.program_type,
        notes: (p as any).notes ?? null,
        source_url: (p as any).source_url ?? null,
      });

      // 4) UPSERT every seed benefit — update writable columns including the new
      //    is_choice_option flag (choice_selected is intentionally NOT overwritten
      //    so the user's manual selections survive re-seed).
      const findBenefit = database.prepare(`
        SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?
      `);
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          reset_years = @reset_years,
          is_choice_option = @is_choice_option,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, reset_years, is_choice_option,
          sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @reset_years, @is_choice_option,
          @sort_order, @source_url, @notes
        )
      `);
      let updated = 0, inserted = 0;
      for (const b of SEED_BENEFITS) {
        if (b.card_id) {
          const cardExists = database.prepare('SELECT 1 FROM cards WHERE id = ?').get(b.card_id);
          if (!cardExists) continue;
        }
        if (b.program_id) {
          const progExists = database.prepare('SELECT 1 FROM programs WHERE id = ?').get(b.program_id);
          if (!progExists) continue;
        }
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        const params = {
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        };
        if (existing) {
          updateBenefit.run({ ...params, id: existing.id });
          updated++;
        } else {
          insertBenefit.run(params);
          inserted++;
        }
      }
      if (updated > 0) run.push(`v1_0_6_upserted_${updated}_benefits`);
      if (inserted > 0) run.push(`v1_0_6_inserted_${inserted}_benefits`);

      // 5) Resolve prerequisite_benefit_title → prerequisite_benefit_id.
      //    For every seed benefit that declares prerequisite_benefit_title,
      //    find its DB row (matching by card/program + title) AND the parent
      //    (same card/program, matching title) and wire the FK. This runs
      //    every v1.0.6 seed so it self-heals if titles change.
      const findRow = database.prepare(`
        SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?
      `);
      const updateFk = database.prepare(`UPDATE benefits SET prerequisite_benefit_id = ? WHERE id = ?`);
      let linked = 0;
      for (const b of SEED_BENEFITS) {
        const parentTitle = (b as any).prerequisite_benefit_title as string | undefined;
        if (!parentTitle) continue;
        const child = findRow.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        const parent = findRow.get(b.card_id ?? null, b.program_id ?? null, parentTitle) as { id: number } | undefined;
        if (child && parent) {
          updateFk.run(parent.id, child.id);
          linked++;
        }
      }
      if (linked > 0) run.push(`v1_0_6_linked_${linked}_prerequisites`);

      metaSet(database, 'seed_version', '1.0.6');
      run.push('v1_0_6_seed_refresh');
    });
    tx();
  }

  // v1.0.7 — clean up rows that v1.0.6's UPSERT couldn't reach: (a) the
  // aa_status "Admirals Club Access" reference row (removed from the v1.0.6
  // seed but still lingering in existing DBs), and (b) the virgin_atlantic
  // "Tier Points on Spend" no-suffix legacy row (v1.0.6 tried to delete it but
  // used the wrong card_id 'ba_visa'). Then re-UPSERT all seed benefits so the
  // IHG anniversary night, IHG Platinum Elite Status, and any other seed value
  // changes flow into existing databases.
  if (seedVersionLt(database, '1.0.7')) {
    const tx = database.transaction(() => {
      // Delete orphaned / mis-targeted legacy rows.
      const delRows: Array<{ title: string; cardId: string | null; programId: string | null }> = [
        // Orphaned AA program reference row (dropped from v1.0.6 seed).
        { title: 'Admirals Club Access', cardId: null, programId: 'aa_status' },
        // Legacy Virgin Atlantic "Tier Points on Spend" (no suffix) — v1.0.6 targeted 'ba_visa' by mistake.
        { title: 'Tier Points on Spend', cardId: 'virgin_atlantic', programId: null },
      ];
      const delStmt = database.prepare(
        'DELETE FROM benefits WHERE title = ? AND card_id IS ? AND program_id IS ?'
      );
      let deleted = 0;
      for (const r of delRows) {
        const res = delStmt.run(r.title, r.cardId, r.programId);
        deleted += res.changes;
      }
      if (deleted > 0) run.push(`v1_0_7_deleted_${deleted}_legacy_benefits`);

      // Re-UPSERT every seed benefit so v1.0.7 seed value edits reach existing
      // DBs (IHG anniversary night value_usd → 0, IHG Platinum Elite → unlimited).
      const findBenefit = database.prepare(
        'SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?'
      );
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          reset_years = @reset_years,
          is_choice_option = @is_choice_option,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      let updated = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        if (!existing) continue;
        updateBenefit.run({
          id: existing.id,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        });
        updated++;
      }
      if (updated > 0) run.push(`v1_0_7_upserted_${updated}_benefits`);

      metaSet(database, 'seed_version', '1.0.7');
      run.push('v1_0_7_seed_refresh');
    });
    tx();
  }

  // v1.0.8 — (a) merge Amex Platinum "Unlimited Delta Sky Club Access after
  // $75,000 Spend" and "Complimentary Centurion Lounge Guest Access after
  // $75,000 Spend" into a single combined benefit (preserving usage history
  // via a title rename + delete of the duplicate); (b) delete legacy em-dash
  // AA Loyalty Point tier rows that were left behind when v1.0.6 rewrote the
  // seed with plain hyphens; (c) delete obsolete AA LP levels 550K/750K/1M/
  // 3M/5M that were removed from the v1.0.6 seed; (d) re-UPSERT the seed so
  // renamed and re-scoped benefits (e.g. the combined Amex Platinum benefit)
  // pick up their new descriptions/expiration notes.
  if (seedVersionLt(database, '1.0.8')) {
    const tx = database.transaction(() => {
      // (a) Combined Amex Platinum lounge benefit.
      // Rename the existing Sky Club row (preserves usages + spend progress).
      const renamed = database.prepare(`
        UPDATE benefits SET title = ?
        WHERE card_id = 'amex_platinum'
          AND title = 'Unlimited Delta Sky Club Access after $75,000 Spend'
      `).run('Unlimited Delta Sky Club + Centurion Guest Access after $75,000 Spend');
      if (renamed.changes > 0) run.push(`v1_0_8_renamed_${renamed.changes}_amex_lounge`);
      // Move any usages/spend from the standalone Centurion guest row into the
      // merged row so nothing is lost, then delete the duplicate.
      const centurionRow = database.prepare(`
        SELECT id FROM benefits WHERE card_id = 'amex_platinum'
          AND title = 'Complimentary Centurion Lounge Guest Access after $75,000 Spend'
      `).get() as { id: number } | undefined;
      const mergedRow = database.prepare(`
        SELECT id FROM benefits WHERE card_id = 'amex_platinum'
          AND title = 'Unlimited Delta Sky Club + Centurion Guest Access after $75,000 Spend'
      `).get() as { id: number } | undefined;
      if (centurionRow && mergedRow) {
        const moved = database.prepare('UPDATE usages SET benefit_id = ? WHERE benefit_id = ?').run(mergedRow.id, centurionRow.id);
        if (moved.changes > 0) run.push(`v1_0_8_migrated_${moved.changes}_centurion_usages`);
      }
      if (centurionRow) {
        database.prepare('DELETE FROM benefits WHERE id = ?').run(centurionRow.id);
        run.push('v1_0_8_deleted_standalone_centurion_row');
      }

      // (b) Delete legacy em-dash AA LP tier rows that survived the v1.0.6
      // rewrite. Migrate any usages back onto the current hyphen-titled tier.
      const emDashPairs: Array<{ oldTitle: string; newTitle: string | null }> = [
        // Preserve history for tiers still present in the current seed.
        { oldTitle: '60,000 Loyalty Points — AAdvantage Gold', newTitle: '60,000 Loyalty Points - AAdvantage Gold' },
        { oldTitle: '100,000 Loyalty Points — AAdvantage Platinum', newTitle: '100,000 Loyalty Points - AAdvantage Platinum' },
        { oldTitle: '175,000 Loyalty Points — Platinum Pro + 1 Loyalty Choice Reward', newTitle: '175,000 Loyalty Points - Platinum Pro + 1 Loyalty Choice Reward' },
        { oldTitle: '250,000 Loyalty Points — Executive Platinum + 2 Loyalty Choice Rewards', newTitle: '250,000 Loyalty Points - Executive Platinum + 2 Loyalty Choice Rewards' },
        { oldTitle: '400,000 Loyalty Points — 2 Loyalty Choice Rewards', newTitle: '400,000 Loyalty Points - 2 Loyalty Choice Rewards' },
        // Tiers dropped in v1.0.6 seed — delete outright (no new home).
        { oldTitle: '550,000 Loyalty Points — 2 Loyalty Choice Rewards', newTitle: null },
        { oldTitle: '750,000 Loyalty Points — 2 Loyalty Choice Rewards', newTitle: null },
        { oldTitle: '1,000,000 Loyalty Points — 1 Loyalty Choice Reward', newTitle: null },
        { oldTitle: '3,000,000 Loyalty Points — 1 Loyalty Choice Reward', newTitle: null },
        { oldTitle: '5,000,000 Loyalty Points — 1 Loyalty Choice Reward', newTitle: null },
      ];
      let migratedUsages = 0;
      let deletedTiers = 0;
      for (const { oldTitle, newTitle } of emDashPairs) {
        const oldRow = database.prepare(`
          SELECT id FROM benefits WHERE card_id IS NULL AND program_id = 'aa_status' AND title = ?
        `).get(oldTitle) as { id: number } | undefined;
        if (!oldRow) continue;
        if (newTitle) {
          const newRow = database.prepare(`
            SELECT id FROM benefits WHERE card_id IS NULL AND program_id = 'aa_status' AND title = ?
          `).get(newTitle) as { id: number } | undefined;
          if (newRow) {
            const m = database.prepare('UPDATE usages SET benefit_id = ? WHERE benefit_id = ?').run(newRow.id, oldRow.id);
            migratedUsages += m.changes;
          }
        }
        database.prepare('DELETE FROM benefits WHERE id = ?').run(oldRow.id);
        deletedTiers++;
      }
      if (migratedUsages > 0) run.push(`v1_0_8_migrated_${migratedUsages}_lp_usages`);
      if (deletedTiers > 0) run.push(`v1_0_8_deleted_${deletedTiers}_legacy_lp_tiers`);

      // (c) Also delete the v1.0.0 em-dash "Systemwide Upgrades (Global
      // Upgrades)" row if its cadence disagrees with v1.0.6+. v1.0.6 changed
      // that row's cadence to 'unlimited' via UPSERT so the title match should
      // have updated it; but if any stragglers exist under a slightly
      // different title, they'd be caught only manually. Nothing to do here
      // beyond what UPSERT already handled.

      // (d) Re-UPSERT every seed benefit so the merged Amex Platinum row
      // (description, expiration_note, notes) applies to existing DBs.
      const findBenefit = database.prepare(
        'SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?'
      );
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          reset_years = @reset_years,
          is_choice_option = @is_choice_option,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      let upserted = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        if (!existing) continue;
        updateBenefit.run({
          id: existing.id,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        });
        upserted++;
      }
      if (upserted > 0) run.push(`v1_0_8_upserted_${upserted}_benefits`);

      metaSet(database, 'seed_version', '1.0.8');
      run.push('v1_0_8_seed_refresh');
    });
    tx();
  }

  // v1.0.9 — (a) rename Amex Venue Collection and Marriott Nightly Upgrade
  // Awards rows so the UPSERT loop can find and update them; (b) belt-and-
  // suspenders delete of the standalone Amex Platinum Centurion row (idem-
  // potent with v1.0.8); (c) migrate legacy Marriott Annual Choice Benefit
  // rows onto the new milestone/choice-option structure, then delete the
  // legacy rows; (d) delete Lifetime Platinum Elite entirely; (e) seed the
  // new Hyatt carry-over free-night rows and Marriott milestone/choice rows;
  // (f) re-UPSERT so value_usd, reset_cadence, expiration_date, description
  // and notes changes propagate to existing DBs.
  if (seedVersionLt(database, '1.0.9')) {
    const tx = database.transaction(() => {
      // (a) Rename rows whose titles changed so title-based UPSERT can find them.
      const renameVenue = database.prepare(`
        UPDATE benefits SET title = ?
        WHERE card_id = 'delta_reserve' AND title = 'American Express Venue Collection'
      `).run('American Express Venue Collection (10% off concessions, up to $250/yr)');
      if (renameVenue.changes > 0) run.push(`v1_0_9_renamed_${renameVenue.changes}_venue_collection`);

      const renameNua = database.prepare(`
        UPDATE benefits SET title = ?
        WHERE program_id = 'marriott_status' AND title = 'Nightly Upgrade Awards (formerly Suite Night Awards)'
      `).run('Nightly Upgrade Awards (10 earned in 2025)');
      if (renameNua.changes > 0) run.push(`v1_0_9_renamed_${renameNua.changes}_nua_row`);

      // (b) Idempotent: delete the standalone Amex Platinum Centurion row if
      // any copy survived the v1.0.8 migration (e.g. re-inserted by a manual
      // refresh flow between versions).
      const stragglerCenturion = database.prepare(`
        DELETE FROM benefits WHERE card_id = 'amex_platinum'
          AND title = 'Complimentary Centurion Lounge Guest Access after $75,000 Spend'
      `).run();
      if (stragglerCenturion.changes > 0) run.push(`v1_0_9_deleted_${stragglerCenturion.changes}_straggler_centurion`);

      // (c) Migrate legacy Marriott Annual Choice Benefit rows. Any usage
      // logged on the old parent rows migrates onto the new milestone row.
      const legacyChoiceTitles = [
        'Annual Choice Benefit at 50 Elite Nights',
        'Annual Choice Benefit at 75 Elite Nights',
      ];
      // Ensure the new milestone rows exist before migrating usages onto them.
      // If they don't yet (fresh v1.0.8 DB), the UPSERT-INSERT pass below
      // creates them; we re-run this migration by looking them up afterwards.
      let choiceUsagesMigrated = 0;
      for (const oldTitle of legacyChoiceTitles) {
        const oldRow = database.prepare(`
          SELECT id FROM benefits WHERE program_id = 'marriott_status' AND title = ?
        `).get(oldTitle) as { id: number } | undefined;
        if (!oldRow) continue;
        const newTitle = oldTitle.startsWith('Annual Choice Benefit at 50')
          ? '50 Elite Nights - Choice Benefit unlocked'
          : '75 Elite Nights - Additional Choice Benefit unlocked';
        // The new row may not exist yet if we haven't inserted it. Defer usage
        // migration until after the INSERT pass by inserting a placeholder
        // now if missing.
        let newRow = database.prepare(`
          SELECT id FROM benefits WHERE program_id = 'marriott_status' AND title = ?
        `).get(newTitle) as { id: number } | undefined;
        if (!newRow) {
          // Rename the old row into the new title. This preserves usage FK.
          database.prepare('UPDATE benefits SET title = ? WHERE id = ?').run(newTitle, oldRow.id);
          run.push(`v1_0_9_renamed_legacy_choice_${oldTitle.slice(0, 20).replace(/[^a-z0-9]/gi, '_')}`);
          continue;
        }
        const moved = database.prepare('UPDATE usages SET benefit_id = ? WHERE benefit_id = ?').run(newRow.id, oldRow.id);
        choiceUsagesMigrated += moved.changes;
        database.prepare('DELETE FROM benefits WHERE id = ?').run(oldRow.id);
      }
      if (choiceUsagesMigrated > 0) run.push(`v1_0_9_migrated_${choiceUsagesMigrated}_choice_usages`);

      // (d) Delete Lifetime Platinum Elite entirely.
      const deletedLifetime = database.prepare(`
        DELETE FROM benefits WHERE program_id = 'marriott_status' AND title = 'Lifetime Platinum Elite'
      `).run();
      if (deletedLifetime.changes > 0) run.push(`v1_0_9_deleted_${deletedLifetime.changes}_lifetime_platinum`);

      // (e) INSERT any seed benefit that isn't in the DB yet (carry-over Hyatt
      // rows, new Marriott milestone + choice-option rows), and (f) UPSERT
      // every existing seed row so value_usd / reset_cadence / expiration_date
      // updates propagate.
      const findBenefit = database.prepare(
        'SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?'
      );
      const updateBenefit = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          expiration_date = @expiration_date,
          reset_years = @reset_years,
          is_choice_option = @is_choice_option,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
          is_choice_option, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
          @is_choice_option, @sort_order, @source_url, @notes
        )
      `);
      // First pass: INSERT missing seed rows so prerequisite-title lookups
      // find them on the second pass.
      let inserted = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        if (existing) continue;
        insertBenefit.run({
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          expiration_date: (b as any).expiration_date ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        });
        inserted++;
      }
      if (inserted > 0) run.push(`v1_0_9_inserted_${inserted}_new_seed_rows`);

      // Second pass: UPSERT existing rows so value_usd / cadence / description
      // updates propagate. Also re-resolve prerequisite_benefit_id for choice-
      // option rows that reference a milestone we just inserted.
      let upserted = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number } | undefined;
        if (!existing) continue;
        updateBenefit.run({
          id: existing.id,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          expiration_date: (b as any).expiration_date ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        });
        upserted++;
      }
      if (upserted > 0) run.push(`v1_0_9_upserted_${upserted}_benefits`);

      // Resolve prerequisite_benefit_id for rows that reference a prerequisite
      // by title in the seed (Marriott choice options + 75-night milestone).
      const resolvePrereq = database.prepare(`
        UPDATE benefits SET prerequisite_benefit_id = (
          SELECT p.id FROM benefits p
          WHERE (p.card_id IS benefits.card_id OR (p.card_id IS NULL AND benefits.card_id IS NULL))
            AND (p.program_id IS benefits.program_id OR (p.program_id IS NULL AND benefits.program_id IS NULL))
            AND p.title = @prereq_title
        )
        WHERE title = @title
          AND (program_id = @program_id OR (program_id IS NULL AND @program_id IS NULL))
          AND (card_id = @card_id OR (card_id IS NULL AND @card_id IS NULL))
      `);
      let prereqLinks = 0;
      for (const b of SEED_BENEFITS) {
        const prereqTitle = (b as any).prerequisite_benefit_title;
        if (!prereqTitle) continue;
        const r = resolvePrereq.run({
          prereq_title: prereqTitle,
          title: b.title,
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
        });
        prereqLinks += r.changes;
      }
      if (prereqLinks > 0) run.push(`v1_0_9_relinked_${prereqLinks}_prereq_ids`);

      metaSet(database, 'seed_version', '1.0.9');
      run.push('v1_0_9_seed_refresh');
    });
    tx();
  }

  // v1.0.10 — cleanup pass:
  //   #1 dedupe Amex Venue Collection on Delta Reserve
  //   #2 delete standalone Delta Reserve Sky Club unlimited row (Platinum row keeps combined benefit)
  //   #3 zero out Virgin Personal Perks / Authorized User value fields
  //   #4 dedupe Marriott 2025 NUA row
  //   #5 (root-cause fix already landed via migration guards)
  //   #6 IHG $100 credit -> value_usd 100
  //   #7 delete IHG Ambassador renewal row
  //   #8 restructure Delta Medallion Choice Benefits as tier gates with option children
  //   #9 seed 12 carried-over Regional Upgrade Certificates from 2026
  //  #10 zero out BA Travel Together value
  if (seedVersionLt(database, '1.0.10')) {
    const tx = database.transaction(() => {
      // Helper: dedupe rows matching a (card_id, program_id, title) filter.
      // Keeps the min(id) row, migrates any usages onto it, deletes the rest.
      const dedupe = (card_id: string | null, program_id: string | null, title: string): number => {
        const rows = database.prepare(
          'SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ? ORDER BY id ASC'
        ).all(card_id, program_id, title) as { id: number }[];
        if (rows.length <= 1) return 0;
        const keep = rows[0].id;
        const drop = rows.slice(1).map(r => r.id);
        const placeholders = drop.map(() => '?').join(',');
        database.prepare(`UPDATE usages SET benefit_id = ? WHERE benefit_id IN (${placeholders})`).run(keep, ...drop);
        database.prepare(`DELETE FROM benefits WHERE id IN (${placeholders})`).run(...drop);
        return drop.length;
      };

      // #1 Dedupe Amex Venue Collection on Delta Reserve.
      const dupVenue = dedupe('delta_reserve', null, 'American Express Venue Collection (10% off concessions, up to $250/yr)');
      if (dupVenue > 0) run.push(`v1_0_10_deduped_${dupVenue}_venue_collection`);

      // #2 Delete standalone Delta Reserve Sky Club unlimited row (Amex Platinum
      // has the combined benefit; Delta Reserve’s row is redundant).
      const delSkyClub = database.prepare(`
        DELETE FROM benefits WHERE card_id = 'delta_reserve'
          AND title = 'Unlimited Delta Sky Club Access after $75,000 Spend'
      `).run();
      if (delSkyClub.changes > 0) run.push(`v1_0_10_deleted_${delSkyClub.changes}_delta_reserve_sky_club`);

      // #4 Dedupe Marriott 2025 NUA row.
      const dupNua = dedupe(null, 'marriott_status', 'Nightly Upgrade Awards (10 earned in 2025)');
      if (dupNua > 0) run.push(`v1_0_10_deduped_${dupNua}_nua_rows`);

      // #3 + #10 Force value_usd = 0 on Virgin Personal Perks / Authorized User /
      // BA Travel Together, regardless of is_user_modified (user explicitly
      // asked to remove these dollar values).
      const zeroValueTitles: { card_id: string; title: string }[] = [
        { card_id: 'virgin_atlantic', title: '1 Personal Perk after $15,000 annual spend' },
        { card_id: 'virgin_atlantic', title: '2nd Personal Perk after $30,000 annual spend' },
        { card_id: 'virgin_atlantic', title: '2,500 Virgin Points per Authorized User (up to 4)' },
        { card_id: 'ba_visa', title: 'Travel Together Ticket after $30,000 spend' },
      ];
      let zeroed = 0;
      for (const t of zeroValueTitles) {
        const r = database.prepare(`
          UPDATE benefits SET value_usd = 0 WHERE card_id = ? AND title = ?
        `).run(t.card_id, t.title);
        zeroed += r.changes;
      }
      if (zeroed > 0) run.push(`v1_0_10_zeroed_${zeroed}_value_fields`);

      // #6 IHG $100 statement credit -> value_usd = 100 (from 150).
      const ihgCredit = database.prepare(`
        UPDATE benefits SET value_usd = 100
        WHERE card_id = 'ihg_premier'
          AND title = '$100 statement credit + 10,000 bonus points after $20,000 spend'
      `).run();
      if (ihgCredit.changes > 0) run.push(`v1_0_10_updated_${ihgCredit.changes}_ihg_credit_value`);

      // #7 Delete IHG Ambassador Renewal row.
      const delAmbassador = database.prepare(`
        DELETE FROM benefits WHERE program_id = 'ihg_ambassador' AND title = 'Membership Cost / Renewal'
      `).run();
      if (delAmbassador.changes > 0) run.push(`v1_0_10_deleted_${delAmbassador.changes}_ihg_ambassador_renewal`);

      // #8 Migrate legacy standalone Delta Global / Regional upgrade certificate
      // rows onto the new Diamond Choice option children so any user usages
      // survive.  Same technique used for the Marriott choice migration.
      const legacyDeltaMap: { oldTitle: string; newTitle: string }[] = [
        { oldTitle: 'Global Upgrade Certificates (Diamond only)', newTitle: 'Diamond Choice - 4 Global Upgrade Certificates' },
        { oldTitle: 'Regional Upgrade Certificates (Diamond & Platinum)', newTitle: 'Diamond Choice - 8 Regional Upgrade Certificates' },
      ];
      let deltaMigrated = 0;
      for (const m of legacyDeltaMap) {
        const oldRow = database.prepare(`
          SELECT id FROM benefits WHERE program_id = 'delta_medallion' AND title = ?
        `).get(m.oldTitle) as { id: number } | undefined;
        if (!oldRow) continue;
        const newRow = database.prepare(`
          SELECT id FROM benefits WHERE program_id = 'delta_medallion' AND title = ?
        `).get(m.newTitle) as { id: number } | undefined;
        if (!newRow) {
          // New row isn’t inserted yet; rename the legacy row in place so its
          // usages survive and the INSERT pass below skips it.
          database.prepare('UPDATE benefits SET title = ? WHERE id = ?').run(m.newTitle, oldRow.id);
          deltaMigrated++;
          continue;
        }
        const moved = database.prepare('UPDATE usages SET benefit_id = ? WHERE benefit_id = ?').run(newRow.id, oldRow.id);
        deltaMigrated += moved.changes;
        database.prepare('DELETE FROM benefits WHERE id = ?').run(oldRow.id);
      }
      if (deltaMigrated > 0) run.push(`v1_0_10_migrated_${deltaMigrated}_delta_upgrade_rows`);

      // (e) INSERT any new v1.0.10 seed rows (Delta Choice options, carry-over
      // regional upgrades) and (f) UPSERT the milestone parent rows so their
      // updated descriptions / value_usd propagate.
      //
      // Older DBs (pre-v1.0.5) may not yet have the is_user_modified column at
      // this point in the migration chain, so pick a lookup query that only
      // references columns we know exist and probe for is_user_modified
      // separately below.
      const hasUserModifiedCol = (database.prepare(`PRAGMA table_info(benefits)`).all() as { name: string }[])
        .some((c) => c.name === 'is_user_modified');
      const findBenefit = hasUserModifiedCol
        ? database.prepare('SELECT id, is_user_modified FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?')
        : database.prepare('SELECT id, 0 AS is_user_modified FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?');
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
          is_choice_option, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
          @is_choice_option, @sort_order, @source_url, @notes
        )
      `);
      // Fields we’re willing to overwrite even when is_user_modified = 1 for
      // v1.0.10 upserts: description/category/sort_order/source_url/notes/
      // is_choice_option. value_usd/uses_per_period/expiration_date/expiration_note/
      // reset_cadence/reset_years/spend_threshold_usd are preserved on user-
      // modified rows so we don’t clobber user edits (root-cause fix from #5).
      const updateBenefitPreserveUserFields = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          is_choice_option = @is_choice_option,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);
      const updateBenefitFull = database.prepare(`
        UPDATE benefits SET
          description = @description,
          category = @category,
          reset_cadence = @reset_cadence,
          uses_per_period = @uses_per_period,
          value_usd = @value_usd,
          spend_threshold_usd = @spend_threshold_usd,
          expiration_note = @expiration_note,
          expiration_date = @expiration_date,
          reset_years = @reset_years,
          is_choice_option = @is_choice_option,
          sort_order = @sort_order,
          source_url = @source_url,
          notes = @notes
        WHERE id = @id
      `);

      // First pass: INSERT missing seed rows (new Delta Choice options, carry-over).
      let inserted = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number; is_user_modified: number } | undefined;
        if (existing) continue;
        insertBenefit.run({
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          expiration_date: (b as any).expiration_date ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        });
        inserted++;
      }
      if (inserted > 0) run.push(`v1_0_10_inserted_${inserted}_new_seed_rows`);

      // Second pass: UPSERT existing rows. For user-modified rows, only refresh
      // metadata (description/category/notes/etc.) and preserve user’s
      // value_usd / expiration_date / cadence edits.
      let upsertedFull = 0;
      let upsertedPreserve = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title) as { id: number; is_user_modified: number } | undefined;
        if (!existing) continue;
        const params = {
          id: existing.id,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          expiration_date: (b as any).expiration_date ?? null,
          reset_years: (b as any).reset_years ?? null,
          is_choice_option: (b as any).is_choice_option ?? 0,
          sort_order: b.sort_order ?? 0,
          source_url: b.source_url ?? null,
          notes: b.notes ?? null,
        };
        if (existing.is_user_modified === 1) {
          updateBenefitPreserveUserFields.run(params);
          upsertedPreserve++;
        } else {
          updateBenefitFull.run(params);
          upsertedFull++;
        }
      }
      if (upsertedFull > 0) run.push(`v1_0_10_upserted_${upsertedFull}_benefits`);
      if (upsertedPreserve > 0) run.push(`v1_0_10_preserved_${upsertedPreserve}_user_modified_rows`);

      // Resolve prerequisite_benefit_id for the new Delta Choice option rows.
      const resolvePrereq = database.prepare(`
        UPDATE benefits SET prerequisite_benefit_id = (
          SELECT p.id FROM benefits p
          WHERE (p.card_id IS benefits.card_id OR (p.card_id IS NULL AND benefits.card_id IS NULL))
            AND (p.program_id IS benefits.program_id OR (p.program_id IS NULL AND benefits.program_id IS NULL))
            AND p.title = @prereq_title
        )
        WHERE title = @title
          AND (program_id = @program_id OR (program_id IS NULL AND @program_id IS NULL))
          AND (card_id = @card_id OR (card_id IS NULL AND @card_id IS NULL))
      `);
      let prereqLinks = 0;
      for (const b of SEED_BENEFITS) {
        const prereqTitle = (b as any).prerequisite_benefit_title;
        if (!prereqTitle) continue;
        const r = resolvePrereq.run({
          prereq_title: prereqTitle,
          title: b.title,
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
        });
        prereqLinks += r.changes;
      }
      if (prereqLinks > 0) run.push(`v1_0_10_relinked_${prereqLinks}_prereq_ids`);

      metaSet(database, 'seed_version', '1.0.10');
      run.push('v1_0_10_seed_refresh');
    });
    tx();
  }

  // ─── v1.0.11: Sky Club wide-dedupe, Marriott EN trackable, Ambassador $0 ───
  if (seedVersionLt(database, '1.0.11')) {
    const tx = database.transaction(() => {
      // 1) Widen Delta Reserve Sky Club dedupe — v1.0.10 only DELETEd the exact
      //    seeded title, missing pre-rename variants. Match any Sky Club row on
      //    delta_reserve whose title mentions Unlimited or a 75k spend gate.
      //    Migrate any usages onto the Amex Platinum combo row first, then delete.
      const platinumCombo = database.prepare(`
        SELECT id FROM benefits
        WHERE card_id = 'amex_platinum'
          AND title = 'Unlimited Delta Sky Club + Centurion Guest Access after $75,000 Spend'
        LIMIT 1
      `).get() as { id: number } | undefined;
      const skyClubDupes = database.prepare(`
        SELECT id FROM benefits
        WHERE card_id = 'delta_reserve'
          AND title LIKE '%Sky Club%'
          AND (
            title LIKE '%Unlimited%'
            OR title LIKE '%75,000%'
            OR title LIKE '%75000%'
            OR title LIKE '%$75%'
          )
      `).all() as Array<{ id: number }>;
      let migratedSkyUsages = 0;
      let deletedSkyDupes = 0;
      for (const dup of skyClubDupes) {
        if (platinumCombo) {
          const upd = database.prepare(`UPDATE usages SET benefit_id = ? WHERE benefit_id = ?`).run(platinumCombo.id, dup.id);
          migratedSkyUsages += upd.changes;
        } else {
          database.prepare(`DELETE FROM usages WHERE benefit_id = ?`).run(dup.id);
        }
        database.prepare(`DELETE FROM benefits WHERE id = ?`).run(dup.id);
        deletedSkyDupes += 1;
      }
      if (migratedSkyUsages > 0) run.push(`v1_0_11_migrated_${migratedSkyUsages}_sky_club_usages`);
      if (deletedSkyDupes > 0) run.push(`v1_0_11_deleted_${deletedSkyDupes}_sky_club_dupes`);

      // 2) Marriott EN per $3,000: 'unlimited' cadence is untrackable in UI
      //    (goes to Ongoing pane with no earned/cap count). Switch to
      //    annual + uses_per_period = 999 so users can log one usage per
      //    $3,000 in spend and see the earned count for the year. Applied
      //    unconditionally: the previous 'unlimited' shape made the row
      //    unusable so `is_user_modified` isn't relevant here.
      const marriottEn = database.prepare(`
        UPDATE benefits
        SET reset_cadence = 'annual', uses_per_period = 999
        WHERE card_id = 'marriott_premier'
          AND title = '1 Elite Night Credit per $3,000 spent (uncapped)'
      `).run();
      if (marriottEn.changes > 0) run.push(`v1_0_11_updated_${marriottEn.changes}_marriott_en_cadence`);

      // 3) IHG Ambassador Complimentary Weekend Night: certificate value
      //    depends heavily on redemption context, so the previous $300 fixed
      //    value overstated it. Set to $0 so nothing implies a guaranteed
      //    dollar-for-dollar return.
      const ihgAmb = database.prepare(`
        UPDATE benefits
        SET value_usd = 0
        WHERE program_id = 'ihg_ambassador'
          AND title = 'Complimentary Weekend Night'
      `).run();
      if (ihgAmb.changes > 0) run.push(`v1_0_11_updated_${ihgAmb.changes}_ihg_ambassador_night_value`);

      metaSet(database, 'seed_version', '1.0.11');
      run.push('v1_0_11_seed_refresh');
    });
    tx();
  }

  // ─── v1.0.12: installer / uninstaller hardening only, no data changes ───
  // Data model is unchanged. Bump the stamp so both new and existing users
  // land on the same seed_version after upgrading.
  if (seedVersionLt(database, '1.0.12')) {
    const tx = database.transaction(() => {
      metaSet(database, 'seed_version', '1.0.12');
      run.push('v1_0_12_seed_refresh');
    });
    tx();
  }

  // ─── v1.0.13: customCheckAppRunning override, no data changes ──────────
  // Replaces electron-builder's fragile _CHECK_APP_RUNNING probe with a
  // deterministic tasklist-only check to stop the "cannot be closed" loop
  // on reinstall. No schema, seed, or user-data changes.
  if (seedVersionLt(database, '1.0.13')) {
    const tx = database.transaction(() => {
      metaSet(database, 'seed_version', '1.0.13');
      run.push('v1_0_13_seed_refresh');
    });
    tx();
  }

  // ─── v1.0.14: installer preInit path fix + runtime icon path fix ───────
  // No data changes. Ships two runtime/installer fixes:
  //   1) installer.nsh preInit forces $INSTDIR to $LOCALAPPDATA\Programs so
  //      the wizard no longer targets an unwritable C:\Program Files path
  //      when a stale empty folder or ghost registry value exists.
  //   2) iconPath.ts now correctly resolves the icon from
  //      process.resourcesPath (extraResources location) instead of
  //      app.getAppPath() (which points into app.asar and misses the icon),
  //      so the app taskbar / window icon is the credit-card icon instead
  //      of the default Electron logo.
  if (seedVersionLt(database, '1.0.14')) {
    const tx = database.transaction(() => {
      metaSet(database, 'seed_version', '1.0.14');
      run.push('v1_0_14_seed_refresh');
    });
    tx();
  }

  // ─── v1.0.16: Bonus Categories tab + Points Currency Values tab + base ───
  // program benefits (Marriott 5th-night-free). Ships three pieces of data
  // migration for DBs that were created before this version:
  //   1) ALTER TABLE benefits to add the 4 structured earning-multiplier
  //      columns (multiplier_rate, multiplier_currency, spend_category,
  //      spend_category_note). initSchema() already creates these columns
  //      for brand-new DBs, so ALTER TABLE ADD COLUMN would fail with
  //      "duplicate column name" on a fresh DB that goes straight from
  //      initSchema → seedIfFresh → applyDataMigrations. We check
  //      pragma table_info first and only ALTER columns that are missing.
  //   2) Insert SEED_POINTS_CURRENCIES rows for any currency id not already
  //      present, so pre-existing installs get the new reference table
  //      populated too (fresh installs already get this via seedIfFresh).
  //      Rows with is_user_modified = 1 are left untouched (never overwritten).
  //   3) No benefit/program backfill needed here — the new
  //      marriott_bonvoy_base program + benefit and the new structured
  //      multiplier rows only ship via SEED_BENEFITS/SEED_PROGRAMS, which
  //      only apply to fresh installs. Existing installs keep their current
  //      benefit rows untouched (consistent with how this app has always
  //      treated card/program/benefit seed data — see v1.0.9-1.0.12 blocks
  //      above, which only touch data via explicit UPSERT passes when the
  //      research pipeline regenerates seed content). Users on existing
  //      installs can pull the new bonus-category and base-program data via
  //      the in-app Quarterly Refresh flow once a refresh run is prepared.
  if (seedVersionLt(database, '1.0.16')) {
    const tx = database.transaction(() => {
      // Defensive table creation: some legacy/hand-rolled DBs in tests (and
      // potentially very old real installs) predate the refresh_changes and
      // points_currencies tables and never ran through initSchema()'s
      // CREATE TABLE IF NOT EXISTS. Ensure both exist before altering/seeding
      // them below so this migration is safe to run standalone.
      database.exec(`
        CREATE TABLE IF NOT EXISTS refresh_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at   TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          source_notes TEXT,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','applied','discarded'))
        );
        CREATE TABLE IF NOT EXISTS refresh_changes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          refresh_run_id INTEGER NOT NULL REFERENCES refresh_runs(id) ON DELETE CASCADE,
          change_type TEXT NOT NULL CHECK(change_type IN ('added','modified','removed')),
          card_id TEXT,
          program_id TEXT,
          benefit_id INTEGER,
          points_currency_id TEXT,
          before_json TEXT,
          after_json TEXT,
          review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
          review_notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS points_currencies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          currency_type TEXT NOT NULL CHECK(currency_type IN ('transferable','airline','hotel')),
          value_cents_per_point REAL NOT NULL,
          source_name TEXT NOT NULL DEFAULT 'One Mile at a Time',
          source_url TEXT,
          notes TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          is_user_modified INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const benefitCols = new Set(
        (database.prepare(`PRAGMA table_info(benefits)`).all() as { name: string }[]).map(c => c.name),
      );
      const newBenefitCols: [string, string][] = [
        ['multiplier_rate', 'REAL'],
        ['multiplier_currency', 'TEXT'],
        ['spend_category', 'TEXT'],
        ['spend_category_note', 'TEXT'],
      ];
      for (const [col, type] of newBenefitCols) {
        if (benefitCols.has(col)) continue;
        try {
          database.exec(`ALTER TABLE benefits ADD COLUMN ${col} ${type}`);
        } catch { /* column already exists (race with initSchema) — ignore */ }
      }

      // refresh_changes.points_currency_id — lets the quarterly refresh diff
      // mechanism propose points-currency valuation updates (see RefreshChange
      // in types.ts). Same guarded ALTER pattern as the benefit columns above.
      const refreshChangeCols = new Set(
        (database.prepare(`PRAGMA table_info(refresh_changes)`).all() as { name: string }[]).map(c => c.name),
      );
      if (!refreshChangeCols.has('points_currency_id')) {
        try {
          database.exec(`ALTER TABLE refresh_changes ADD COLUMN points_currency_id TEXT`);
        } catch { /* column already exists — ignore */ }
      }

      const existingCurrencyIds = new Set(
        (database.prepare(`SELECT id FROM points_currencies`).all() as { id: string }[]).map(r => r.id),
      );
      const insertPointsCurrency = database.prepare(`
        INSERT INTO points_currencies (id, name, currency_type, value_cents_per_point, source_name, source_url, notes, is_active)
        VALUES (@id, @name, @currency_type, @value_cents_per_point, @source_name, @source_url, @notes, 1)
      `);
      for (const pc of SEED_POINTS_CURRENCIES) {
        // Preserve any row a user may have already created/edited with this id
        // (e.g. via a prior partial migration or manual entry); never overwrite.
        if (existingCurrencyIds.has(pc.id)) continue;
        insertPointsCurrency.run({
          id: pc.id,
          name: pc.name,
          currency_type: pc.currency_type,
          value_cents_per_point: pc.value_cents_per_point,
          source_name: pc.source_name ?? 'One Mile at a Time',
          source_url: pc.source_url ?? null,
          notes: pc.notes ?? null,
        });
      }

      metaSet(database, 'seed_version', '1.0.16');
      run.push('v1_0_16_seed_refresh');
    });
    tx();
  }

  // ─── v1.0.17: backfill Bonus Categories + base-program seed rows on ────
  // existing installs. v1.0.16 added the schema (columns/table) and the
  // points-currency reference rows for existing DBs, but explicitly skipped
  // backfilling the new SEED_BENEFITS/SEED_PROGRAMS content itself (see the
  // v1.0.16 block's comment above) — the assumption was that users would
  // pull new bonus-category rows through the Quarterly Refresh flow. In
  // practice this left the new Bonus Categories tab empty for every
  // pre-1.0.16 install, since a fresh install is the only path that runs
  // seedIfFresh(). This migration follows the same insert-if-missing
  // pattern used by the v1.0.9/v1.0.10 blocks above: match existing rows by
  // (card_id, program_id, title) and only INSERT what's missing, so no
  // existing user data or edits are touched.
  if (seedVersionLt(database, '1.0.17')) {
    const tx = database.transaction(() => {
      // (1) Backfill the new marriott_bonvoy_base program (and any other
      // SEED_PROGRAMS row not yet present).
      const findProgram = database.prepare('SELECT id FROM programs WHERE id = ?');
      const insertProgram = database.prepare(`
        INSERT INTO programs (id, name, program_type, notes, source_url)
        VALUES (@id, @name, @program_type, @notes, @source_url)
      `);
      let programsInserted = 0;
      for (const p of SEED_PROGRAMS) {
        if (findProgram.get(p.id)) continue;
        insertProgram.run({
          id: p.id,
          name: p.name,
          program_type: p.program_type,
          notes: (p as any).notes ?? null,
          source_url: (p as any).source_url ?? null,
        });
        programsInserted++;
      }
      if (programsInserted > 0) run.push(`v1_0_17_inserted_${programsInserted}_programs`);

      // (2) Backfill missing SEED_BENEFITS rows — this covers both the new
      // marriott_bonvoy_base benefit and the ~34 new structured
      // earning-multiplier rows across the 9 cards that previously had no
      // Bonus Categories data. Existing rows (matched by card_id/program_id/
      // title) are left completely untouched, so the pre-existing
      // marriott_premier/virgin_atlantic multiplier rows are NOT
      // duplicated — those already had multiplier_rate/multiplier_currency/
      // spend_category populated directly on their existing rows via the
      // v1.0.16 code change to benefitsSeedData.ts, and this pass will
      // simply skip them since a title match already exists.
      const findBenefit = database.prepare(
        'SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?'
      );
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
          multiplier_rate, multiplier_currency, spend_category, spend_category_note,
          is_choice_option, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
          @multiplier_rate, @multiplier_currency, @spend_category, @spend_category_note,
          @is_choice_option, @sort_order, @source_url, @notes
        )
      `);
      let benefitsInserted = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title);
        if (existing) continue;
        insertBenefit.run({
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          expiration_date: (b as any).expiration_date ?? null,
          reset_years: (b as any).reset_years ?? null,
          multiplier_rate: b.multiplier_rate ?? null,
          multiplier_currency: b.multiplier_currency ?? null,
          spend_category: b.spend_category ?? null,
          spend_category_note: b.spend_category_note ?? null,
          is_choice_option: (b as any).is_choice_option ? 1 : 0,
          sort_order: b.sort_order ?? 0,
          source_url: (b as any).source_url ?? null,
          notes: (b as any).notes ?? null,
        });
        benefitsInserted++;
      }
      if (benefitsInserted > 0) run.push(`v1_0_17_inserted_${benefitsInserted}_benefits`);

      metaSet(database, 'seed_version', '1.0.17');
      run.push('v1_0_17_seed_refresh');
    });
    tx();
  }

  // v1.0.19: (1) backfill `installed_at` for installs that predate the
  // meta stamp, anchored to "now" so their quarterly-refresh due date is
  // 3 months out from today rather than reusing the 1970 epoch bug; (2)
  // insert the new hilton_status program and its Diamond elite-tier
  // benefit rows (card_id: null — independent of hilton_aspire, since the
  // user holds Lifetime Diamond separate from any card); (3) generic
  // insert-if-missing backfill for any other new SEED_PROGRAMS/SEED_BENEFITS
  // rows, matching the v1.0.17 pattern; (4) defensive Virgin Atlantic
  // cleanup in case any pre-v1.0.4 install still carries a stray legacy
  // duplicate row under the same card_id from before the rename/upsert
  // migrations landed.
  if (seedVersionLt(database, '1.0.19')) {
    const tx = database.transaction(() => {
      // (1) installed_at backfill — only if never stamped. Anchoring on "now"
      // for pre-existing installs means their first quarterly-refresh
      // reminder lands 3 months from today, matching the user's approved
      // fallback design for the epoch-due-date bug.
      if (!metaGet(database, 'installed_at')) {
        metaSet(database, 'installed_at', new Date().toISOString());
        run.push('v1_0_19_backfilled_installed_at');
      }

      // (2)+(3) Insert any SEED_PROGRAMS row not yet present (covers the new
      // hilton_status program).
      const findProgram = database.prepare('SELECT id FROM programs WHERE id = ?');
      const insertProgram = database.prepare(`
        INSERT INTO programs (id, name, program_type, notes, source_url)
        VALUES (@id, @name, @program_type, @notes, @source_url)
      `);
      let programsInserted = 0;
      for (const p of SEED_PROGRAMS) {
        if (findProgram.get(p.id)) continue;
        insertProgram.run({
          id: p.id,
          name: p.name,
          program_type: p.program_type,
          notes: (p as any).notes ?? null,
          source_url: (p as any).source_url ?? null,
        });
        programsInserted++;
      }
      if (programsInserted > 0) run.push(`v1_0_19_inserted_${programsInserted}_programs`);

      // Insert any SEED_BENEFITS row not yet present, matched by
      // (card_id, program_id, title) — covers the new Hilton Diamond rows
      // and leaves every existing row (including the rewritten
      // hilton_aspire Diamond-status description) completely untouched,
      // since that row's title didn't change.
      const findBenefit = database.prepare(
        'SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ?'
      );
      const insertBenefit = database.prepare(`
        INSERT INTO benefits (
          card_id, program_id, title, description, category, reset_cadence, uses_per_period,
          value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
          multiplier_rate, multiplier_currency, spend_category, spend_category_note,
          is_choice_option, sort_order, source_url, notes
        ) VALUES (
          @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
          @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
          @multiplier_rate, @multiplier_currency, @spend_category, @spend_category_note,
          @is_choice_option, @sort_order, @source_url, @notes
        )
      `);
      let benefitsInserted = 0;
      for (const b of SEED_BENEFITS) {
        const existing = findBenefit.get(b.card_id ?? null, b.program_id ?? null, b.title);
        if (existing) continue;
        insertBenefit.run({
          card_id: b.card_id ?? null,
          program_id: b.program_id ?? null,
          title: b.title,
          description: b.description ?? null,
          category: b.category,
          reset_cadence: b.reset_cadence,
          uses_per_period: b.uses_per_period ?? null,
          value_usd: b.value_usd ?? null,
          spend_threshold_usd: b.spend_threshold_usd ?? null,
          expiration_note: b.expiration_note ?? null,
          expiration_date: (b as any).expiration_date ?? null,
          reset_years: (b as any).reset_years ?? null,
          multiplier_rate: b.multiplier_rate ?? null,
          multiplier_currency: b.multiplier_currency ?? null,
          spend_category: b.spend_category ?? null,
          spend_category_note: b.spend_category_note ?? null,
          is_choice_option: (b as any).is_choice_option ? 1 : 0,
          sort_order: b.sort_order ?? 0,
          source_url: (b as any).source_url ?? null,
          notes: (b as any).notes ?? null,
        });
        benefitsInserted++;
      }
      if (benefitsInserted > 0) run.push(`v1_0_19_inserted_${benefitsInserted}_benefits`);

      // (4) Defensive Virgin Atlantic cleanup: the card has used the single
      // stable id 'virgin_atlantic' since v1.0.4 (renamed in place, never
      // re-issued under a new id), so there should be no separate
      // discontinued-card row to remove. As a safety net, delete any
      // leftover pre-rename duplicate benefit titles that reference the old
      // Bank of America-era wording, in case an install somehow missed the
      // earlier dedup migrations.
      const legacyVaTitles = [
        'BofA Preferred Rewards travel bonus',
        'Bank of America Preferred Rewards bonus',
      ];
      const delLegacyVa = database.prepare(
        "DELETE FROM benefits WHERE card_id = 'virgin_atlantic' AND title = ?"
      );
      let vaCleaned = 0;
      for (const t of legacyVaTitles) {
        vaCleaned += delLegacyVa.run(t).changes;
      }
      if (vaCleaned > 0) run.push(`v1_0_19_cleaned_${vaCleaned}_legacy_virgin_atlantic_rows`);

      metaSet(database, 'seed_version', '1.0.19');
      run.push('v1_0_19_seed_refresh');
    });
    tx();
  }

  if (seedVersionLt(database, '1.0.20')) {
    database.transaction(() => {
      migrateRelease20(database);
      metaSet(database, 'seed_version', '1.0.20');
      run.push('v1_0_20_credits_and_usages');
    })();
  }
  return { migrations_run: run };
}

// ─── Cards CRUD ──────────────────────────────────────────────────────────────

const CARD_COLS = 'id, name, issuer, network, annual_fee_usd, is_active, is_visible, color_hex, notes, source_url, created_at';

// ─── Input validation helpers ────────────────────────────────────────────────

/** Non-empty trimmed string required. */
function requireStr(field: string, v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${field} is required`);
  return v.trim();
}
/** ISO YYYY-MM-DD date required (accepts full ISO too). */
function requireDate(field: string, v: unknown): string {
  if (typeof v !== 'string') throw new Error(`${field} must be a date string`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date: ${v}`);
  return v;
}

function slugify(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

function ensureUniqueId(database: Database.Database, table: 'cards' | 'programs' | 'points_currencies', base: string): string {
  const exists = (id: string) => !!database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error('Could not allocate a unique id');
}

export function cardsGetAll(database: Database.Database): Card[] {
  return database.prepare(`SELECT ${CARD_COLS} FROM cards ORDER BY is_active DESC, name ASC`).all() as Card[];
}
export function cardGetById(database: Database.Database, id: string): Card | null {
  return (database.prepare(`SELECT ${CARD_COLS} FROM cards WHERE id = ?`).get(id) as Card | undefined) ?? null;
}
export function cardCreate(database: Database.Database, input: CardInput): Card {
  requireStr('name', input.name);
  requireStr('issuer', input.issuer);
  const id = input.id ?? ensureUniqueId(database, 'cards', slugify(input.name) || 'card');
  database.prepare(`
    INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active, is_visible, color_hex, notes, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, input.issuer, input.network,
    input.annual_fee_usd ?? null,
    input.is_active ?? 1,
    input.is_visible ?? 1,
    input.color_hex ?? null,
    input.notes ?? null,
    requireWebLinkOrBlank('Link', input.source_url),
  );
  return cardGetById(database, id)!;
}
export function cardUpdate(database: Database.Database, id: string, patch: Partial<CardInput>): Card | null {
  const current = cardGetById(database, id);
  if (!current) return null;
  database.prepare(`
    UPDATE cards SET
      name = COALESCE(@name, name),
      issuer = COALESCE(@issuer, issuer),
      network = COALESCE(@network, network),
      annual_fee_usd = @annual_fee_usd,
      is_active = COALESCE(@is_active, is_active),
      is_visible = COALESCE(@is_visible, is_visible),
      color_hex = @color_hex,
      notes = @notes,
      source_url = @source_url
    WHERE id = @id
  `).run({
    id,
    name: patch.name ?? null,
    issuer: patch.issuer ?? null,
    network: patch.network ?? null,
    annual_fee_usd: patch.annual_fee_usd ?? current.annual_fee_usd,
    is_active: patch.is_active ?? null,
    is_visible: patch.is_visible ?? null,
    color_hex: patch.color_hex ?? current.color_hex,
    notes: patch.notes ?? current.notes,
    source_url: patch.source_url == null ? safeWebLinkOrNull(current.source_url) : requireWebLinkOrBlank('Link', patch.source_url),
  });
  return cardGetById(database, id)!;
}
export function cardDelete(database: Database.Database, id: string): void {
  database.prepare('DELETE FROM cards WHERE id = ?').run(id);
}
export function cardSetVisible(database: Database.Database, id: string, visible: boolean): Card {
  const current = cardGetById(database, id);
  if (!current) throw new Error(`Card ${id} not found`);
  database.prepare('UPDATE cards SET is_visible = ? WHERE id = ?').run(visible ? 1 : 0, id);
  return cardGetById(database, id)!;
}

// ─── Programs CRUD ───────────────────────────────────────────────────────────

const PROG_COLS = 'id, name, program_type, is_active, notes, source_url, created_at';

export function programsGetAll(database: Database.Database): Program[] {
  return database.prepare(`SELECT ${PROG_COLS} FROM programs ORDER BY is_active DESC, name ASC`).all() as Program[];
}
export function programGetById(database: Database.Database, id: string): Program | null {
  return (database.prepare(`SELECT ${PROG_COLS} FROM programs WHERE id = ?`).get(id) as Program | undefined) ?? null;
}
export function programCreate(database: Database.Database, input: ProgramInput): Program {
  requireStr('name', input.name);
  const id = input.id ?? ensureUniqueId(database, 'programs', slugify(input.name) || 'program');
  database.prepare(`
    INSERT INTO programs (id, name, program_type, is_active, notes, source_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, input.program_type,
    input.is_active ?? 1,
    input.notes ?? null,
    requireWebLinkOrBlank('Link', input.source_url),
  );
  return programGetById(database, id)!;
}
export function programUpdate(database: Database.Database, id: string, patch: Partial<ProgramInput>): Program {
  const current = programGetById(database, id);
  if (!current) throw new Error(`Program ${id} not found`);
  database.prepare(`
    UPDATE programs SET
      name = COALESCE(@name, name),
      program_type = COALESCE(@program_type, program_type),
      is_active = COALESCE(@is_active, is_active),
      notes = @notes,
      source_url = @source_url
    WHERE id = @id
  `).run({
    id,
    name: patch.name ?? null,
    program_type: patch.program_type ?? null,
    is_active: patch.is_active ?? null,
    notes: patch.notes ?? current.notes,
    source_url: patch.source_url == null ? safeWebLinkOrNull(current.source_url) : requireWebLinkOrBlank('Link', patch.source_url),
  });
  return programGetById(database, id)!;
}
export function programDelete(database: Database.Database, id: string): void {
  database.prepare('DELETE FROM programs WHERE id = ?').run(id);
}

// ─── Points currency valuations CRUD ──────────────────────────────────────────
// Mirrors the programCreate/programUpdate COALESCE-based partial-update
// pattern above, with a slugify-based id (same as cards/programs) so ids
// stay human-readable (e.g. "amex_membership_rewards").

const PC_COLS = 'id, name, currency_type, value_cents_per_point, source_name, source_url, notes, is_active, is_user_modified, updated_at, created_at';

export function pointsCurrenciesGetAll(database: Database.Database): PointsCurrency[] {
  return database.prepare(`SELECT ${PC_COLS} FROM points_currencies ORDER BY currency_type ASC, name ASC`).all() as PointsCurrency[];
}
export function pointsCurrencyGetById(database: Database.Database, id: string): PointsCurrency | null {
  return (database.prepare(`SELECT ${PC_COLS} FROM points_currencies WHERE id = ?`).get(id) as PointsCurrency | undefined) ?? null;
}
export function pointsCurrencyCreate(database: Database.Database, input: PointsCurrencyInput): PointsCurrency {
  requireStr('name', input.name);
  if (typeof input.value_cents_per_point !== 'number' || Number.isNaN(input.value_cents_per_point)) {
    throw new Error('value_cents_per_point is required');
  }
  const id = input.id ?? ensureUniqueId(database, 'points_currencies', slugify(input.name) || 'currency');
  database.prepare(`
    INSERT INTO points_currencies (id, name, currency_type, value_cents_per_point, source_name, source_url, notes, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, input.currency_type, input.value_cents_per_point,
    input.source_name ?? 'One Mile at a Time',
    requireWebLinkOrBlank('Link', input.source_url),
    input.notes ?? null,
    input.is_active ?? 1,
  );
  return pointsCurrencyGetById(database, id)!;
}
export function pointsCurrencyUpdate(database: Database.Database, id: string, patch: Partial<PointsCurrencyInput>): PointsCurrency {
  const current = pointsCurrencyGetById(database, id);
  if (!current) throw new Error(`Points currency ${id} not found`);
  database.prepare(`
    UPDATE points_currencies SET
      name = COALESCE(@name, name),
      currency_type = COALESCE(@currency_type, currency_type),
      value_cents_per_point = COALESCE(@value_cents_per_point, value_cents_per_point),
      source_name = COALESCE(@source_name, source_name),
      source_url = @source_url,
      notes = @notes,
      is_active = COALESCE(@is_active, is_active),
      is_user_modified = 1,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id,
    name: patch.name ?? null,
    currency_type: patch.currency_type ?? null,
    value_cents_per_point: patch.value_cents_per_point ?? null,
    source_name: patch.source_name ?? null,
    source_url: patch.source_url == null ? safeWebLinkOrNull(current.source_url) : requireWebLinkOrBlank('Link', patch.source_url),
    notes: patch.notes ?? current.notes,
    is_active: patch.is_active ?? null,
  });
  return pointsCurrencyGetById(database, id)!;
}
export function pointsCurrencyDelete(database: Database.Database, id: string): void {
  database.prepare('DELETE FROM points_currencies WHERE id = ?').run(id);
}

// ─── Benefits CRUD ───────────────────────────────────────────────────────────

const BEN_COLS = `id, is_hidden, previous_value_usd, value_effective_date, card_id, program_id, title, description, category, reset_cadence,
  uses_per_period, value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
  multiplier_rate, multiplier_currency, spend_category, spend_category_note,
  prerequisite_benefit_id, is_choice_option, choice_selected,
  is_active, sort_order, source_url, notes, is_user_modified, created_at, updated_at`;

export function benefitsGetAll(database: Database.Database): Benefit[] {
  return database.prepare(`SELECT ${BEN_COLS} FROM benefits ORDER BY sort_order ASC, title ASC`).all() as Benefit[];
}
export function benefitsForCard(database: Database.Database, cardId: string): Benefit[] {
  return database.prepare(`SELECT ${BEN_COLS} FROM benefits WHERE card_id = ? ORDER BY sort_order, title`).all(cardId) as Benefit[];
}
export function benefitsForProgram(database: Database.Database, programId: string): Benefit[] {
  return database.prepare(`SELECT ${BEN_COLS} FROM benefits WHERE program_id = ? ORDER BY sort_order, title`).all(programId) as Benefit[];
}
export function benefitGetById(database: Database.Database, id: number): Benefit | null {
  return (database.prepare(`SELECT ${BEN_COLS} FROM benefits WHERE id = ?`).get(id) as Benefit | undefined) ?? null;
}
export function benefitCreate(database: Database.Database, input: BenefitInput, markUserModified = true): Benefit {
  requireStr('title', input.title);
  validateBenefitDates(input);
  if ((input.card_id && input.program_id) || (!input.card_id && !input.program_id)) {
    throw new Error('Benefit must belong to exactly one card or program');
  }
  const info = database.prepare(`
    INSERT INTO benefits (
      card_id, program_id, title, description, category, reset_cadence, uses_per_period,
      value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
      multiplier_rate, multiplier_currency, spend_category, spend_category_note,
      is_choice_option, choice_selected,
      is_active, sort_order, source_url,
      notes, is_user_modified, is_hidden, previous_value_usd, value_effective_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.card_id ?? null,
    input.program_id ?? null,
    input.title,
    input.description ?? null,
    input.category,
    input.reset_cadence,
    input.uses_per_period ?? null,
    input.value_usd ?? null,
    input.spend_threshold_usd ?? null,
    input.expiration_note ?? null,
    input.expiration_date ?? null,
    input.reset_years ?? null,
    input.multiplier_rate ?? null,
    input.multiplier_currency ?? null,
    input.spend_category ?? null,
    input.spend_category_note ?? null,
    input.is_choice_option ?? 0,
    input.choice_selected ?? 0,
    input.is_active ?? 1,
    input.sort_order ?? 0,
    requireWebLinkOrBlank('Link', input.source_url),
    input.notes ?? null,
    markUserModified ? 1 : 0,
    input.is_hidden ?? 0,
    input.previous_value_usd ?? null,
    input.value_effective_date ?? null,
  );
  return benefitGetById(database, Number(info.lastInsertRowid))!;
}
export function benefitUpdate(database: Database.Database, id: number, patch: Partial<BenefitInput>): Benefit {
  validateBenefitDates(patch);
  const current = benefitGetById(database, id);
  if (!current) throw new Error(`Benefit ${id} not found`);
  database.prepare(`
    UPDATE benefits SET
      title = COALESCE(@title, title),
      description = @description,
      category = COALESCE(@category, category),
      reset_cadence = COALESCE(@reset_cadence, reset_cadence),
      uses_per_period = @uses_per_period,
      value_usd = @value_usd,
      spend_threshold_usd = @spend_threshold_usd,
      expiration_note = @expiration_note,
      expiration_date = @expiration_date,
      is_hidden = @is_hidden,
      previous_value_usd = @previous_value_usd,
      value_effective_date = @value_effective_date,
      reset_years = @reset_years,
      multiplier_rate = @multiplier_rate,
      multiplier_currency = @multiplier_currency,
      spend_category = @spend_category,
      spend_category_note = @spend_category_note,
      is_choice_option = COALESCE(@is_choice_option, is_choice_option),
      choice_selected = COALESCE(@choice_selected, choice_selected),
      is_active = COALESCE(@is_active, is_active),
      sort_order = COALESCE(@sort_order, sort_order),
      source_url = @source_url,
      notes = @notes,
      is_user_modified = @is_user_modified,
      updated_at = datetime('now')
    WHERE id = @id
  `).run({
    id,
    title: patch.title ?? null,
    description: patch.description ?? current.description,
    category: patch.category ?? null,
    reset_cadence: patch.reset_cadence ?? null,
    uses_per_period: patch.uses_per_period ?? current.uses_per_period,
    value_usd: patch.value_usd ?? current.value_usd,
    spend_threshold_usd: patch.spend_threshold_usd ?? current.spend_threshold_usd,
    expiration_note: patch.expiration_note ?? current.expiration_note,
    expiration_date: patch.expiration_date === undefined ? current.expiration_date : patch.expiration_date,
    is_hidden: patch.is_hidden ?? current.is_hidden,
    previous_value_usd: patch.previous_value_usd === undefined ? current.previous_value_usd : patch.previous_value_usd,
    value_effective_date: patch.value_effective_date === undefined ? current.value_effective_date : patch.value_effective_date,
    is_user_modified: Object.keys(patch).every(k => k === 'is_hidden') ? current.is_user_modified : 1,
    reset_years: patch.reset_years ?? current.reset_years,
    multiplier_rate: patch.multiplier_rate ?? current.multiplier_rate,
    multiplier_currency: patch.multiplier_currency ?? current.multiplier_currency,
    spend_category: patch.spend_category ?? current.spend_category,
    spend_category_note: patch.spend_category_note ?? current.spend_category_note,
    is_choice_option: patch.is_choice_option ?? null,
    choice_selected: patch.choice_selected ?? null,
    is_active: patch.is_active ?? null,
    sort_order: patch.sort_order ?? null,
    source_url: patch.source_url == null ? safeWebLinkOrNull(current.source_url) : requireWebLinkOrBlank('Link', patch.source_url),
    notes: patch.notes ?? current.notes,
  });
  return benefitGetById(database, id)!;
}
export function benefitDelete(database: Database.Database, id: number): void {
  // Retain a generated cycle's identity so deleting a benefit won't cause it
  // to reappear on the next dashboard load. Normal benefits keep existing delete behavior.
  if (database.prepare('SELECT 1 FROM certificate_awards WHERE award_id = ?').get(id)) {
    database.prepare('UPDATE benefits SET is_active = 0 WHERE id = ?').run(id);
    return;
  }
  database.prepare('DELETE FROM benefits WHERE id = ?').run(id);
}

export function benefitGetChoices(database: Database.Database, parentId: number, year: number): number[] {
  const row = database.prepare('SELECT selections_json FROM benefit_choices WHERE parent_id = ? AND ref_year = ?')
    .get(parentId, year) as { selections_json: string } | undefined;
  return row ? JSON.parse(row.selections_json) : [];
}

export function benefitSetChoices(database: Database.Database, parentId: number, year: number, choices: number[], requireAchievement = true): void {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new Error('Invalid choice year');
  if (!Array.isArray(choices) || choices.length > 3) throw new Error('At most three choices are allowed');
  const parent = benefitGetById(database, parentId);
  if (!parent || !isDiamondChoices(parent)) throw new Error('Invalid Diamond milestone');
  let cost = 0;
  for (const id of choices) {
    if (!Number.isInteger(id)) throw new Error('Invalid choice');
    const child = benefitGetById(database, id);
    if (!child || child.prerequisite_benefit_id !== parentId || child.is_choice_option !== 1 || child.is_active !== 1) {
      throw new Error('Choice must belong to this milestone');
    }
    cost += choiceCost(child.title);
  }
  if (cost > 3) throw new Error('These rewards require more than three selections');
  if (requireAchievement && choices.length && !database.prepare('SELECT 1 FROM usages WHERE benefit_id = ? AND period_key = ?').get(parentId, String(year))) {
    throw new Error('Mark Diamond achieved for this year before selecting rewards');
  }
  database.prepare('INSERT OR REPLACE INTO benefit_choices VALUES (?, ?, ?)').run(parentId, year, JSON.stringify(choices));
}

// ─── Usages CRUD ─────────────────────────────────────────────────────────────

const USE_COLS = 'id, benefit_id, used_on, amount_usd, quantity, period_key, notes, created_at';

function validateBenefitDates(input: Partial<BenefitInput>): void {
  for (const field of ['expiration_date', 'value_effective_date'] as const) {
    if (input[field] != null) requireIsoDate(field, input[field]);
  }
  if (input.is_hidden !== undefined && input.is_hidden !== 0 && input.is_hidden !== 1) throw new Error('is_hidden must be 0 or 1');
}

function requireIsoDate(field: string, value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
}

function validateQuantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000000) {
    throw new Error('Quantity must be a whole number from 1 to 1000000');
  }
  return value as number;
}

function qualifyingOmniCheckout(database: Database.Database, sourceId: number, year: number, today: string): string | null {
  const entries = database.prepare(`SELECT used_on FROM usages
    WHERE benefit_id = ? AND used_on BETWEEN ? AND ? AND quantity >= ? AND amount_usd IS NULL
    ORDER BY used_on, id`).all(sourceId, `${year}-01-01`, `${year}-12-31`, OMNI_STAY_NIGHTS) as { used_on: string }[];
  return entries.find(e => isCertificateDate(e.used_on) && e.used_on <= today)?.used_on ?? null;
}

function validateOmniStay(b: Benefit, checkout: string, amount: number | null | undefined, expiry?: string | null): void {
  if (!isOmniStayBenefit(b)) return;
  if (checkout > localIsoDate() || checkout < '1000-01-01') throw new Error('Enter the checkout date of a completed Omni stay');
  if (amount != null || expiry !== undefined) throw new Error('Log the nights for a single Omni reservation, not an amount or expiration');
}

export function usagesForBenefit(database: Database.Database, benefitId: number): Usage[] {
  return database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? ORDER BY used_on DESC, id DESC`).all(benefitId) as Usage[];
}

function validateCertificateUsage(database: Database.Database, b: Benefit, usedOn: string, expiry: string | null): void {
  const award = database.prepare('SELECT * FROM certificate_awards WHERE award_id = ?').get(b.id) as CertificateAward | undefined;
  if (!award && !isAnnualCertificate(b)) return;
  if (award && b.is_active !== 1) throw new Error('This certificate is no longer active');
  if (award?.kind === 'annual_renewal') {
    const source = benefitGetById(database, award.source_id);
    if (source && isOmniStayBenefit(source)) throw new Error('Omni awards must be earned from a qualifying stay');
  }
  if ((award?.kind === 'hyatt_spend' || award?.kind === 'omni_stay') && !isCertificateDate(expiry)) {
    throw new Error('Record the posted expiration date before logging a redemption');
  }
  if (isCertificateDate(expiry) && usedOn > expiry) throw new Error('Usage date is after the certificate expired');
  if (!award && isCertificateDate(expiry) && usedOn <= certificateYearOffset(expiry, -1)) throw new Error('Usage date is before this certificate cycle began');
  if (award?.kind === 'annual_renewal' && usedOn < award.starts_on) throw new Error('Usage date is before this certificate cycle began');
  if (award?.kind === 'omni_stay') {
    const checkout = qualifyingOmniCheckout(database, award.source_id, award.cycle_year, localIsoDate());
    if (!checkout || usedOn < checkout) throw new Error('A qualifying Omni stay must be completed before redemption');
  }
}

export function usageCreate(database: Database.Database, input: UsageInput): Usage {
  if (!Number.isInteger(input.benefit_id) || input.benefit_id <= 0) throw new Error('benefit_id is required');
  requireIsoDate('used_on', input.used_on);
  const quantity = validateQuantity(input.quantity ?? 1);
  const benefit = benefitGetById(database, input.benefit_id);
  if (!benefit) throw new Error(`Benefit ${input.benefit_id} not found`);
  validateOmniStay(benefit, input.used_on, input.amount_usd, input.expiration_date);
  validateCertificateUsage(database, benefit, input.used_on, input.expiration_date === undefined ? benefit.expiration_date : input.expiration_date);
  const period_key = periodKeyFor(benefit.reset_cadence, input.used_on);
  return database.transaction(() => {
    if (input.expiration_date !== undefined) {
      if (benefit.category !== 'free_night' && !isCompanionCertificate(benefit)) throw new Error('Expiration entry applies only to certificates');
      benefitUpdate(database, benefit.id, { expiration_date: input.expiration_date });
    }
    const info = database.prepare(`
      INSERT INTO usages (benefit_id, used_on, amount_usd, quantity, period_key, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.benefit_id, input.used_on, input.amount_usd ?? null, quantity, period_key, input.notes ?? null);
    return database.prepare(`SELECT ${USE_COLS} FROM usages WHERE id = ?`).get(Number(info.lastInsertRowid)) as Usage;
  })();
}
export function usageUpdate(database: Database.Database, id: number, patch: Partial<UsageInput>): Usage {
  const current = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE id = ?`).get(id) as Usage | undefined;
  if (!current) throw new Error(`Usage ${id} not found`);
  const benefit = benefitGetById(database, current.benefit_id);
  const used_on = patch.used_on ?? current.used_on;
  requireIsoDate('used_on', used_on);
  if (benefit) validateOmniStay(benefit, used_on, patch.amount_usd ?? current.amount_usd, patch.expiration_date);
  if (benefit && used_on !== current.used_on) validateCertificateUsage(database, benefit, used_on, benefit.expiration_date);
  const quantity = validateQuantity(patch.quantity ?? current.quantity);
  const period_key = benefit ? periodKeyFor(benefit.reset_cadence, used_on) : current.period_key;
  database.prepare(`
    UPDATE usages SET
      used_on = @used_on,
      amount_usd = @amount_usd,
      quantity = @quantity,
      period_key = @period_key,
      notes = @notes
    WHERE id = @id
  `).run({
    id,
    used_on,
    quantity,
    amount_usd: patch.amount_usd ?? current.amount_usd,
    period_key,
    notes: patch.notes ?? current.notes,
  });
  return database.prepare(`SELECT ${USE_COLS} FROM usages WHERE id = ?`).get(id) as Usage;
}
export function usageDelete(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM usages WHERE id = ?').run(id);
}

// ─── Projection ──────────────────────────────────────────────────────────────

/** Reconcile the working file using real local today, not the dashboard's selected year. */
export function reconcileCertificateAwards(database: Database.Database, today = localIsoDate()): void {
  requireIsoDate('today', today);
  const readAwards = database.prepare('SELECT * FROM certificate_awards WHERE source_id = ? AND kind = ? ORDER BY cycle_year DESC');
  const insertAward = database.prepare('INSERT INTO certificate_awards (source_id, award_id, cycle_year, starts_on, kind) VALUES (?, ?, ?, ?, ?)');
  const spendFor = database.prepare(`SELECT used_on, amount_usd FROM usages
    WHERE benefit_id = ? AND used_on <= ? AND amount_usd IS NOT NULL ORDER BY used_on, id`);
  const stayYears = database.prepare(`SELECT DISTINCT substr(used_on, 1, 4) AS year FROM usages
    WHERE benefit_id = ? AND used_on <= ? AND quantity >= ? AND amount_usd IS NULL`);
  const nextDay = (iso: string) => {
    const date = new Date(iso);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  database.transaction(() => {
    const sources = database.prepare(`SELECT ${BEN_COLS.split(',').map(c => `b.${c.trim()}`).join(', ')}
      FROM benefits b JOIN cards c ON c.id = b.card_id
      WHERE b.category IN ('free_night', 'other') AND b.reset_cadence IN ('annual', 'spend_threshold')
        AND b.is_active = 1 AND c.is_active = 1 AND c.is_visible = 1
        AND NOT EXISTS (SELECT 1 FROM certificate_awards a WHERE a.award_id = b.id)`).all() as Benefit[];
    for (const b of sources) {
      const create = (kind: CertificateAward['kind'], year: number, starts: string, expiration: string | null) => {
        const award = benefitCreate(database, {
          card_id: b.card_id,
          title: kind === 'hyatt_spend' ? `Hyatt Category 1–4 Free Night Award ($15,000 spend, ${year})`
            : kind === 'omni_stay' ? `Omni Free Night Award (earned ${year})` : `${b.title} (${year} expiration)`,
          description: kind === 'omni_stay'
            ? 'Earned from a logged qualifying stay. Confirm posting in Omni Select Guest and enter the expiration shown there.' : b.description,
          category: b.category,
          reset_cadence: 'one_time',
          uses_per_period: kind === 'annual_renewal' ? b.uses_per_period ?? 1 : 1,
          value_usd: b.value_usd,
          expiration_date: expiration,
          sort_order: b.sort_order + 1,
          source_url: safeWebLinkOrNull(b.source_url),
          is_hidden: b.is_hidden,
        }, false);
        insertAward.run(b.id, award.id, year, starts, kind);
      };

      if (isOmniStayBenefit(b)) {
        const existing = new Map((readAwards.all(b.id, 'omni_stay') as CertificateAward[]).map(a => [a.cycle_year, a]));
        for (const { year } of stayYears.all(b.id, today, OMNI_STAY_NIGHTS) as { year: string }[]) {
          if (!/^[1-9]\d{3}$/.test(year)) continue;
          const checkout = qualifyingOmniCheckout(database, b.id, Number(year), today);
          if (!checkout) continue;
          const prior = existing.get(Number(year));
          if (!prior) create('omni_stay', Number(year), checkout, null);
          else if (prior.starts_on !== checkout) database.prepare('UPDATE certificate_awards SET starts_on = ? WHERE award_id = ?').run(checkout, prior.award_id);
        }
      } else if (isAnnualCertificate(b)) {
        const latest = (readAwards.all(b.id, 'annual_renewal') as CertificateAward[])[0];
        const previous = latest ? benefitGetById(database, latest.award_id)! : b;
        const expiry = previous.expiration_date;
        if (!isCertificateDate(expiry) || expiry >= today) continue;
        const thisYear = Number(today.slice(0, 4));
        if (expiry.startsWith('9999-')) continue;
        // Create the current renewal, not a series of imagined certificates for years
        // when the app wasn't opened. Preserve the old certificate and all its uses.
        let renewed = certificateYearOffset(expiry, Math.max(1, thisYear - Number(expiry.slice(0, 4))));
        if (renewed < today) {
          if (thisYear === 9999) continue;
          renewed = certificateYearOffset(expiry, thisYear - Number(expiry.slice(0, 4)) + 1);
        }
        const year = Math.max(Number(renewed.slice(0, 4)), (latest?.cycle_year ?? 0) + 1);
        if (year > 9999) continue;
        const priorBoundary = certificateYearOffset(expiry, Number(renewed.slice(0, 4)) - Number(expiry.slice(0, 4)) - 1);
        create('annual_renewal', year, nextDay(priorBoundary), renewed);
      } else if (isHyattSpendCertificate(b)) {
        const existing = new Set((readAwards.all(b.id, 'hyatt_spend') as CertificateAward[]).map(a => a.cycle_year));
        const byYear = new Map<number, { cents: number; crossed: string | null }>();
        for (const u of spendFor.all(b.id, today) as { used_on: string; amount_usd: number }[]) {
          if (!isCertificateDate(u.used_on) || !Number.isSafeInteger(Math.round(u.amount_usd * 100))) continue;
          const year = Number(u.used_on.slice(0, 4));
          if (year < 1000 || existing.has(year)) continue;
          const running = byYear.get(year) ?? { cents: 0, crossed: null };
          running.cents += Math.round(u.amount_usd * 100);
          running.crossed = running.cents >= 1_500_000 ? running.crossed ?? u.used_on : null;
          byYear.set(year, running);
        }
        for (const [year, spend] of byYear) {
          // An issuer can post the award after the threshold date. Don't pretend
          // to know its actual issue or expiry; the user can record it on the award.
          const recordedExpiry = isCertificateDate(b.expiration_date) && b.expiration_date.startsWith(`${year}-`)
            ? b.expiration_date : null;
          if (spend.crossed) create('hyatt_spend', year, spend.crossed, recordedExpiry);
        }
      }
    }
  }).immediate();
}
// Build one BenefitProjection per active benefit for the requested year. For
// cadences that repeat within a year (semiannual, quarterly, monthly) we only
// surface the CURRENT period; the UI can drill into history if desired.

// Build per-period history entries for the reference year. Returns one entry
// per period bucket (Q1..Q4, Jan..Dec, H1/H2, or the year itself for
// annual/unlimited/one-time). Each entry marks whether the period was fully
// used, partially used, unused (past periods), or future (period start > today).
function buildPeriodHistory(
  database: Database.Database,
  b: Benefit,
  refYear: number,
  today: Date,
): { period_key: string; period_label: string; value_used_usd: number; uses_count: number; status: 'used' | 'partial' | 'unused' | 'future' }[] {
  const isCurrentYear = refYear === today.getUTCFullYear();
  const todayIso = today.toISOString().slice(0, 10);
  const per_use_fallback = b.value_usd && b.value_usd > 0 ? b.value_usd : 0;
  const uses_max = uses_max_for(b);

  // Determine the anchor date list for the year based on cadence.
  // We build one anchor per period, then compute key+label from that.
  const anchors: string[] = [];
  switch (b.reset_cadence) {
    case 'monthly':
      for (let m = 1; m <= 12; m++) anchors.push(`${refYear}-${String(m).padStart(2, '0')}-15`);
      break;
    case 'quarterly':
      anchors.push(`${refYear}-02-15`, `${refYear}-05-15`, `${refYear}-08-15`, `${refYear}-11-15`);
      break;
    case 'semiannual':
      anchors.push(`${refYear}-03-15`, `${refYear}-09-15`);
      break;
    case 'annual':
    case 'unlimited':
    case 'one_time':
    case 'spend_threshold':
      anchors.push(`${refYear}-06-15`);
      break;
  }

  return anchors.map(anchor => {
    const key = periodKeyFor(b.reset_cadence, anchor);
    const label = periodLabelFor(b.reset_cadence, anchor);

    // For sub-year cadences, usages are period_key tagged.
    // For year-scoped cadences we sum all usages in the year.
    let periodUsages: Usage[];
    if (b.reset_cadence === 'quarterly' || b.reset_cadence === 'semiannual' || b.reset_cadence === 'monthly') {
      periodUsages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND period_key = ?`)
        .all(b.id, key) as Usage[];
    } else {
      // Filter to the reference year for year-scoped cadences.
      periodUsages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND substr(used_on, 1, 4) = ?`)
        .all(b.id, String(refYear)) as Usage[];
    }

    const value_used_usd = periodUsages.reduce((s, u) => s + (u.amount_usd ?? (valueAtDate(b, u.used_on) ?? 0) * (u.quantity ?? 1)), 0);
    const uses_count = periodUsages.reduce((s, u) => s + u.quantity, 0);

    // Period start (used to tell past-vs-future for empty periods).
    const [ay, amStr] = anchor.split('-');
    const anchorYear = parseInt(ay, 10);
    const anchorMonth = parseInt(amStr, 10);
    let periodStartIso: string;
    switch (b.reset_cadence) {
      case 'monthly':
        periodStartIso = `${anchorYear}-${String(anchorMonth).padStart(2, '0')}-01`;
        break;
      case 'quarterly': {
        const q = Math.ceil(anchorMonth / 3);
        periodStartIso = `${anchorYear}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
        break;
      }
      case 'semiannual':
        periodStartIso = `${anchorYear}-${anchorMonth <= 6 ? '01' : '07'}-01`;
        break;
      default:
        periodStartIso = `${anchorYear}-01-01`;
    }
    const isFuture = isCurrentYear && periodStartIso > todayIso;

    // Status resolution mirrors the main projection logic per period.
    let status: 'used' | 'partial' | 'unused' | 'future';
    const periodValue = valueAtDate(b, anchor);
    const per_period_total = uses_max !== null && periodValue !== null ? uses_max * periodValue : null;
    if (b.reset_cadence === 'unlimited') {
      status = uses_count > 0 ? 'used' : (isFuture ? 'future' : 'unused');
    } else if (per_period_total !== null && per_period_total > 0) {
      if (value_used_usd >= per_period_total) status = 'used';
      else if (value_used_usd > 0) status = 'partial';
      else status = isFuture ? 'future' : 'unused';
    } else if (uses_max !== null) {
      if (uses_count >= uses_max) status = 'used';
      else if (uses_count > 0) status = 'partial';
      else status = isFuture ? 'future' : 'unused';
    } else {
      status = uses_count > 0 ? 'used' : (isFuture ? 'future' : 'unused');
    }

    return {
      period_key: key,
      period_label: label,
      value_used_usd,
      uses_count,
      status,
    };
  });
}

// `today` is read through its UTC calendar date. Callers that need the user's
// local date (the expiring-credits list) pass a Date built for that date.
export function computeProjections(database: Database.Database, refYear: number, today: Date = new Date()): BenefitProjection[] {
  const isCurrentYear = refYear === today.getUTCFullYear();
  const anchorDate = isCurrentYear
    ? today.toISOString().slice(0, 10)
    : `${refYear}-06-15`; // mid-year anchor for past/future views
  const todayIso = today.toISOString().slice(0, 10);
  const awards = new Map((database.prepare('SELECT * FROM certificate_awards').all() as CertificateAward[]).map(a => [a.award_id, a]));

  // Skip benefits belonging to cards the user has hidden. Program benefits
  // (card_id IS NULL) are always visible — they aren't card-scoped.
  const benefits = database.prepare(`
    SELECT ${BEN_COLS.split(',').map(c => `b.${c.trim()}`).join(', ')}
    FROM benefits b
    LEFT JOIN cards c ON c.id = b.card_id
    WHERE b.is_active = 1
      AND (b.card_id IS NULL OR c.is_visible = 1)
    ORDER BY b.sort_order, b.title
  `).all() as Benefit[];
  const cardName = new Map<string, string>();
  for (const c of cardsGetAll(database)) cardName.set(c.id, c.name);
  const progName = new Map<string, string>();
  for (const p of programsGetAll(database)) progName.set(p.id, p.name);

  const out: BenefitProjection[] = [];
  for (const b of benefits) {
    const award = awards.get(b.id);
    const omniStay = isOmniStayBenefit(b);
    if (award?.kind === 'omni_stay' || award?.kind === 'annual_renewal') {
      const source = benefitGetById(database, award.source_id);
      const unsupported = award.kind === 'omni_stay'
        ? !source || !isOmniStayBenefit(source) || !qualifyingOmniCheckout(database, award.source_id, award.cycle_year, todayIso)
        : !!source && isOmniStayBenefit(source);
      // Unverified awards from the old renewal rule (or a corrected stay) must
      // not look redeemable. Keep the stored record and any redemption history.
      if (unsupported && !database.prepare('SELECT 1 FROM usages WHERE benefit_id = ? LIMIT 1').get(b.id)) continue;
    }
    const datedAnnual = !award && isAnnualCertificate(b) && isCertificateDate(b.expiration_date);
    const expiry = !omniStay && isCertificateDate(b.expiration_date) ? b.expiration_date : null;
    const annualStart = datedAnnual ? certificateYearOffset(expiry!, -1) : null;
    if (award && (award.starts_on > `${refYear}-12-31`
      || (award.cycle_year !== refYear && expiry !== null && expiry < `${refYear}-01-01`)
      || (expiry === null && award.cycle_year !== refYear
        && !(award.kind === 'omni_stay' && award.cycle_year + 1 === refYear)))) continue;
    if (datedAnnual && (annualStart! >= `${refYear}-12-31` || expiry! < `${refYear}-01-01`)) continue;
    const originalBenefit = { ...b };
    if (b.prerequisite_benefit_id) {
      const parent = benefits.find(p => p.id === b.prerequisite_benefit_id);
      if (parent && isDiamondChoices(parent) && b.is_choice_option === 1) {
        const choices = benefitGetChoices(database, parent.id, refYear);
        const count = choices.filter(id => id === b.id).length;
        b.choice_selected = count > 0 ? 1 : 0;
        if (count > 1 && b.uses_per_period !== null) b.uses_per_period *= count;
      }
    }
    b.value_usd = valueAtDate(b, anchorDate);
    const period_key = periodKeyFor(b.reset_cadence, anchorDate);
    const period_label = periodLabelFor(b.reset_cadence, anchorDate);

    // For year-scoped periods, look at all usages in that year (not just current sub-period)
    let usages: Usage[];
    if (omniStay) {
      usages = (database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND period_key = ?
        AND used_on <= ? AND amount_usd IS NULL ORDER BY used_on DESC, id DESC`).all(b.id, period_key, todayIso) as Usage[])
        .filter(u => isCertificateDate(u.used_on));
    } else if (datedAnnual) {
      usages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ?
        AND used_on > ? AND used_on <= ? ORDER BY used_on DESC, id DESC`).all(b.id, annualStart, expiry) as Usage[];
    } else if (b.reset_cadence === 'unlimited' || b.reset_cadence === 'one_time' || b.reset_cadence === 'spend_threshold') {
      usages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? ORDER BY used_on DESC`).all(b.id) as Usage[];
    } else {
      usages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND period_key = ? ORDER BY used_on DESC`)
        .all(b.id, period_key) as Usage[];
    }

    const uses_max = omniStay ? 1 : uses_max_for(b);
    const rawCount = omniStay ? Number(usages.some(u => u.quantity >= OMNI_STAY_NIGHTS)) : usages.reduce((s, u) => s + u.quantity, 0);
    const uses_count = isMilestone(b) ? Math.min(1, rawCount) : rawCount;
    const expired = (award || b.category === 'free_night' || isCompanionCertificate(b))
      && b.reset_cadence !== 'spend_threshold' && expiry !== null && expiry < todayIso;
    const uses_remaining = uses_max === null ? null : expired ? 0 : Math.max(0, uses_max - uses_count);

    // Per-period dollar burn. If a usage has no amount_usd (single-use toggle),
    // fall back to the benefit's value_usd only when the benefit stores a
    // meaningful per-use dollar value; a zero-value points-based benefit
    // shouldn't inflate value_used_usd.
    const per_use_fallback = b.value_usd && b.value_usd > 0 ? b.value_usd : 0;
    const value_used_usd = usages.reduce((s, u) => s + (u.amount_usd ?? (valueAtDate(originalBenefit, u.used_on) ?? 0) * (u.quantity ?? 1)), 0);
    const total_value = uses_max !== null && b.value_usd !== null ? uses_max * b.value_usd : null;
    const value_remaining_usd = total_value === null ? null : expired ? 0 : Math.max(0, total_value - value_used_usd);

    // ─── Annual (year-scoped) aggregates ───────────────────────────────────
    // For sub-year cadences (quarterly/monthly/semiannual), roll up the entire
    // year of usages plus the annualized cap. For year-scoped cadences use the
    // current-period numbers.
    // Sub-year cadences: value_usd is per-USE, uses_per_period is uses in ONE
    // period (typically 1). Annual value = value_usd × uses_per_period × periodsPerYear.
    const periodsPerYear =
      b.reset_cadence === 'quarterly' ? 4 :
      b.reset_cadence === 'semiannual' ? 2 :
      b.reset_cadence === 'monthly' ? 12 :
      1;

    const yearUsages = (b.reset_cadence === 'quarterly' || b.reset_cadence === 'semiannual' || b.reset_cadence === 'monthly')
      ? database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND substr(used_on, 1, 4) = ? ORDER BY used_on DESC`)
          .all(b.id, String(refYear)) as Usage[]
      : usages;

    const annual_value_used_usd = yearUsages.reduce((s, u) => s + (u.amount_usd ?? (valueAtDate(originalBenefit, u.used_on) ?? 0) * (u.quantity ?? 1)), 0);
    const annual_value_usd = total_value === null ? null
      : b.reset_cadence === 'monthly' && originalBenefit.value_effective_date
        ? Array.from({ length: 12 }, (_, i) => (valueAtDate(originalBenefit, `${refYear}-${String(i + 1).padStart(2, '0')}-01`) ?? 0) * (uses_max ?? 1)).reduce((a, v) => a + v, 0)
        : total_value * periodsPerYear;
    const annual_value_remaining_usd = annual_value_usd === null ? null : expired ? 0 : Math.max(0, annual_value_usd - annual_value_used_usd);

    // ─── Per-period history for the reference year ─────────────────────────
    // For dashboard mini-strips: one entry per period (Q1..Q4, Jan..Dec, H1/H2,
    // or the year itself). Status marks whether the cap was fully used, partial,
    // unused (past periods only), or future (period hasn't started yet).
    const period_history = omniStay ? [] : buildPeriodHistory(database, { ...b, value_usd: originalBenefit.value_usd }, refYear, today);

    // ─── Spend-threshold progress ──────────────────────────────────────────
    // For benefits gated on a spend threshold (e.g. Hilton $30K free night),
    // sum every logged usage amount in the reference year to display progress.
    // uses_max stays 1 for these benefits (they're a single unlock per year).
    let spend_progress_usd: number | null = null;
    if (b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd !== null) {
      const spendUsages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND substr(used_on, 1, 4) = ?`)
        .all(b.id, String(refYear)) as Usage[];
      spend_progress_usd = isHyattSpendCertificate(b)
        ? spendUsages.filter(u => u.used_on <= todayIso).reduce((s, u) => s + Math.round((u.amount_usd ?? 0) * 100), 0) / 100
        : spendUsages.reduce((s, u) => s + (u.amount_usd ?? 0), 0);
    }

    // ─── Status ────────────────────────────────────────────────────────────
    // Status resolution rules:
    //   • unlimited cadence   → 'unlimited' (surfaces on the Ongoing dashboard)
    //   • spend_threshold     → 'exhausted' iff cumulative spend >= threshold,
    //                           'partial' if any spend logged, else 'available'
    //   • dollar-valued benefit (value_usd > 0) → status keys off dollar
    //                           remaining rather than use count, so partial
    //                           $30 on a $50 credit stays 'partial' with $20 left
    //   • otherwise (points-based / status_boost / toggle) → status keys off
    //                           uses_count vs uses_max as before
    let status: BenefitProjection['status'];
    if (expired) {
      status = 'expired';
    } else if (b.reset_cadence === 'unlimited') {
      status = 'unlimited';
    } else if (b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd !== null) {
      if ((spend_progress_usd ?? 0) >= b.spend_threshold_usd) status = 'exhausted';
      else if ((spend_progress_usd ?? 0) > 0) status = 'partial';
      else status = 'available';
    } else if (!omniStay && b.value_usd !== null && b.value_usd > 0 && total_value !== null && total_value > 0) {
      if (value_used_usd >= total_value) status = 'exhausted';
      else if (value_used_usd > 0) status = 'partial';
      else status = 'available';
    } else if (uses_max !== null && uses_count >= uses_max) {
      status = 'exhausted';
    } else if (uses_count > 0) {
      status = 'partial';
    } else {
      status = 'available';
    }

    out.push({
      benefit: b,
      card_name: b.card_id ? cardName.get(b.card_id) ?? null : null,
      program_name: b.program_id ? progName.get(b.program_id) ?? null : null,
      ref_year: refYear,
      period_key,
      period_label,
      uses_max,
      uses_count,
      uses_remaining,
      value_used_usd,
      value_remaining_usd,
      annual_value_usd,
      annual_value_used_usd,
      annual_value_remaining_usd,
      spend_progress_usd,
      period_history,
      status,
      ...(award ? { certificate_kind: award.kind } : {}),
      usages,
      next_reset: datedAnnual ? null : nextResetIso(b.reset_cadence, anchorDate),
    });
  }
  return out;
}

// ─── Refresh (quarterly diff & review) ───────────────────────────────────────

export function refreshGetStatus(database: Database.Database): RefreshStatusInfo {
  const last = database.prepare(`SELECT completed_at FROM refresh_runs WHERE status = 'applied' ORDER BY completed_at DESC LIMIT 1`)
    .get() as { completed_at: string } | undefined;
  const pending = database.prepare(`SELECT id, source_notes FROM refresh_runs WHERE status = 'draft' ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get() as { id: number; source_notes: string | null } | undefined;

  // v1.0.19 fix: a database that has never had a completed refresh run used to
  // anchor "next due" at the Unix epoch (new Date(0) = 1970-01-01), which made
  // every fresh/never-refreshed install show "Next due: 1970-04-01" — always
  // overdue, from the very first launch. Anchor instead on `installed_at`
  // (stamped once at first seed / first migration to this version), so a
  // never-refreshed install is due 3 months after the app was actually
  // installed, not 3 months after the epoch.
  const installedAtRaw = metaGet(database, 'installed_at');
  // SQLite's datetime('now') is UTC without a zone suffix ("2026-11-22 18:00:00").
  const parseUtc = (v: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  const anchor = last ? parseUtc(last.completed_at) : new Date(installedAtRaw ?? Date.now());
  const nextDue = new Date(Number.isNaN(anchor.getTime()) ? Date.now() : anchor.getTime());
  nextDue.setUTCMonth(nextDue.getUTCMonth() + 3);

  let unmatched: RefreshUnmatched[] = [];
  if (pending) {
    try {
      const raw = metaGet(database, `refresh_unmatched:${pending.id}`);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) unmatched = parsed as RefreshUnmatched[];
    } catch { /* ignore malformed meta */ }
  }
  return {
    last_run_at: last?.completed_at ?? null,
    next_due: nextDue.toISOString().slice(0, 10),
    pending_run_id: pending?.id ?? null,
    pending_run_notes: pending?.source_notes ?? null,
    unmatched,
  };
}

type ChangeInput = Omit<RefreshChange, 'id' | 'refresh_run_id' | 'created_at' | 'review_status' | 'review_notes' | 'overwrite_user_edit' | 'target_user_modified'>;

export function refreshStartRun(database: Database.Database, sourceNotes: string, changes: ChangeInput[]): { run_id: number } {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('refreshStartRun requires at least one change');
  const info = database.prepare(`INSERT INTO refresh_runs (source_notes, status) VALUES (?, 'draft')`).run(sourceNotes);
  const runId = Number(info.lastInsertRowid);
  const ins = database.prepare(`
    INSERT INTO refresh_changes (refresh_run_id, change_type, card_id, program_id, benefit_id, points_currency_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = database.transaction((rows: ChangeInput[]) => {
    for (const c of rows) {
      ins.run(runId, c.change_type, c.card_id, c.program_id, c.benefit_id, c.points_currency_id ?? null, c.before_json, c.after_json);
    }
  });
  tx(changes);
  return { run_id: runId };
}

const REFRESH_CHANGE_SELECT = `
  SELECT c.id, c.refresh_run_id, c.change_type, c.card_id, c.program_id, c.benefit_id, c.points_currency_id,
         c.before_json, c.after_json, c.review_status, c.review_notes, c.created_at, c.overwrite_user_edit,
         COALESCE(b.is_user_modified, pc.is_user_modified, 0) AS target_user_modified
  FROM refresh_changes c
  LEFT JOIN benefits b ON b.id = c.benefit_id
  LEFT JOIN points_currencies pc ON pc.id = c.points_currency_id
`;

export function refreshPendingChanges(database: Database.Database, runId: number): RefreshChange[] {
  return database.prepare(`${REFRESH_CHANGE_SELECT} WHERE c.refresh_run_id = ? ORDER BY c.id ASC`).all(runId) as RefreshChange[];
}
function refreshChangeById(database: Database.Database, id: number): RefreshChange {
  return database.prepare(`${REFRESH_CHANGE_SELECT} WHERE c.id = ?`).get(id) as RefreshChange;
}
/**
 * Approve one change. `overwriteUserEdit` is the user's explicit, per-row
 * consent to replace a benefit they edited by hand; without it such a row is
 * skipped when the run is applied.
 */
export function refreshApproveChange(database: Database.Database, id: number, notes?: string, overwriteUserEdit = false): RefreshChange {
  database.prepare(`UPDATE refresh_changes SET review_status = 'approved', review_notes = ?, overwrite_user_edit = ? WHERE id = ?`)
    .run(notes ?? null, overwriteUserEdit === true ? 1 : 0, id);
  return refreshChangeById(database, id);
}
export function refreshRejectChange(database: Database.Database, id: number, notes?: string): RefreshChange {
  database.prepare(`UPDATE refresh_changes SET review_status = 'rejected', review_notes = ?, overwrite_user_edit = 0 WHERE id = ?`)
    .run(notes ?? null, id);
  return refreshChangeById(database, id);
}

// Benefit columns a refresh may write. Nullable ones can be cleared by an
// explicit null in after_json; the rest ignore null (keep the current value).
const REFRESH_BENEFIT_COLS: Record<string, boolean /* nullable */> = {
  title: false, category: false, reset_cadence: false,
  description: true, uses_per_period: true, value_usd: true, spend_threshold_usd: true,
  expiration_note: true, reset_years: true, multiplier_rate: true, multiplier_currency: true,
  spend_category: true, spend_category_note: true, previous_value_usd: true,
  value_effective_date: true, source_url: true, notes: true,
};
const REFRESH_CARD_COLS: Record<string, boolean> = {
  name: false, issuer: false, network: false, annual_fee_usd: true, source_url: true, notes: true,
};

/** True when `targetId` is `startId` itself or one of the rows it (transitively) depends on. */
function prerequisiteChainIncludes(database: Database.Database, startId: number, targetId: number): boolean {
  const next = database.prepare('SELECT prerequisite_benefit_id AS p FROM benefits WHERE id = ?');
  let cur: number | null = startId;
  for (let i = 0; cur !== null && i < 200; i++) {
    if (cur === targetId) return true;
    cur = (next.get(cur) as { p: number | null } | undefined)?.p ?? null;
  }
  return cur !== null;   // absurdly long chain: treat as unsafe
}

/**
 * v1.0.29: a refresh change carried in an imported data file may only point at
 * web links. Unsafe links are dropped; the rest of the change is kept.
 */
function cleanChangeLinks(json: string | null | undefined): string | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if ('source_url' in obj) obj.source_url = safeWebLinkOrNull(obj.source_url);
  const meta = obj._meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object' && Array.isArray(meta.sources)) {
    meta.sources = (meta.sources as unknown[]).filter(src =>
      !!src && typeof src === 'object' && safeWebLinkOrNull((src as Record<string, unknown>).url) !== null);
  }
  return JSON.stringify(obj);
}

function parseAfter(json: string | null): { payload: Record<string, unknown>; meta: Record<string, unknown> | null } {
  if (!json) return { payload: {}, meta: null };
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { payload: {}, meta: null };
  const { _meta, ...payload } = parsed as Record<string, unknown>;
  return { payload, meta: _meta && typeof _meta === 'object' ? _meta as Record<string, unknown> : null };
}

/** Build "col = ?" assignments for the whitelisted keys present in payload. */
function refreshAssignments(payload: Record<string, unknown>, cols: Record<string, boolean>): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [col, nullable] of Object.entries(cols)) {
    if (!Object.prototype.hasOwnProperty.call(payload, col)) continue;
    const v = payload[col];
    if (v === undefined) continue;
    if (v === null && !nullable) continue;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') continue;
    sets.push(`${col} = ?`);
    values.push(col === 'source_url' ? safeWebLinkOrNull(v) : v);
  }
  return { sets, values };
}

/** Apply all approved changes in a draft run to the live tables. */
export function refreshApplyRun(database: Database.Database, runId: number): { applied: number; skipped: number } {
  const changes = refreshPendingChanges(database, runId);
  let applied = 0, skipped = 0;
  const isProgramAdd = (c: RefreshChange, meta: Record<string, unknown> | null): boolean =>
    meta?.scope === 'program' && c.change_type === 'added' && !!c.program_id && !c.card_id && !c.benefit_id && !c.points_currency_id;
  const tx = database.transaction(() => {
    // ── New loyalty programs (v1.0.27) ── created first, so that benefits
    // proposed for them in the same run have somewhere to go.
    for (const c of changes) {
      const { payload, meta } = parseAfter(c.after_json);
      if (!isProgramAdd(c, meta) || c.review_status !== 'approved') continue;
      if (!programGetById(database, c.program_id as string)) {
        const p = payload as Record<string, unknown>;
        programCreate(database, {
          id: c.program_id as string,
          name: String(p.name ?? c.program_id),
          program_type: p.program_type as ProgramInput['program_type'],
          source_url: safeWebLinkOrNull(p.source_url),
          notes: typeof p.notes === 'string' ? p.notes : null,
        } as ProgramInput);
      }
      applied++;
    }

    const relink: { benefitId: number; parentTitle: string }[] = [];
    for (const c of changes) {
      const { payload, meta } = parseAfter(c.after_json);
      if (isProgramAdd(c, meta)) { if (c.review_status !== 'approved') skipped++; continue; }
      if (c.review_status !== 'approved') { skipped++; continue; }

      // ── Points currencies ──
      if (c.points_currency_id) {
        if (c.change_type === 'added' && c.after_json) {
          // New points currency proposed by a refresh run (rare — the seed list
          // already covers all currencies relevant to the tracked cards/programs).
          if (!pointsCurrencyGetById(database, c.points_currency_id)) {
            pointsCurrencyCreate(database, { ...(payload as unknown as PointsCurrencyInput), id: c.points_currency_id });
          }
          applied++;
        } else if (c.change_type === 'modified' && c.after_json) {
          // Quarterly points-value update (e.g. new One Mile at a Time cent
          // figures). NEVER overwrite a currency the user has manually edited
          // unless they explicitly approved replacing their edit.
          const cur = pointsCurrencyGetById(database, c.points_currency_id);
          if (!cur) { skipped++; continue; }
          const keepUserFlag = cur.is_user_modified === 1;
          if (keepUserFlag && c.overwrite_user_edit !== 1) { skipped++; continue; }
          const p = payload as Partial<PointsCurrencyInput>;
          database.prepare(`
            UPDATE points_currencies SET
              value_cents_per_point = COALESCE(?, value_cents_per_point),
              source_name = COALESCE(?, source_name),
              source_url = ?,
              notes = ?,
              is_user_modified = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `).run(
            p.value_cents_per_point ?? null,
            p.source_name ?? null,
            p.source_url === undefined ? cur.source_url : safeWebLinkOrNull(p.source_url),
            p.notes ?? cur.notes,
            keepUserFlag ? 1 : 0,
            c.points_currency_id,
          );
          applied++;
        } else {
          skipped++;
        }
        continue;
      }

      // ── Cards (annual fee, name) — v1.0.24 ──
      if (c.change_type === 'modified' && !c.benefit_id && c.card_id && meta?.scope === 'card') {
        const { sets, values } = refreshAssignments(payload, REFRESH_CARD_COLS);
        if (sets.length === 0 || !cardGetById(database, c.card_id)) { skipped++; continue; }
        database.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...values, c.card_id);
        applied++;
        continue;
      }

      // ── Benefits ──
      if (c.change_type === 'added' && c.after_json) {
        // The card or program must exist: a new program that was proposed in
        // this run but not approved (or an owner deleted since) leaves its
        // benefits out rather than failing the whole run.
        const ownerThere = c.card_id ? !!cardGetById(database, c.card_id)
          : c.program_id ? !!programGetById(database, c.program_id) : false;
        if (!ownerThere) { skipped++; continue; }
        const { prerequisite_benefit_title, ...row } = payload as Record<string, unknown>;
        const created = benefitCreate(database, row as unknown as BenefitInput, false);
        if (typeof prerequisite_benefit_title === 'string' && prerequisite_benefit_title) {
          const parent = database.prepare('SELECT id FROM benefits WHERE card_id IS ? AND program_id IS ? AND title = ? ORDER BY is_active DESC, id LIMIT 1')
            .get(created.card_id, created.program_id, prerequisite_benefit_title) as { id: number } | undefined;
          if (parent) database.prepare('UPDATE benefits SET prerequisite_benefit_id = ? WHERE id = ?').run(parent.id, created.id);
        }
        applied++;
      } else if (c.change_type === 'modified' && c.benefit_id && c.after_json) {
        const b = benefitGetById(database, c.benefit_id);
        if (!b) { skipped++; continue; }
        // NEVER overwrite a benefit the user has manually modified, unless the
        // user explicitly approved replacing their edit for this row. Only the
        // fields named in the change are written, so other hand edits (dates,
        // notes, visibility) survive, and the row stays flagged as hand-edited.
        const keepUserFlag = b.is_user_modified === 1;
        if (keepUserFlag && c.overwrite_user_edit !== 1) { skipped++; continue; }
        const { sets, values } = refreshAssignments(payload, REFRESH_BENEFIT_COLS);
        // v1.0.27: a change may move the row under another benefit of the same
        // card or program, named by title (e.g. a new first milestone level).
        // The link is made after every change in the run has been applied, so
        // that it can point at a row this same run adds.
        const parentTitle = (payload as Record<string, unknown>).prerequisite_benefit_title;
        const wantsLink = typeof parentTitle === 'string' && parentTitle.trim() !== '';
        if (sets.length === 0 && !wantsLink) { skipped++; continue; }
        if (sets.length > 0) {
          database.prepare(`
            UPDATE benefits SET ${sets.join(', ')}, is_user_modified = ?, updated_at = datetime('now') WHERE id = ?
          `).run(...values, keepUserFlag ? 1 : 0, c.benefit_id);
        }
        if (wantsLink) relink.push({ benefitId: c.benefit_id, parentTitle: parentTitle as string });
        applied++;
      } else if (c.change_type === 'removed' && c.benefit_id) {
        // Removed benefits are deactivated (soft-delete). Preserves usage history.
        // A hand-edited benefit is only retired with the same explicit consent
        // that replacing its text would need.
        const b = benefitGetById(database, c.benefit_id);
        if (!b) { skipped++; continue; }
        if (b.is_user_modified === 1 && c.overwrite_user_edit !== 1) { skipped++; continue; }
        database.prepare(`UPDATE benefits SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(c.benefit_id);
        applied++;
      } else {
        skipped++;
      }
    }
    // Links requested by modified rows. Left as they are if the row to hang
    // under does not exist (its own addition was rejected), has been retired,
    // or the move would make a loop.
    for (const { benefitId, parentTitle } of relink) {
      const b = benefitGetById(database, benefitId);
      if (!b) continue;
      const parent = database.prepare(`
        SELECT id FROM benefits
        WHERE card_id IS ? AND program_id IS ? AND is_active = 1 AND id <> ? AND lower(trim(title)) = lower(trim(?))
        ORDER BY id LIMIT 1
      `).get(b.card_id, b.program_id, b.id, parentTitle) as { id: number } | undefined;
      if (!parent || prerequisiteChainIncludes(database, parent.id, b.id)) continue;
      database.prepare(`UPDATE benefits SET prerequisite_benefit_id = ?, updated_at = datetime('now') WHERE id = ?`).run(parent.id, b.id);
    }
    database.prepare(`UPDATE refresh_runs SET status = 'applied', completed_at = datetime('now') WHERE id = ?`).run(runId);
    database.prepare(`DELETE FROM app_meta WHERE key = ?`).run(`refresh_unmatched:${runId}`);
  });
  tx();
  return { applied, skipped };
}

export function refreshDiscardRun(database: Database.Database, runId: number): void {
  database.prepare(`UPDATE refresh_runs SET status = 'discarded', completed_at = datetime('now') WHERE id = ?`).run(runId);
  database.prepare(`DELETE FROM app_meta WHERE key = ?`).run(`refresh_unmatched:${runId}`);
}

// ─── File payloads ───────────────────────────────────────────────────────────

export function buildFilePayload(database: Database.Database): AppFilePayload {
  return {
    seed_version: metaGet(database, 'seed_version') ?? '1.0.20',
    benefit_choices: database.prepare('SELECT * FROM benefit_choices').all() as NonNullable<AppFilePayload['benefit_choices']>,
    certificate_awards: database.prepare('SELECT * FROM certificate_awards').all() as CertificateAward[],
    version: APP_FILE_VERSION,
    exported_at: new Date().toISOString(),
    cards:            cardsGetAll(database),
    programs:         programsGetAll(database),
    benefits:         benefitsGetAll(database),
    usages:           database.prepare(`SELECT ${USE_COLS} FROM usages ORDER BY used_on`).all() as Usage[],
    refresh_runs:     database.prepare(`SELECT id, started_at, completed_at, source_notes, status FROM refresh_runs`).all() as RefreshRun[],
    refresh_changes:  database.prepare(`SELECT * FROM refresh_changes`).all() as RefreshChange[],
    points_currencies: pointsCurrenciesGetAll(database),
  };
}

export function importFilePayload(database: Database.Database, payload: AppFilePayload): void {
  if (!payload || typeof payload !== 'object' || payload.version !== APP_FILE_VERSION) {
    throw new Error(`Unsupported file version: ${payload?.version}`);
  }
  if (payload.certificate_awards !== undefined && !Array.isArray(payload.certificate_awards)) {
    throw new Error('Invalid certificate awards list');
  }
  const tx = database.transaction(() => {
    database.exec(`
      DELETE FROM refresh_changes; DELETE FROM refresh_runs;
      DELETE FROM benefit_choices;
      DELETE FROM certificate_awards;
      DELETE FROM usages; DELETE FROM benefits;
      DELETE FROM programs; DELETE FROM cards; DELETE FROM points_currencies;
    `);
    const insCard = database.prepare(`
      INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active, is_visible, color_hex, notes, source_url, created_at)
      VALUES (@id, @name, @issuer, @network, @annual_fee_usd, @is_active, @is_visible, @color_hex, @notes, @source_url, @created_at)
    `);
    for (const c of payload.cards) insCard.run({ ...c, is_visible: c.is_visible ?? 1, source_url: safeWebLinkOrNull(c.source_url) });
    const insProg = database.prepare(`
      INSERT INTO programs (id, name, program_type, is_active, notes, source_url, created_at)
      VALUES (@id, @name, @program_type, @is_active, @notes, @source_url, @created_at)
    `);
    for (const p of payload.programs) insProg.run({ ...p, source_url: safeWebLinkOrNull(p.source_url) });
    const insBen = database.prepare(`
      INSERT INTO benefits (id, card_id, program_id, title, description, category, reset_cadence,
        uses_per_period, value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
        multiplier_rate, multiplier_currency, spend_category, spend_category_note,
        prerequisite_benefit_id, is_choice_option, choice_selected, is_active, sort_order,
        source_url, notes, is_user_modified, created_at, updated_at, is_hidden, previous_value_usd, value_effective_date)
      VALUES (@id, @card_id, @program_id, @title, @description, @category, @reset_cadence,
        @uses_per_period, @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
        @multiplier_rate, @multiplier_currency, @spend_category, @spend_category_note,
        @prerequisite_benefit_id, @is_choice_option, @choice_selected, @is_active, @sort_order,
        @source_url, @notes, @is_user_modified, @created_at, @updated_at, @is_hidden, @previous_value_usd, @value_effective_date)
    `);
    for (const b of payload.benefits) {
      validateBenefitDates(b);
      insBen.run({
      ...b,
      is_hidden: b.is_hidden ?? 0,
      source_url: safeWebLinkOrNull(b.source_url),
      previous_value_usd: b.previous_value_usd ?? null,
      value_effective_date: b.value_effective_date ?? null,
      expiration_date: b.expiration_date ?? null,
      reset_years: b.reset_years ?? null,
      multiplier_rate: b.multiplier_rate ?? null,
      multiplier_currency: b.multiplier_currency ?? null,
      spend_category: b.spend_category ?? null,
      spend_category_note: b.spend_category_note ?? null,
      prerequisite_benefit_id: b.prerequisite_benefit_id ?? null,
      });
    }
    const insUse = database.prepare(`
      INSERT INTO usages (id, benefit_id, used_on, amount_usd, period_key, notes, created_at, quantity)
      VALUES (@id, @benefit_id, @used_on, @amount_usd, @period_key, @notes, @created_at, @quantity)
    `);
    for (const u of payload.usages) {
      requireIsoDate('used_on', u.used_on);
      insUse.run({ ...u, quantity: validateQuantity(u.quantity ?? 1) });
    }
    for (const c of payload.benefit_choices ?? []) {
      benefitSetChoices(database, c.parent_id, c.ref_year, JSON.parse(c.selections_json), false);
    }
    const insertAward = database.prepare('INSERT INTO certificate_awards (source_id, award_id, cycle_year, starts_on, kind) VALUES (?, ?, ?, ?, ?)');
    const awardIds = new Set((payload.certificate_awards ?? []).map(a => a?.award_id));
    for (const a of payload.certificate_awards ?? []) {
      if (!a || !Number.isSafeInteger(a.source_id) || !Number.isSafeInteger(a.award_id) || !Number.isInteger(a.cycle_year)
        || awardIds.has(a.source_id) || !isCertificateDate(a.starts_on)
        || (a.kind !== 'annual_renewal' && a.kind !== 'hyatt_spend' && a.kind !== 'omni_stay')) throw new Error('Invalid certificate award');
      const source = benefitGetById(database, a.source_id);
      const award = benefitGetById(database, a.award_id);
      if (!source?.card_id || !award || source.card_id !== award.card_id) throw new Error('Certificate award must match its source card');
      if (a.kind === 'omni_stay' && (!isOmniStayBenefit(source) || award.category !== 'free_night'
        || award.reset_cadence !== 'one_time' || Number(a.starts_on.slice(0, 4)) !== a.cycle_year)) {
        throw new Error('Invalid Omni stay award');
      }
      insertAward.run(a.source_id, a.award_id, a.cycle_year, a.starts_on, a.kind);
    }
    const insRun = database.prepare(`
      INSERT INTO refresh_runs (id, started_at, completed_at, source_notes, status)
      VALUES (@id, @started_at, @completed_at, @source_notes, @status)
    `);
    for (const r of payload.refresh_runs) insRun.run(r);
    const insCh = database.prepare(`
      INSERT INTO refresh_changes (id, refresh_run_id, change_type, card_id, program_id, benefit_id,
        points_currency_id, before_json, after_json, review_status, review_notes, created_at, overwrite_user_edit)
      VALUES (@id, @refresh_run_id, @change_type, @card_id, @program_id, @benefit_id,
        @points_currency_id, @before_json, @after_json, @review_status, @review_notes, @created_at, @overwrite_user_edit)
    `);
    for (const c of payload.refresh_changes) {
      insCh.run({ ...c, points_currency_id: c.points_currency_id ?? null, overwrite_user_edit: c.overwrite_user_edit === 1 ? 1 : 0, after_json: cleanChangeLinks(c.after_json) });
    }
    const insPc = database.prepare(`
      INSERT INTO points_currencies (id, name, currency_type, value_cents_per_point, source_name,
        source_url, notes, is_active, is_user_modified, updated_at, created_at)
      VALUES (@id, @name, @currency_type, @value_cents_per_point, @source_name,
        @source_url, @notes, @is_active, @is_user_modified, @updated_at, @created_at)
    `);
    for (const pc of (payload.points_currencies ?? [])) insPc.run({ ...pc, source_url: safeWebLinkOrNull(pc.source_url) });
    if (!payload.seed_version || parseVersion(payload.seed_version)[2] < 20) migrateRelease20(database);
    metaSet(database, 'seed_version', '1.0.20');
  });
  tx();
}
