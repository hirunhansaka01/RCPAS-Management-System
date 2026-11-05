import { runMigrations } from './migrate-runner.js';

const { count, skipped, files } = await runMigrations();
console.log(`Applied ${count} idempotent schema statements across ${files} migrations${skipped ? ` (${skipped} already present)` : ''}.`);
process.exit(0);
