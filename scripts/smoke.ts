import Database from 'better-sqlite3';
import { initSchema, seedIfFresh, cardsGetAll, programsGetAll, benefitsGetAll, computeProjections } from '../electron/database';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
initSchema(db);
seedIfFresh(db);
console.log('cards:', cardsGetAll(db).length);
console.log('programs:', programsGetAll(db).length);
console.log('benefits:', benefitsGetAll(db).length);
const proj = computeProjections(db, 2026);
console.log('projections:', proj.length);
const modalitySample = proj.slice(0, 3).map(p => ({ title: p.benefit.title, cadence: p.benefit.reset_cadence, status: p.status, period: p.period_label, uses: `${p.uses_count}/${p.uses_max ?? '∞'}` }));
console.log('sample:', JSON.stringify(modalitySample, null, 2));
