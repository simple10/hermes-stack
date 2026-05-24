/**
 * scripts/build-combined-migrations.mjs
 *
 * Concatenates migrations/master/*.sql and migrations/pool/*.sql into
 * migrations/combined/*.sql in interleaved numeric order.  The combined dir
 * is what wrangler applies in single-DB mode (DB_MODE=single).
 *
 * Run: node scripts/build-combined-migrations.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const masterDir = 'migrations/master';
const poolDir = 'migrations/pool';
const outDir = 'migrations/combined';

mkdirSync(outDir, { recursive: true });

const masterFiles = readdirSync(masterDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let poolFiles = [];
try {
  poolFiles = readdirSync(poolDir).filter((f) => f.endsWith('.sql')).sort();
} catch {
  // no pool dir yet — ok on first run
}

let seq = 1;
for (const f of masterFiles) {
  const out = String(seq).padStart(4, '0') + '_master_' + f.replace(/^\d+_/, '');
  writeFileSync(join(outDir, out), readFileSync(join(masterDir, f), 'utf-8'));
  seq++;
}
for (const f of poolFiles) {
  const out = String(seq).padStart(4, '0') + '_pool_' + f.replace(/^\d+_/, '');
  writeFileSync(join(outDir, out), readFileSync(join(poolDir, f), 'utf-8'));
  seq++;
}
console.log(`Wrote ${seq - 1} combined migrations to ${outDir}/`);
