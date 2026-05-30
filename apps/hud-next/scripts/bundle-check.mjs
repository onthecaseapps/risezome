#!/usr/bin/env node
// Bundle-size guard. Sums gzipped sizes of every .js file under
// `out/_next/static/chunks/` and fails when the total exceeds the budget.
// Runs as part of CI after `next build`.
//
// Budget: 350 KB gzipped (per plan R10). Framework runtime floor on
// Next 16 + React 19 is ~180 KB gzipped; the remaining ~170 KB covers
// the HUD's React components + dynamic-imported Prism + WS hook + reducer.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const chunksDir = join(here, '..', 'out', '_next', 'static', 'chunks');
const BUDGET_BYTES = 350 * 1024;

if (!existsSync(chunksDir)) {
  console.error(`[bundle-check] ${chunksDir} not found — run 'next build' first.`);
  process.exit(1);
}

const files = readdirSync(chunksDir).filter((f) => f.endsWith('.js')).sort();
let totalGz = 0;
const rows = [];
for (const f of files) {
  const buf = readFileSync(join(chunksDir, f));
  const gz = gzipSync(buf).length;
  totalGz += gz;
  rows.push({ name: f, raw: buf.length, gz });
}

console.log('Chunk                                         raw         gz');
console.log('-----                                         ---         --');
for (const row of rows) {
  console.log(
    `${row.name.padEnd(45)} ${String(row.raw).padStart(7)} ${String(row.gz).padStart(10)}`,
  );
}
console.log('-----------------------------------------------------------');
console.log(`TOTAL                                         ${' '.padStart(7)} ${String(totalGz).padStart(10)} bytes`);
console.log(`TOTAL gzipped: ${(totalGz / 1024).toFixed(1)} KB  /  budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB`);

if (totalGz > BUDGET_BYTES) {
  console.error(
    `\n[bundle-check] FAIL: ${(totalGz / 1024).toFixed(1)} KB exceeds budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB.`,
  );
  process.exit(1);
}
console.log('\n[bundle-check] OK.');
