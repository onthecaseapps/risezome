import { build } from 'esbuild';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const distDir = path.join(here, 'dist');
const execFileAsync = promisify(execFile);

// Ceiling raised from 50 KB to 100 KB once Prism.js was added for syntax
// highlighting. Prism core + the 18 grammars we ship is ~65 KB on its own;
// keep the cap snug so we notice if we ever balloon further.
const MAX_INITIAL_BUNDLE_BYTES = 100 * 1024;

await mkdir(distDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(srcDir, 'main.ts')],
  outdir: distDir,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: true,
  minify: true,
  loader: { '.ts': 'ts' },
  logLevel: 'info',
  metafile: true,
});

await copyFile(path.join(here, 'index.html'), path.join(distDir, 'index.html'));

// Tailwind v4: compile styles.css (which itself imports tailwindcss via the
// @import directive at its head) into the bundled output CSS. The CLI scans
// the @source-listed paths for utility usage and tree-shakes the rest.
const tailwindBin = path.join(here, 'node_modules', '.bin', 'tailwindcss');
const tailwindOutput = path.join(distDir, 'styles.css');
await execFileAsync(tailwindBin, [
  '-i', path.join(srcDir, 'styles.css'),
  '-o', tailwindOutput,
  '--minify',
]);
const { size: cssSize } = await stat(tailwindOutput);
console.log(`HUD CSS bundle: ${cssSize} bytes.`);

const mainOut = path.join(distDir, 'main.js');
const { size } = await stat(mainOut);
if (size > MAX_INITIAL_BUNDLE_BYTES) {
  console.error(
    `HUD bundle exceeds ${MAX_INITIAL_BUNDLE_BYTES} byte ceiling: ${size} bytes. Fail.`,
  );
  process.exit(1);
}
console.log(`HUD bundle: ${size} bytes (ceiling ${MAX_INITIAL_BUNDLE_BYTES}).`);

void result;
