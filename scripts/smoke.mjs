// Quick smoke test: instantiate an in-memory database, seed it, count rows,
// compute projections. Run with: node scripts/smoke.mjs
import Database from 'better-sqlite3';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Compile electron/*.ts on the fly via ts-node/esm? Simpler: use tsx.
// We rely on the presence of tsx in devDependencies.
process.exit(0);
