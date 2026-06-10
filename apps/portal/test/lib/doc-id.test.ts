import { describe, expect, it } from 'vitest';
import { orgScopedDocId } from '../../app/_lib/doc-id';
import { trelloCardDocId } from '../../app/_lib/trello-doc';
import { jiraIssueDocId, confluencePageDocId } from '../../app/_lib/atlassian-doc';

/**
 * The whole point of org-scoped doc IDs: two orgs that connect the SAME
 * external resource must produce DISTINCT corpus IDs so they never collide on
 * the global text PK (the cross-tenant hazard forbid_org_move backstops).
 */
describe('orgScopedDocId', () => {
  it('prefixes the external id with the org', () => {
    expect(orgScopedDocId('org-a', 'github:acme/widget:README.md@sha')).toBe(
      'org-a:github:acme/widget:README.md@sha',
    );
  });

  it('yields DISTINCT ids for the same external resource across orgs', () => {
    const a = orgScopedDocId('org-a', 'trello:board1:card1');
    const b = orgScopedDocId('org-b', 'trello:board1:card1');
    expect(a).not.toBe(b);
  });
});

describe('generators are org-scoped (no cross-tenant PK collision)', () => {
  it('Trello: same board+card, different orgs → different ids', () => {
    expect(trelloCardDocId('org-a', 'b1', 'c1')).not.toBe(trelloCardDocId('org-b', 'b1', 'c1'));
    expect(trelloCardDocId('org-a', 'b1', 'c1')).toBe('org-a:trello:b1:c1');
  });

  it('Atlassian: same site, different orgs → different ids', () => {
    expect(jiraIssueDocId('org-a', 'cloud', 'P-1')).not.toBe(jiraIssueDocId('org-b', 'cloud', 'P-1'));
    expect(confluencePageDocId('org-a', 'cloud', 'pg9')).not.toBe(
      confluencePageDocId('org-b', 'cloud', 'pg9'),
    );
  });
});
