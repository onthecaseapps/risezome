import { describe, expect, it } from 'vitest';
import { GithubClient } from '../../../src/connectors/github/client.js';
import {
  encodeCursor,
  parseCursorSince,
  pullRepoIssuesAndPRs,
} from '../../../src/connectors/github/pull-delta.js';
import type { GithubIssue } from '../../../src/connectors/github/types.js';
import type { AuthResult, ScopeDescriptor } from '../../../src/connectors/contract.js';

const TEST_AUTH: AuthResult = { kind: 'pat', token: 'gh_pat_test' };

function makeScope(repo = 'acme/widget'): ScopeDescriptor {
  return {
    id: repo,
    displayName: repo,
    type: 'github-repo',
  };
}

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    id: 1,
    number: 42,
    title: 'Auth middleware migration',
    state: 'open',
    html_url: 'https://github.com/acme/widget/issues/42',
    body: 'Body of the issue',
    user: { login: 'nathan' },
    assignees: [{ login: 'jamie' }],
    labels: [{ name: 'security' }, { name: 'auth' }],
    created_at: '2026-05-28T12:00:00Z',
    updated_at: '2026-05-28T13:00:00Z',
    ...overrides,
  };
}

function fetchReturning(payload: GithubIssue[]): typeof fetch {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('cursor encode/parse', () => {
  it('round-trips a since timestamp', () => {
    const ts = '2026-05-29T07:00:00Z';
    expect(parseCursorSince(encodeCursor(ts))).toBe(ts);
  });

  it('returns undefined for null or malformed cursors', () => {
    expect(parseCursorSince(null)).toBeUndefined();
    expect(parseCursorSince('garbage')).toBeUndefined();
  });
});

describe('pullRepoIssuesAndPRs', () => {
  it('emits one canonical doc per issue with correct shape', async () => {
    const client = new GithubClient({ fetchImpl: fetchReturning([makeIssue()]) });
    const result = await pullRepoIssuesAndPRs(client, TEST_AUTH, makeScope(), null);

    expect(result.docs).toHaveLength(1);
    const doc = result.docs[0]!;
    expect(doc.id).toBe('gh:acme/widget#issue:42');
    expect(doc.source).toBe('github');
    expect(doc.type).toBe('issue');
    expect(doc.title).toBe('Auth middleware migration');
    expect(doc.url).toBe('https://github.com/acme/widget/issues/42');
    expect(doc.authors).toEqual(['nathan', 'jamie']);
    expect(doc.provenance).toBe('untrusted');
    expect(doc.entities).toContain('acme/widget#42');
    expect(doc.updatedAt).toBe(Date.parse('2026-05-28T13:00:00Z'));
  });

  it('classifies pull requests with type=pull-request and prefix=pr', async () => {
    const client = new GithubClient({
      fetchImpl: fetchReturning([
        makeIssue({
          number: 4821,
          title: 'Replace JWT middleware',
          pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/4821' },
        }),
      ]),
    });
    const result = await pullRepoIssuesAndPRs(client, TEST_AUTH, makeScope(), null);
    expect(result.docs[0]?.id).toBe('gh:acme/widget#pr:4821');
    expect(result.docs[0]?.type).toBe('pull-request');
  });

  it('emits at least a header chunk per doc plus a body chunk when body is non-empty', async () => {
    const client = new GithubClient({
      fetchImpl: fetchReturning([
        makeIssue({ body: 'Detailed description', number: 1 }),
        makeIssue({ body: null, number: 2 }),
        makeIssue({ body: '   ', number: 3 }),
      ]),
    });
    const result = await pullRepoIssuesAndPRs(client, TEST_AUTH, makeScope(), null);
    expect(result.docs).toHaveLength(3);
    const chunksByDoc = new Map<string, number>();
    for (const c of result.chunks) {
      chunksByDoc.set(c.docId, (chunksByDoc.get(c.docId) ?? 0) + 1);
    }
    expect(chunksByDoc.get('gh:acme/widget#issue:1')).toBe(2);
    expect(chunksByDoc.get('gh:acme/widget#issue:2')).toBe(1);
    expect(chunksByDoc.get('gh:acme/widget#issue:3')).toBe(1);
  });

  it('emits an inline comment chunk per non-empty comment when comments_inline is provided', async () => {
    const client = new GithubClient({
      fetchImpl: fetchReturning([
        makeIssue({
          comments_inline: [
            {
              id: 1,
              user: { login: 'alice' },
              body: 'I think we should...',
              created_at: '2026-05-28T12:30:00Z',
              updated_at: '2026-05-28T12:30:00Z',
            },
            {
              id: 2,
              user: { login: 'bob' },
              body: '',
              created_at: '2026-05-28T12:40:00Z',
              updated_at: '2026-05-28T12:40:00Z',
            },
          ],
        }),
      ]),
    });
    const result = await pullRepoIssuesAndPRs(client, TEST_AUTH, makeScope(), null);
    // After A+B the chunk text starts with the natural-language context line
    // (`Issue acme/widget#N — title. Status: open. Labels: ...`) and the
    // comment body comes after. Locate by the author marker inside the body.
    const commentChunk = result.chunks.find((c) => c.text.includes('\nalice: '));
    expect(commentChunk?.text).toContain('I think we should');
    // The empty comment from bob is dropped.
    expect(result.chunks.some((c) => c.text.includes('\nbob: '))).toBe(false);
  });

  it('paginates: returns nextCursor when page is full and null when partial', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeIssue({
        number: i + 1,
        updated_at: `2026-05-${String(28).padStart(2, '0')}T12:00:${String(i).padStart(2, '0')}Z`,
      }),
    );
    const clientFull = new GithubClient({ fetchImpl: fetchReturning(fullPage) });
    const resFull = await pullRepoIssuesAndPRs(clientFull, TEST_AUTH, makeScope(), null);
    expect(resFull.nextCursor).not.toBeNull();
    expect(resFull.nextCursor).toContain('updated-since:');

    const clientPartial = new GithubClient({ fetchImpl: fetchReturning([makeIssue()]) });
    const resPartial = await pullRepoIssuesAndPRs(clientPartial, TEST_AUTH, makeScope(), null);
    expect(resPartial.nextCursor).toBeNull();
  });

  it('passes since= when a cursor is provided', async () => {
    let capturedUrl: string | undefined;
    const client = new GithubClient({
      fetchImpl: (input) => {
        capturedUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return Promise.resolve(
          new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        );
      },
    });
    await pullRepoIssuesAndPRs(
      client,
      TEST_AUTH,
      makeScope(),
      encodeCursor('2026-05-01T00:00:00Z'),
    );
    expect(capturedUrl).toContain('since=2026-05-01T00%3A00%3A00Z');
  });
});
