import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeInlineScriptHashes,
  loadHudInlineScriptHashes,
} from '../../src/server/hud-inline-hashes.js';

function sha256b64(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('base64');
}

describe('computeInlineScriptHashes', () => {
  it('returns an empty array for HTML with no scripts', () => {
    expect(computeInlineScriptHashes('<html><body>hi</body></html>')).toEqual([]);
  });

  it('skips <script src="..."> tags (only inline bodies are hashed)', () => {
    const html = '<head><script src="/foo.js"></script><script src="/bar.js" async=""></script></head>';
    expect(computeInlineScriptHashes(html)).toEqual([]);
  });

  it('hashes one inline script body', () => {
    const body = 'console.log(1)';
    const html = `<head><script>${body}</script></head>`;
    expect(computeInlineScriptHashes(html)).toEqual([`sha256-${sha256b64(body)}`]);
  });

  it('hashes multiple inline scripts in document order, no duplicates', () => {
    const a = "(function(){var x=1;})()";
    const b = 'self.__next_f=self.__next_f||[]';
    const html = `<head><script>${a}</script><script>${b}</script><script>${a}</script></head>`;
    const out = computeInlineScriptHashes(html);
    // Dedupe by exact body — three scripts, but only two unique
    expect(out).toEqual([`sha256-${sha256b64(a)}`, `sha256-${sha256b64(b)}`]);
  });

  it('ignores attributes on the script tag and hashes the body only', () => {
    const body = 'var k = 1;';
    const html = `<script nonce="x" defer>${body}</script>`;
    expect(computeInlineScriptHashes(html)).toEqual([`sha256-${sha256b64(body)}`]);
  });

  it('does not match <scripts> or <scripting> false positives', () => {
    const html = '<scripts>not a script</scripts><scriptlet/>';
    expect(computeInlineScriptHashes(html)).toEqual([]);
  });

  it('handles inline script with > inside a string literal', () => {
    // The regex must use a non-greedy match so it stops at the first
    // </script>, not the first '>'. A real-world payload from Next.js
    // hydration includes JSON with '>' characters.
    const body = 'self.__next_f.push([1,"some>literal"]);';
    const html = `<script>${body}</script>`;
    expect(computeInlineScriptHashes(html)).toEqual([`sha256-${sha256b64(body)}`]);
  });
});

describe('loadHudInlineScriptHashes', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'risezome-hud-hashes-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads index.html and returns its inline-script hashes', async () => {
    const html = '<head><script>var a=1;</script><script src="x.js"></script></head>';
    writeFileSync(join(tmp, 'index.html'), html);
    const hashes = await loadHudInlineScriptHashes(tmp);
    expect(hashes).toEqual([`sha256-${sha256b64('var a=1;')}`]);
  });

  it('returns [] when index.html is missing', async () => {
    const hashes = await loadHudInlineScriptHashes(tmp);
    expect(hashes).toEqual([]);
  });

  it('scans additional siblings (404.html) if present', async () => {
    writeFileSync(join(tmp, 'index.html'), '<script>same()</script>');
    writeFileSync(join(tmp, '404.html'), '<script>different()</script>');
    const hashes = await loadHudInlineScriptHashes(tmp);
    expect(hashes).toContain(`sha256-${sha256b64('same()')}`);
    expect(hashes).toContain(`sha256-${sha256b64('different()')}`);
  });

  it('scans nested _not-found subdirectory', async () => {
    writeFileSync(join(tmp, 'index.html'), '<script>main()</script>');
    mkdirSync(join(tmp, '_not-found'), { recursive: true });
    writeFileSync(join(tmp, '_not-found', 'index.html'), '<script>notfound()</script>');
    const hashes = await loadHudInlineScriptHashes(tmp);
    expect(hashes).toContain(`sha256-${sha256b64('main()')}`);
    expect(hashes).toContain(`sha256-${sha256b64('notfound()')}`);
  });
});
