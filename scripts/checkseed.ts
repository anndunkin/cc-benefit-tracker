import { seededDb } from '../tests/helpers';
import { cardsGetAll, programsGetAll, benefitsGetAll } from '../electron/database';
const db = seededDb();
console.log('cards:', cardsGetAll(db).length);
console.log('programs:', programsGetAll(db).length);
console.log('benefits:', benefitsGetAll(db).length);
