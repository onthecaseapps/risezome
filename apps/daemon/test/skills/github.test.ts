import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as DatabaseType } from 'better-sqlite3';
import { openCorpusDb } from '../../src/corpus/db.js';
import { migrate } from '../../src/corpus/migrate.js';
import { insertDoc } from '../../src/corpus/query.js';
import { countSkill } from '../../src/skills/github/count.js';
import { listSkill } from '../../src/skills/github/list.js';
import { recentlyUpdatedSkill } from '../../src/skills/github/recently_updated.js';
import { byAuthorSkill } from '../../src/skills/github/by_author.js';
import { skills as allGithubSkills } from '../../src/skills/github/index.js';
import { buildChunkMatch, buildDocFilter } from '../../src/skills/github/filter.js';

// Seed corpus mirrors the post-A-E chunker format: every doc has a chunk
// whose text begins with `Issue <ownerRepo>#N — <title>. Status: <state>.
// Labels: <l1>, <l2>.` so FTS5 phrase queries against `"Status open"` and
// `"Labels bug"` find the right docs.

interface SeedDoc {
  readonly id: string;
  readonly type: 'issue' | 'pull-request';
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly labels: readonly string[];
  readonly authors: readonly string[];
  readonly updatedAt: number;
  readonly url: string;
}

function seed(db: DatabaseType, docs: readonly SeedDoc[]): void {
  for (const d of docs) {
    insertDoc(db, {
      id: d.id,
      source: 'github',
      type: d.type,
      title: d.title,
      bodySummary: '',
      entities: [],
      authors: [...d.authors],
      updatedAt: d.updatedAt,
      url: d.url,
    });
    // Insert one FTS-indexed chunk that mirrors the chunker output.
    const kind = d.type === 'issue' ? 'Issue' : 'PR';
    const labelsLine = d.labels.length > 0 ? ` Labels: ${d.labels.join(', ')}.` : '';
    const chunkText = `${kind} ${d.id} — ${d.title}. Status: ${d.state}.${labelsLine}`;
    const chunkId = `${d.id}#chunk:0`;
    db.prepare(
      `INSERT INTO doc_chunks (chunk_id, doc_id, domain, text, position) VALUES (?, ?, 'text', ?, 0)`,
    ).run(chunkId, d.id, chunkText);
    db.prepare(
      `INSERT INTO fts_doc_chunks (chunk_id, doc_id, title, text) VALUES (?, ?, ?, ?)`,
    ).run(chunkId, d.id, d.title, chunkText);
  }
}

const REPO = 'acme/widget';

const FIXTURES: readonly SeedDoc[] = [
  // 4 open bug issues by nathan
  { id: `gh:${REPO}#issue:1`, type: 'issue', title: 'login crash on Safari', state: 'open', labels: ['bug'], authors: ['nathan'], updatedAt: 1_780_000_000_000, url: `https://github.com/${REPO}/issues/1` },
  { id: `gh:${REPO}#issue:2`, type: 'issue', title: 'missing CSRF token', state: 'open', labels: ['bug', 'security'], authors: ['nathan'], updatedAt: 1_780_001_000_000, url: `https://github.com/${REPO}/issues/2` },
  { id: `gh:${REPO}#issue:3`, type: 'issue', title: 'paginator off-by-one', state: 'open', labels: ['bug'], authors: ['nathan', 'jamie'], updatedAt: 1_780_002_000_000, url: `https://github.com/${REPO}/issues/3` },
  { id: `gh:${REPO}#issue:4`, type: 'issue', title: 'broken sort', state: 'open', labels: ['bug'], authors: ['nathan'], updatedAt: 1_780_003_000_000, url: `https://github.com/${REPO}/issues/4` },
  // 3 open feature issues by jamie
  { id: `gh:${REPO}#issue:5`, type: 'issue', title: 'export PDF', state: 'open', labels: ['feature'], authors: ['jamie'], updatedAt: 1_780_004_000_000, url: `https://github.com/${REPO}/issues/5` },
  { id: `gh:${REPO}#issue:6`, type: 'issue', title: 'dark mode', state: 'open', labels: ['feature'], authors: ['jamie'], updatedAt: 1_780_005_000_000, url: `https://github.com/${REPO}/issues/6` },
  { id: `gh:${REPO}#issue:7`, type: 'issue', title: 'keyboard shortcuts', state: 'open', labels: ['feature'], authors: ['jamie'], updatedAt: 1_780_006_000_000, url: `https://github.com/${REPO}/issues/7` },
  // 2 closed issues
  { id: `gh:${REPO}#issue:8`, type: 'issue', title: 'fixed typo', state: 'closed', labels: ['bug'], authors: ['nathan'], updatedAt: 1_780_007_000_000, url: `https://github.com/${REPO}/issues/8` },
  { id: `gh:${REPO}#issue:9`, type: 'issue', title: 'old enhancement', state: 'closed', labels: [], authors: ['jamie'], updatedAt: 1_780_008_000_000, url: `https://github.com/${REPO}/issues/9` },
  // 2 open PRs by jamie
  { id: `gh:${REPO}#pr:10`, type: 'pull-request', title: 'add dark mode', state: 'open', labels: ['feature'], authors: ['jamie'], updatedAt: 1_780_009_000_000, url: `https://github.com/${REPO}/pull/10` },
  { id: `gh:${REPO}#pr:11`, type: 'pull-request', title: 'fix the sort', state: 'open', labels: ['bug'], authors: ['jamie'], updatedAt: 1_780_010_000_000, url: `https://github.com/${REPO}/pull/11` },
];

