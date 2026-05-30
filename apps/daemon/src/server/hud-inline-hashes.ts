import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Extracts every inline `<script>...</script>` body from an HTML string
 * (skips tags with `src=`) and returns `sha256-<base64>` strings suitable
 * for the CSP `script-src` directive. Returns in document order; duplicate
 * bodies dedupe to a single hash.
 *
 * The Next.js static export ships several inline scripts: the theme init
 * we own + the framework hydration scripts. All of them need to be in the
 * CSP hash allow-list or the page won't run under strict CSP.
 */
export function computeInlineScriptHashes(html: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
    const body = match[1] ?? '';
    if (seen.has(body)) continue;
    seen.add(body);
    const hash = createHash('sha256').update(body, 'utf8').digest('base64');
    out.push(`sha256-${hash}`);
  }
  return out;
}

/**
 * Reads the HUD static-export directory and returns the union of inline-
 * script hashes across the entry HTML files. Missing files log no error
 * and contribute nothing — a partially-built export still loads what it
 * can, and the daemon at least starts.
 *
 * Scanned files (in priority order):
 *   - index.html              — the home page
 *   - 404.html                — Next's error page
 *   - _not-found/index.html   — the App Router not-found surface
 *
 * If `index.html` is missing entirely the function returns `[]` and the
 * caller should log a clear warning (the page will probably not hydrate
 * under strict CSP, which is the desired failure mode — better than
 * silently loosening the policy).
 */
export async function loadHudInlineScriptHashes(
  hudDist: string,
): Promise<readonly string[]> {
  const candidates = [
    join(hudDist, 'index.html'),
    join(hudDist, '404.html'),
    join(hudDist, '_not-found', 'index.html'),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of candidates) {
    let html: string;
    try {
      html = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    for (const h of computeInlineScriptHashes(html)) {
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}
