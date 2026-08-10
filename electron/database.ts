import Database from 'better-sqlite3';
import path from 'path';
import type {
  Card, CardInput, Program, ProgramInput,
  Benefit, BenefitInput, Usage, UsageInput,
  BenefitProjection, RefreshChange, RefreshRun, RefreshChangeType,
  AppFilePayload, ResetCadence, CardNetwork,
} from './types';
import { APP_FILE_VERSION } from './types';
import { periodKeyFor, periodLabelFor, nextResetIso, uses_max_for } from './periods';
import { SEED_CARDS, SEED_PROGRAMS, SEED_BENEFITS } from './benefitsSeed';

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

export function openDatabaseAt(dbPath: string): Database.Database {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seedIfFresh(db);
  applyDataMigrations(db);
  return db;
}

/** For tests: inject an in-memory database. */
export function setDatabase(testDb: Database.Database): void {
  db = testDb;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

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
      before_json TEXT,
      after_json TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','rejected')),
      review_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function metaGet(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function metaSet(database: Database.Database, key: string, value: string): void {
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
export function seedIfFresh(database: Database.Database): void {
  const cardCount = (database.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
  if (cardCount > 0) return;

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
      is_choice_option, sort_order, source_url, notes
    ) VALUES (
      @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
      @value_usd, @spend_threshold_usd, @expiration_note, @expiration_date, @reset_years,
      @is_choice_option, @sort_order, @source_url, @notes
    )
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
      card_id: b.card_id ?? null,
      program_id: b.program_id ?? null,
      description: b.description ?? null,
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
      title: b.title,
      category: b.category,
      reset_cadence: b.reset_cadence,
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

  metaSet(database, 'seed_version', '1.0.12');
  metaSet(database, 'last_refresh_check', new Date().toISOString());
}

export function applyDataMigrations(database: Database.Database): { migrations_run: string[] } {
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

function ensureUniqueId(database: Database.Database, table: 'cards' | 'programs', base: string): string {
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
    input.source_url ?? null,
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
    source_url: patch.source_url ?? current.source_url,
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
    input.source_url ?? null,
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
    source_url: patch.source_url ?? current.source_url,
  });
  return programGetById(database, id)!;
}
export function programDelete(database: Database.Database, id: string): void {
  database.prepare('DELETE FROM programs WHERE id = ?').run(id);
}

// ─── Benefits CRUD ───────────────────────────────────────────────────────────

const BEN_COLS = `id, card_id, program_id, title, description, category, reset_cadence,
  uses_per_period, value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
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
  if ((input.card_id && input.program_id) || (!input.card_id && !input.program_id)) {
    throw new Error('Benefit must belong to exactly one card or program');
  }
  const info = database.prepare(`
    INSERT INTO benefits (
      card_id, program_id, title, description, category, reset_cadence, uses_per_period,
      value_usd, spend_threshold_usd, expiration_note, expiration_date, reset_years,
      is_choice_option, choice_selected,
      is_active, sort_order, source_url,
      notes, is_user_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.is_choice_option ?? 0,
    input.choice_selected ?? 0,
    input.is_active ?? 1,
    input.sort_order ?? 0,
    input.source_url ?? null,
    input.notes ?? null,
    markUserModified ? 1 : 0,
  );
  return benefitGetById(database, Number(info.lastInsertRowid))!;
}
export function benefitUpdate(database: Database.Database, id: number, patch: Partial<BenefitInput>): Benefit {
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
      reset_years = @reset_years,
      is_choice_option = COALESCE(@is_choice_option, is_choice_option),
      choice_selected = COALESCE(@choice_selected, choice_selected),
      is_active = COALESCE(@is_active, is_active),
      sort_order = COALESCE(@sort_order, sort_order),
      source_url = @source_url,
      notes = @notes,
      is_user_modified = 1,
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
    expiration_date: patch.expiration_date ?? current.expiration_date,
    reset_years: patch.reset_years ?? current.reset_years,
    is_choice_option: patch.is_choice_option ?? null,
    choice_selected: patch.choice_selected ?? null,
    is_active: patch.is_active ?? null,
    sort_order: patch.sort_order ?? null,
    source_url: patch.source_url ?? current.source_url,
    notes: patch.notes ?? current.notes,
  });
  return benefitGetById(database, id)!;
}
export function benefitDelete(database: Database.Database, id: number): void {
  database.prepare('DELETE FROM benefits WHERE id = ?').run(id);
}