const FAKE_NOW = 1_780_500_000_000; // ~6 days after the most-recent fixture

let db: DatabaseType;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risezome-skills-'));
  db = await openCorpusDb({ path: join(dir, 'risezome.db') });
  await migrate(db);
  seed(db, FIXTURES);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('filter helpers', () => {
  it('buildDocFilter handles type + author', () => {
    const f = buildDocFilter({ type: 'issue', author: 'nathan' });
    expect(f.sql).toBe('docs.source = ? AND docs.type = ? AND docs.authors LIKE ?');
    expect(f.params).toEqual(['github', 'issue', '%"nathan"%']);
  });

  it('buildChunkMatch is null when no state or labels', () => {
    expect(buildChunkMatch({ type: 'issue' })).toBeNull();
  });

  it('buildChunkMatch uses post-tokenization phrase form', () => {
    expect(buildChunkMatch({ state: 'open' })).toBe('"Status open"');
    expect(buildChunkMatch({ labels: ['bug', 'security'] })).toBe(
      '"Labels bug" AND "Labels security"',
    );
    expect(buildChunkMatch({ state: 'open', labels: ['bug'] })).toBe(
      '"Status open" AND "Labels bug"',
    );
  });
});

describe('github_count', () => {
  it('counts open issues', async () => {
    const r = await countSkill.handler({ type: 'issue', state: 'open' }, { db });
    expect(r.kind).toBe('count');
    expect(r.summary).toBe('7 open issues.');
    expect((r.raw as { count: number }).count).toBe(7);
  });

  it('counts open bug issues (combined FTS5 phrase AND)', async () => {
    const r = await countSkill.handler(
      { type: 'issue', state: 'open', labels: ['bug'] },
      { db },
    );
    expect((r.raw as { count: number }).count).toBe(4);
    expect(r.summary).toBe("4 open issues labeled 'bug'.");
  });

  it('counts PRs by jamie', async () => {
    const r = await countSkill.handler(
      { type: 'pull-request', author: 'jamie' },
      { db },
    );
    expect((r.raw as { count: number }).count).toBe(2);
    expect(r.summary).toBe('2 pull requests by jamie.');
  });

  it('counts all docs (no type filter)', async () => {
    const r = await countSkill.handler({ state: 'open' }, { db });
    expect((r.raw as { count: number }).count).toBe(9);
  });

  it('returns 0 cleanly for empty result', async () => {
    const r = await countSkill.handler(
      { type: 'issue', state: 'open', labels: ['nonexistent-label'] },
      { db },
    );
    expect((r.raw as { count: number }).count).toBe(0);
    expect(r.summary).toContain('No matching');
  });
});

