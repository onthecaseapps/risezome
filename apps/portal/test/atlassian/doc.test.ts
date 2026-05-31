import { describe, expect, it } from 'vitest';
import {
  buildIssueDocText,
  buildPageDocText,
  confluencePageDocId,
  jiraIssueDocId,
} from '../../app/_lib/atlassian-doc';
import type { JiraIssue, ConfluencePage } from '../../app/_lib/atlassian-client';

const adf = (text: string): unknown => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('doc ids', () => {
  it('namespace immutable ids by cloudId', () => {
    expect(jiraIssueDocId('cloud', 'P-1')).toBe('jira:cloud:P-1');
    expect(confluencePageDocId('cloud', 'pg9')).toBe('confluence:cloud:pg9');
  });
});

describe('buildIssueDocText', () => {
  it('combines summary, ADF description, and authored comments', () => {
    const issue: JiraIssue = { key: 'P-1', summary: 'Auth migration', description: adf('Swap cookies for OAuth2.') };
    const text = buildIssueDocText(issue, [
      { id: 'c1', body: adf('blocked on review'), author: 'Priya' },
      { id: 'c2', body: adf('lgtm'), author: null },
    ]);
    expect(text).toContain('Auth migration');
    expect(text).toContain('Swap cookies for OAuth2.');
    expect(text).toContain('Priya: blocked on review');
    expect(text).toContain('Unknown: lgtm');
  });

  it('omits an empty (null) description and the comments section when none', () => {
    const issue: JiraIssue = { key: 'P-2', summary: 'No desc', description: null };
    expect(buildIssueDocText(issue, [])).toBe('No desc');
  });
});

describe('buildPageDocText', () => {
  it('combines the title and the storage-extracted body', () => {
    const page: ConfluencePage = { id: 'pg1', title: 'Rollout', bodyStorage: '<p>Staged rollout.</p>' };
    const text = buildPageDocText(page);
    expect(text).toContain('Rollout');
    expect(text).toContain('Staged rollout.');
    expect(text).not.toContain('<');
  });

  it('returns just the title for an empty body', () => {
    expect(buildPageDocText({ id: 'pg2', title: 'Empty', bodyStorage: '' })).toBe('Empty');
  });
});
