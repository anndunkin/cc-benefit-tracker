import type Database from 'better-sqlite3';

/** Additive schema upgrade, also used when opening an older database. */
export function ensureRelease20Schema(db: Database.Database): void {
  for (const [table, fields] of Object.entries({
    benefits: {
      is_hidden: 'INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0,1))',
      previous_value_usd: 'REAL',
      value_effective_date: 'TEXT',
    },
    usages: { quantity: 'INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0 AND quantity <= 1000000)' },
  })) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    for (const [name, type] of Object.entries(fields)) {
      if (!cols.some(c => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS benefit_choices (
    parent_id INTEGER NOT NULL REFERENCES benefits(id) ON DELETE CASCADE,
    ref_year INTEGER NOT NULL,
    selections_json TEXT NOT NULL,
    PRIMARY KEY(parent_id, ref_year)
  )`);
}

export function migrateRelease20(db: Database.Database): void {
  // Merge only Platinum unlimited-access variants. Never touch the separate
  // visit allowance or another card. Preserve all usage and user-entered notes.
  const rows = db.prepare(`SELECT id, title, is_hidden, notes FROM benefits
    WHERE card_id = 'amex_platinum'
      AND (lower(title) LIKE '%sky%club%' OR lower(title) LIKE '%skyclub%')
      AND (lower(title) LIKE '%unlimited%' OR title LIKE '%75,000%' OR title LIKE '%75000%')
    ORDER BY CASE WHEN title LIKE '%Centurion Guest%' THEN 0 ELSE 1 END, id`).all() as
    { id: number; title: string; is_hidden: number; notes: string | null }[];
  if (rows.length > 1) {
    const keep = rows[0];
    for (const old of rows.slice(1)) {
      db.prepare('UPDATE usages SET benefit_id = ? WHERE benefit_id = ?').run(keep.id, old.id);
      db.prepare('UPDATE benefits SET prerequisite_benefit_id = ? WHERE prerequisite_benefit_id = ?').run(keep.id, old.id);
      db.prepare('DELETE FROM benefits WHERE id = ?').run(old.id);
    }
    db.prepare('UPDATE benefits SET notes = ?, is_hidden = ? WHERE id = ?').run(
      [...new Set(rows.map(r => r.notes).filter(Boolean))].join('\n') || null,
      rows.some(r => r.is_hidden) ? 1 : 0, keep.id);
  }
  // Retire the reference card without erasing its historic ledger.
  db.prepare(`UPDATE benefits SET is_active = 0
    WHERE program_id = 'delta_medallion' AND lower(title) = 'medallion tier mqd requirements'`).run();

  // User-requested correction; no unrelated edits or usage dates/amounts change.
  db.prepare(`UPDATE benefits SET title = '$15 Monthly Lyft Credit (effective September 2026)',
    previous_value_usd = 10, value_usd = 15, value_effective_date = '2026-09-01',
    description = 'After 3 eligible Lyft rides in a calendar month, receive a $15 Lyft credit starting September 2026. Earlier months retain the $10 credit.',
    notes = COALESCE(notes || char(10), '') || 'Updated at user request: $15/month effective September 1, 2026; $140 total scheduled credit for 2026.'
    WHERE card_id = 'aa_executive' AND lower(title) LIKE '%lyft%'`).run();
  const lyft = db.prepare(`SELECT id FROM benefits WHERE card_id='aa_executive'
    AND title = '$15 Monthly Lyft Credit (effective September 2026)' ORDER BY id`).all() as { id: number }[];
  for (const old of lyft.slice(1)) {
    db.prepare('UPDATE usages SET benefit_id = ? WHERE benefit_id = ?').run(lyft[0].id, old.id);
    db.prepare('DELETE FROM benefits WHERE id = ?').run(old.id);
  }

  // Preserve legacy choice selections in their own year. Achievement is now
  // independent of the number of reward selections (old usage rows stay intact).
  const parents = db.prepare(`SELECT id FROM benefits WHERE program_id = 'delta_medallion'
    AND title LIKE 'Diamond Medallion Choice Benefits%' AND is_choice_option = 0`).all() as { id: number }[];
  for (const p of parents) {
    const ids = (db.prepare(`SELECT id FROM benefits WHERE prerequisite_benefit_id = ?
      AND is_choice_option = 1 AND choice_selected = 1 ORDER BY sort_order, id`).all(p.id) as { id: number }[]).map(r => r.id);
    db.prepare('INSERT OR IGNORE INTO benefit_choices VALUES (?, ?, ?)').run(p.id, new Date().getUTCFullYear(), JSON.stringify(ids));
  }
}
