import { build } from 'esbuild';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const distDir = path.join(here, 'dist');

const MAX_INITIAL_BUNDLE_BYTES = 50 * 1024;

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
await copyFile(path.join(srcDir, 'styles.css'), path.join(distDir, 'styles.css'));

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
