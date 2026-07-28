import Database from 'better-sqlite3';
import { initSchema, seedIfFresh } from '../electron/database';

/** A fully seeded in-memory database (cards, programs, benefits). */
export function seededDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  seedIfFresh(db);
  return db;
}

/** An empty schema-only in-memory database (no seed). */
export function emptyDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}