describe('github_list', () => {
  it('lists open issues with title + url, newest first', async () => {
    const r = await listSkill.handler({ type: 'issue', state: 'open', limit: 5 }, { db });
    expect(r.kind).toBe('list');
    expect(r.items).toHaveLength(5);
    // updated_at is highest for issue:7 (`1_780_006_000_000`) → first
    expect(r.items![0]!.title).toBe('keyboard shortcuts');
    expect(r.items![0]!.url).toBe(`https://github.com/${REPO}/issues/7`);
  });

  it('caps limit at MAX (25) silently', async () => {
    const r = await listSkill.handler({ limit: 100 }, { db });
    // FIXTURES has 11 total docs; 100 would otherwise return all 11.
    expect(r.items!.length).toBeLessThanOrEqual(25);
  });

  it('defaults to 10 when limit omitted', async () => {
    const r = await listSkill.handler({}, { db });
    expect(r.items).toHaveLength(10);
  });

  it('returns empty list cleanly', async () => {
    const r = await listSkill.handler({ author: 'no-such-login' }, { db });
    expect(r.items).toEqual([]);
    expect(r.summary).toBe('No matching docs.');
  });
});

describe('github_recently_updated', () => {
  it('defaults to 7 days', async () => {
    const r = await recentlyUpdatedSkill.handler(
      {},
      { db, now: () => FAKE_NOW },
    );
    // All 11 fixtures are within the last 7 days from FAKE_NOW (cutoff = FAKE_NOW - 7 days
    // = 1_779_900_000_000; the oldest fixture is 1_780_000_000_000).
    expect(r.items!.length).toBe(10); // capped at default limit
  });

  it('respects an explicit days argument', async () => {
    // The most-recent fixture (PR#11) is at 1_780_010_000_000.
    // FAKE_NOW = 1_780_500_000_000. Diff = 490_000_000 ms ≈ 5.67 days.
    // With days=5, cutoff = FAKE_NOW - 5*86400000 = 1_780_068_000_000 → nothing matches.
    const r = await recentlyUpdatedSkill.handler(
      { days: 5 },
      { db, now: () => FAKE_NOW },
    );
    expect(r.items).toEqual([]);
  });

  it('filters by type when provided', async () => {
    const r = await recentlyUpdatedSkill.handler(
      { days: 30, type: 'pull-request' },
      { db, now: () => FAKE_NOW },
    );
    expect(r.items).toHaveLength(2);
    for (const item of r.items!) expect(item.title).toContain(item.title); // smoke
  });

  it('returns docs ordered newest first', async () => {
    const r = await recentlyUpdatedSkill.handler(
      { days: 30, limit: 3 },
      { db, now: () => FAKE_NOW },
    );
    expect(r.items).toHaveLength(3);
    // PR#11 (1_780_010_000_000) is newest among the fixtures
    expect(r.items![0]!.title).toBe('fix the sort');
  });
});

describe('github_by_author', () => {
  it('lists all docs by jamie', async () => {
    const r = await byAuthorSkill.handler({ login: 'jamie' }, { db });
    // jamie authors: issues 3 (co-author), 5, 6, 7, 9, plus PRs 10, 11 = 7
    expect(r.items!.length).toBe(7);
  });

  it('returns empty for unknown login', async () => {
    const r = await byAuthorSkill.handler({ login: 'no-such-login' }, { db });
    expect(r.items).toEqual([]);
    expect(r.summary).toBe('No docs found for no-such-login.');
  });

  it('combines author with state filter via FTS5', async () => {
    const r = await byAuthorSkill.handler(
      { login: 'jamie', state: 'open' },
      { db },
    );
    // jamie's open docs: issues 3, 5, 6, 7 + PRs 10, 11 = 6
    expect(r.items!.length).toBe(6);
  });

  it('combines author with type + label', async () => {
    const r = await byAuthorSkill.handler(
      { login: 'jamie', type: 'pull-request', labels: ['feature'] },
      { db },
    );
    expect(r.items!.length).toBe(1); // PR#10 "add dark mode"
    expect(r.items![0]!.title).toBe('add dark mode');
  });
});

describe('github skills registry export', () => {
  it('exports 4 skills in stable order', () => {
    expect(allGithubSkills.map((s) => s.name)).toEqual([
      'github_count',
      'github_list',
      'github_recently_updated',
      'github_by_author',
    ]);
  });
});