// ─── Usages CRUD ─────────────────────────────────────────────────────────────

const USE_COLS = 'id, benefit_id, used_on, amount_usd, period_key, notes, created_at';

export function usagesForBenefit(database: Database.Database, benefitId: number): Usage[] {
  return database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? ORDER BY used_on DESC, id DESC`).all(benefitId) as Usage[];
}
export function usageCreate(database: Database.Database, input: UsageInput): Usage {
  if (!Number.isInteger(input.benefit_id) || input.benefit_id <= 0) throw new Error('benefit_id is required');
  requireDate('used_on', input.used_on);
  const benefit = benefitGetById(database, input.benefit_id);
  if (!benefit) throw new Error(`Benefit ${input.benefit_id} not found`);
  const period_key = periodKeyFor(benefit.reset_cadence, input.used_on);
  const info = database.prepare(`
    INSERT INTO usages (benefit_id, used_on, amount_usd, period_key, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.benefit_id, input.used_on, input.amount_usd ?? null, period_key, input.notes ?? null);
  return (database.prepare(`SELECT ${USE_COLS} FROM usages WHERE id = ?`).get(Number(info.lastInsertRowid)) as Usage);
}
export function usageUpdate(database: Database.Database, id: number, patch: Partial<UsageInput>): Usage {
  const current = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE id = ?`).get(id) as Usage | undefined;
  if (!current) throw new Error(`Usage ${id} not found`);
  const benefit = benefitGetById(database, current.benefit_id);
  const used_on = patch.used_on ?? current.used_on;
  const period_key = benefit ? periodKeyFor(benefit.reset_cadence, used_on) : current.period_key;
  database.prepare(`
    UPDATE usages SET
      used_on = @used_on,
      amount_usd = @amount_usd,
      period_key = @period_key,
      notes = @notes
    WHERE id = @id
  `).run({
    id,
    used_on,
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

    const value_used_usd = periodUsages.reduce((s, u) => s + (u.amount_usd ?? per_use_fallback), 0);
    const uses_count = periodUsages.length;

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
    const per_period_total = uses_max !== null && b.value_usd !== null ? uses_max * b.value_usd : null;
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

export function computeProjections(database: Database.Database, refYear: number): BenefitProjection[] {
  const today = new Date();
  const isCurrentYear = refYear === today.getUTCFullYear();
  const anchorDate = isCurrentYear
    ? today.toISOString().slice(0, 10)
    : `${refYear}-06-15`; // mid-year anchor for past/future views

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
    const period_key = periodKeyFor(b.reset_cadence, anchorDate);
    const period_label = periodLabelFor(b.reset_cadence, anchorDate);

    // For year-scoped periods, look at all usages in that year (not just current sub-period)
    let usages: Usage[];
    if (b.reset_cadence === 'unlimited' || b.reset_cadence === 'one_time' || b.reset_cadence === 'spend_threshold') {
      usages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? ORDER BY used_on DESC`).all(b.id) as Usage[];
    } else {
      usages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND period_key = ? ORDER BY used_on DESC`)
        .all(b.id, period_key) as Usage[];
    }

    const uses_max = uses_max_for(b);
    const uses_count = usages.length;
    const uses_remaining = uses_max === null ? null : Math.max(0, uses_max - uses_count);

    // Per-period dollar burn. If a usage has no amount_usd (single-use toggle),
    // fall back to the benefit's value_usd only when the benefit stores a
    // meaningful per-use dollar value; a zero-value points-based benefit
    // shouldn't inflate value_used_usd.
    const per_use_fallback = b.value_usd && b.value_usd > 0 ? b.value_usd : 0;
    const value_used_usd = usages.reduce((s, u) => s + (u.amount_usd ?? per_use_fallback), 0);
    const total_value = uses_max !== null && b.value_usd !== null ? uses_max * b.value_usd : null;
    const value_remaining_usd = total_value === null ? null : Math.max(0, total_value - value_used_usd);

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

    const annual_value_used_usd = yearUsages.reduce((s, u) => s + (u.amount_usd ?? per_use_fallback), 0);
    const annual_value_usd = total_value === null ? null : total_value * periodsPerYear;
    const annual_value_remaining_usd = annual_value_usd === null ? null : Math.max(0, annual_value_usd - annual_value_used_usd);

    // ─── Per-period history for the reference year ─────────────────────────
    // For dashboard mini-strips: one entry per period (Q1..Q4, Jan..Dec, H1/H2,
    // or the year itself). Status marks whether the cap was fully used, partial,
    // unused (past periods only), or future (period hasn't started yet).
    const period_history = buildPeriodHistory(database, b, refYear, today);

    // ─── Spend-threshold progress ──────────────────────────────────────────
    // For benefits gated on a spend threshold (e.g. Hilton $30K free night),
    // sum every logged usage amount in the reference year to display progress.
    // uses_max stays 1 for these benefits (they're a single unlock per year).
    let spend_progress_usd: number | null = null;
    if (b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd !== null) {
      const spendUsages = database.prepare(`SELECT ${USE_COLS} FROM usages WHERE benefit_id = ? AND substr(used_on, 1, 4) = ?`)
        .all(b.id, String(refYear)) as Usage[];
      spend_progress_usd = spendUsages.reduce((s, u) => s + (u.amount_usd ?? 0), 0);
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
    if (b.reset_cadence === 'unlimited') {
      status = 'unlimited';
    } else if (b.reset_cadence === 'spend_threshold' && b.spend_threshold_usd !== null) {
      if ((spend_progress_usd ?? 0) >= b.spend_threshold_usd) status = 'exhausted';
      else if ((spend_progress_usd ?? 0) > 0) status = 'partial';
      else status = 'available';
    } else if (b.value_usd !== null && b.value_usd > 0 && total_value !== null && total_value > 0) {
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
      usages,
      next_reset: nextResetIso(b.reset_cadence, anchorDate),
    });
  }
  return out;
}

// ─── Refresh (quarterly diff & review) ───────────────────────────────────────

export function refreshGetStatus(database: Database.Database): { last_run_at: string | null; next_due: string; pending_run_id: number | null } {
  const last = database.prepare(`SELECT completed_at FROM refresh_runs WHERE status = 'applied' ORDER BY completed_at DESC LIMIT 1`)
    .get() as { completed_at: string } | undefined;
  const pending = database.prepare(`SELECT id FROM refresh_runs WHERE status = 'draft' ORDER BY started_at DESC LIMIT 1`)
    .get() as { id: number } | undefined;

  const lastDate = last ? new Date(last.completed_at) : new Date(0);
  const nextDue = new Date(lastDate);
  nextDue.setUTCMonth(nextDue.getUTCMonth() + 3);
  return {
    last_run_at: last?.completed_at ?? null,
    next_due: nextDue.toISOString().slice(0, 10),
    pending_run_id: pending?.id ?? null,
  };
}

type ChangeInput = Omit<RefreshChange, 'id' | 'refresh_run_id' | 'created_at' | 'review_status' | 'review_notes'>;

export function refreshStartRun(database: Database.Database, sourceNotes: string, changes: ChangeInput[]): { run_id: number } {
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('refreshStartRun requires at least one change');
  const info = database.prepare(`INSERT INTO refresh_runs (source_notes, status) VALUES (?, 'draft')`).run(sourceNotes);
  const runId = Number(info.lastInsertRowid);
  const ins = database.prepare(`
    INSERT INTO refresh_changes (refresh_run_id, change_type, card_id, program_id, benefit_id, before_json, after_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = database.transaction((rows: ChangeInput[]) => {
    for (const c of rows) {
      ins.run(runId, c.change_type, c.card_id, c.program_id, c.benefit_id, c.before_json, c.after_json);
    }
  });
  tx(changes);
  return { run_id: runId };
}

export function refreshPendingChanges(database: Database.Database, runId: number): RefreshChange[] {
  return database.prepare(`
    SELECT id, refresh_run_id, change_type, card_id, program_id, benefit_id,
           before_json, after_json, review_status, review_notes, created_at
    FROM refresh_changes WHERE refresh_run_id = ? ORDER BY id ASC
  `).all(runId) as RefreshChange[];
}
export function refreshApproveChange(database: Database.Database, id: number, notes?: string): RefreshChange {
  database.prepare(`UPDATE refresh_changes SET review_status = 'approved', review_notes = ? WHERE id = ?`)
    .run(notes ?? null, id);
  return database.prepare(`SELECT * FROM refresh_changes WHERE id = ?`).get(id) as RefreshChange;
}
export function refreshRejectChange(database: Database.Database, id: number, notes?: string): RefreshChange {
  database.prepare(`UPDATE refresh_changes SET review_status = 'rejected', review_notes = ? WHERE id = ?`)
    .run(notes ?? null, id);
  return database.prepare(`SELECT * FROM refresh_changes WHERE id = ?`).get(id) as RefreshChange;
}

/** Apply all approved changes in a draft run to the live tables. */
export function refreshApplyRun(database: Database.Database, runId: number): { applied: number; skipped: number } {
  const changes = refreshPendingChanges(database, runId);
  let applied = 0, skipped = 0;
  const tx = database.transaction(() => {
    for (const c of changes) {
      if (c.review_status !== 'approved') { skipped++; continue; }
      // NEVER overwrite a benefit the user has manually modified.
      if (c.change_type === 'modified' && c.benefit_id) {
        const cur = benefitGetById(database, c.benefit_id);
        if (cur && cur.is_user_modified === 1) { skipped++; continue; }
      }
      if (c.change_type === 'added' && c.after_json) {
        const payload = JSON.parse(c.after_json) as BenefitInput;
        benefitCreate(database, payload, false);
        applied++;
      } else if (c.change_type === 'modified' && c.benefit_id && c.after_json) {
        const payload = JSON.parse(c.after_json) as Partial<BenefitInput>;
        // Use raw UPDATE to leave is_user_modified = 0 (refresh-applied, not user edit).
        const b = benefitGetById(database, c.benefit_id);
        if (!b) { skipped++; continue; }
        database.prepare(`
          UPDATE benefits SET
            title = COALESCE(?, title),
            description = ?,
            category = COALESCE(?, category),
            reset_cadence = COALESCE(?, reset_cadence),
            uses_per_period = ?,
            value_usd = ?,
            spend_threshold_usd = ?,
            expiration_note = ?,
            source_url = ?,
            notes = ?,
            is_user_modified = 0,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          payload.title ?? null,
          payload.description ?? b.description,
          payload.category ?? null,
          payload.reset_cadence ?? null,
          payload.uses_per_period ?? b.uses_per_period,
          payload.value_usd ?? b.value_usd,
          payload.spend_threshold_usd ?? b.spend_threshold_usd,
          payload.expiration_note ?? b.expiration_note,
          payload.source_url ?? b.source_url,
          payload.notes ?? b.notes,
          c.benefit_id,
        );
        applied++;
      } else if (c.change_type === 'removed' && c.benefit_id) {
        // Removed benefits are deactivated (soft-delete). Preserves usage history.
        database.prepare(`UPDATE benefits SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(c.benefit_id);
        applied++;
      } else {
        skipped++;
      }
    }
    database.prepare(`UPDATE refresh_runs SET status = 'applied', completed_at = datetime('now') WHERE id = ?`).run(runId);
  });
  tx();
  return { applied, skipped };
}

export function refreshDiscardRun(database: Database.Database, runId: number): void {
  database.prepare(`UPDATE refresh_runs SET status = 'discarded', completed_at = datetime('now') WHERE id = ?`).run(runId);
}

// ─── File payloads ───────────────────────────────────────────────────────────

export function buildFilePayload(database: Database.Database): AppFilePayload {
  return {
    version: APP_FILE_VERSION,
    exported_at: new Date().toISOString(),
    cards:           cardsGetAll(database),
    programs:        programsGetAll(database),
    benefits:        benefitsGetAll(database),
    usages:          database.prepare(`SELECT ${USE_COLS} FROM usages ORDER BY used_on`).all() as Usage[],
    refresh_runs:    database.prepare(`SELECT id, started_at, completed_at, source_notes, status FROM refresh_runs`).all() as RefreshRun[],
    refresh_changes: database.prepare(`SELECT * FROM refresh_changes`).all() as RefreshChange[],
  };
}

export function importFilePayload(database: Database.Database, payload: AppFilePayload): void {
  if (!payload || typeof payload !== 'object' || payload.version !== APP_FILE_VERSION) {
    throw new Error(`Unsupported file version: ${payload?.version}`);
  }
  const tx = database.transaction(() => {
    database.exec(`
      DELETE FROM refresh_changes; DELETE FROM refresh_runs;
      DELETE FROM usages; DELETE FROM benefits;
      DELETE FROM programs; DELETE FROM cards;
    `);
    const insCard = database.prepare(`
      INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active, color_hex, notes, source_url, created_at)
      VALUES (@id, @name, @issuer, @network, @annual_fee_usd, @is_active, @color_hex, @notes, @source_url, @created_at)
    `);
    for (const c of payload.cards) insCard.run(c);
    const insProg = database.prepare(`
      INSERT INTO programs (id, name, program_type, is_active, notes, source_url, created_at)
      VALUES (@id, @name, @program_type, @is_active, @notes, @source_url, @created_at)
    `);
    for (const p of payload.programs) insProg.run(p);
    const insBen = database.prepare(`
      INSERT INTO benefits (id, card_id, program_id, title, description, category, reset_cadence,
        uses_per_period, value_usd, spend_threshold_usd, expiration_note, is_active, sort_order,
        source_url, notes, is_user_modified, created_at, updated_at)
      VALUES (@id, @card_id, @program_id, @title, @description, @category, @reset_cadence,
        @uses_per_period, @value_usd, @spend_threshold_usd, @expiration_note, @is_active, @sort_order,
        @source_url, @notes, @is_user_modified, @created_at, @updated_at)
    `);
    for (const b of payload.benefits) insBen.run(b);
    const insUse = database.prepare(`
      INSERT INTO usages (id, benefit_id, used_on, amount_usd, period_key, notes, created_at)
      VALUES (@id, @benefit_id, @used_on, @amount_usd, @period_key, @notes, @created_at)
    `);
    for (const u of payload.usages) insUse.run(u);
    const insRun = database.prepare(`
      INSERT INTO refresh_runs (id, started_at, completed_at, source_notes, status)
      VALUES (@id, @started_at, @completed_at, @source_notes, @status)
    `);
    for (const r of payload.refresh_runs) insRun.run(r);
    const insCh = database.prepare(`
      INSERT INTO refresh_changes (id, refresh_run_id, change_type, card_id, program_id, benefit_id,
        before_json, after_json, review_status, review_notes, created_at)
      VALUES (@id, @refresh_run_id, @change_type, @card_id, @program_id, @benefit_id,
        @before_json, @after_json, @review_status, @review_notes, @created_at)
    `);
    for (const c of payload.refresh_changes) insCh.run(c);
  });
  tx();
}
