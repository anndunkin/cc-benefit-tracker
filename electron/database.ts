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

// ─── Seeding ─────────────────────────────────────────────────────────────────

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
      value_usd, spend_threshold_usd, expiration_note, sort_order, source_url, notes
    ) VALUES (
      @card_id, @program_id, @title, @description, @category, @reset_cadence, @uses_per_period,
      @value_usd, @spend_threshold_usd, @expiration_note, @sort_order, @source_url, @notes
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
      sort_order: b.sort_order ?? 0,
      source_url: b.source_url ?? null,
      notes: b.notes ?? null,
      title: b.title,
      category: b.category,
      reset_cadence: b.reset_cadence,
    });
  });
  tx();

  metaSet(database, 'seed_version', '1.0.3');
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
  const seedVersion = metaGet(database, 'seed_version') ?? '1.0.0';
  if (seedVersion !== '1.0.3') {
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

  return { migrations_run: run };
}

// ─── Cards CRUD ──────────────────────────────────────────────────────────────

const CARD_COLS = 'id, name, issuer, network, annual_fee_usd, is_active, color_hex, notes, source_url, created_at';

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
    INSERT INTO cards (id, name, issuer, network, annual_fee_usd, is_active, color_hex, notes, source_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.name, input.issuer, input.network,
    input.annual_fee_usd ?? null,
    input.is_active ?? 1,
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
    color_hex: patch.color_hex ?? current.color_hex,
    notes: patch.notes ?? current.notes,
    source_url: patch.source_url ?? current.source_url,
  });
  return cardGetById(database, id)!;
}
export function cardDelete(database: Database.Database, id: string): void {
  database.prepare('DELETE FROM cards WHERE id = ?').run(id);
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
  uses_per_period, value_usd, spend_threshold_usd, expiration_note, is_active, sort_order,
  source_url, notes, is_user_modified, created_at, updated_at`;

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
      value_usd, spend_threshold_usd, expiration_note, is_active, sort_order, source_url,
      notes, is_user_modified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export function computeProjections(database: Database.Database, refYear: number): BenefitProjection[] {
  const today = new Date();
  const isCurrentYear = refYear === today.getUTCFullYear();
  const anchorDate = isCurrentYear
    ? today.toISOString().slice(0, 10)
    : `${refYear}-06-15`; // mid-year anchor for past/future views

  const benefits = database.prepare(`SELECT ${BEN_COLS} FROM benefits WHERE is_active = 1 ORDER BY sort_order, title`).all() as Benefit[];
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
