import { describe, expect, it } from 'vitest';
import {
  canonicalDocId,
  chunkIssue,
  chunkIsMeaningful,
  MIN_CHUNK_CHARS,
} from '../../../src/lib/github/chunk-issues.js';
import type { GithubIssue } from '../../../src/lib/github/issue-types.js';

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    id: 1,
    number: 42,
    title: 'Auth middleware migration',
    state: 'open',
    html_url: 'https://github.com/acme/widget/issues/42',
    body: 'Body of the issue is long enough to clear the meaningful-chunk threshold for sure, all good here.',
    user: { login: 'nathan' },
    assignees: [{ login: 'jamie' }],
    labels: [{ name: 'security' }, { name: 'auth' }],
    created_at: '2026-05-28T12:00:00Z',
    updated_at: '2026-05-28T13:00:00Z',
    ...overrides,
  };
}

describe('canonicalDocId', () => {
  it('uses "issue" discriminator when pull_request is absent', () => {
    expect(canonicalDocId('acme/widget', makeIssue())).toBe('gh:acme/widget#issue:42');
  });

  it('uses "pr" discriminator when pull_request is present', () => {
    const pr = makeIssue({ pull_request: { url: 'https://api.github.com/x' } });
    expect(canonicalDocId('acme/widget', pr)).toBe('gh:acme/widget#pr:42');
  });
});

describe('chunkIssue: doc shape', () => {
  it('emits an issue doc with correct discriminator + entities + authors', () => {
    const { doc } = chunkIssue('acme/widget', makeIssue());
    expect(doc.docId).toBe('gh:acme/widget#issue:42');
    expect(doc.type).toBe('issue');
    expect(doc.title).toBe('Auth middleware migration');
    expect(doc.entities).toEqual(['acme/widget#42']);
    // user.login first, then each assignee
    expect(doc.authors).toEqual(['nathan', 'jamie']);
    expect(doc.url).toBe('https://github.com/acme/widget/issues/42');
    expect(doc.updatedAt).toBe('2026-05-28T13:00:00Z');
  });

  it('emits a pull-request doc when pull_request is set', () => {
    const { doc } = chunkIssue('acme/widget', makeIssue({
      pull_request: { url: 'https://api.github.com/x' },
    }));
    expect(doc.type).toBe('pull-request');
    expect(doc.docId).toBe('gh:acme/widget#pr:42');
  });

  it('truncates bodySummary to 240 chars with an ellipsis', () => {
    const longBody = 'x'.repeat(300);
    const { doc } = chunkIssue('acme/widget', makeIssue({ body: longBody }));
    expect(doc.bodySummary.length).toBeLessThanOrEqual(240);
    expect(doc.bodySummary.endsWith('…')).toBe(true);
  });

  it('handles null body without throwing', () => {
    const { doc, chunks } = chunkIssue('acme/widget', makeIssue({ body: null }));
    expect(doc.bodySummary).toBe('');
    // No body chunk; just the header chunk (if it clears MIN_CHUNK_CHARS).
    expect(chunks.find((c) => c.text.includes('Body of the issue'))).toBeUndefined();
  });
});

describe('chunkIssue: chunk text format — load-bearing contract for U6', () => {
  it('header chunk leads with "Issue {owner/repo}#N — {title}. Status: {state}." followed by labels then renderHeader', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue());
    const headerChunk = chunks[0]!;
    expect(headerChunk.text).toMatch(
      /^Issue acme\/widget#42 — Auth middleware migration\. Status: open\. Labels: security, auth\.\n\nacme\/widget#42 \| state=open \| labels=\[security, auth\] \| assignees=\[jamie\] \| updated_at=2026-05-28T13:00:00Z$/,
    );
  });

  it('PR chunks lead with "PR" instead of "Issue"', () => {
    const pr = makeIssue({ pull_request: { url: 'https://api.github.com/x' } });
    const { chunks } = chunkIssue('acme/widget', pr);
    expect(chunks[0]!.text.startsWith('PR acme/widget#42 — ')).toBe(true);
  });

  it('omits the labels phrase when issue has no labels', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue({ labels: [] }));
    expect(chunks[0]!.text).not.toContain('Labels:');
  });

  it('omits the assignees segment when there are no assignees', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue({ assignees: [] }));
    expect(chunks[0]!.text).not.toContain('assignees=');
  });

  it('body chunk repeats the context line then includes the full body verbatim', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue());
    const bodyChunk = chunks[1]!;
    expect(bodyChunk.text.startsWith('Issue acme/widget#42 — Auth middleware migration. Status: open. Labels: security, auth.\n\n')).toBe(true);
    expect(bodyChunk.text).toContain('Body of the issue is long enough');
  });

  it('skips the body chunk when body is whitespace-only', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue({ body: '   \n\n   ' }));
    expect(chunks.length).toBe(1);
  });

  it('skips chunks that fall below MIN_CHUNK_CHARS', () => {
    // Header chunk should always clear MIN; body chunk may not.
    expect(MIN_CHUNK_CHARS).toBe(80);
    // Tiny body — the body chunk text would be "context\n\n{body}" which
    // still clears 80 chars from the context alone — so this body still
    // ends up in a chunk. Confirms the cutoff lives at the chunk level,
    // not the body level.
    const { chunks } = chunkIssue('acme/widget', makeIssue({ body: 'tiny.' }));
    // Header + body should both produce chunks given the context prefix.
    expect(chunks).toHaveLength(2);
  });

  it('chunk positions are sequential starting at 0', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue());
    expect(chunks[0]!.position).toBe(0);
    expect(chunks[1]!.position).toBe(1);
  });

  it('chunk ids follow the canonicalDocId + "#chunk:{position}" pattern', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue());
    expect(chunks[0]!.chunkId).toBe('gh:acme/widget#issue:42#chunk:0');
    expect(chunks[1]!.chunkId).toBe('gh:acme/widget#issue:42#chunk:1');
  });

  it('closed-state issues produce "Status: closed." in the context line', () => {
    const { chunks } = chunkIssue('acme/widget', makeIssue({ state: 'closed' }));
    expect(chunks[0]!.text).toContain('Status: closed.');
  });
});

describe('chunkIsMeaningful', () => {
  it('returns false for chunks shorter than MIN_CHUNK_CHARS', () => {
    expect(chunkIsMeaningful('short')).toBe(false);
    expect(chunkIsMeaningful('x'.repeat(MIN_CHUNK_CHARS - 1))).toBe(false);
  });

  it('returns true for chunks meeting the threshold', () => {
    expect(chunkIsMeaningful('x'.repeat(MIN_CHUNK_CHARS))).toBe(true);
  });

  it('measures trimmed length, not raw length', () => {
    expect(chunkIsMeaningful(' '.repeat(200))).toBe(false);
  });
});
