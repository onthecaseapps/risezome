import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireAdmin = vi.fn();
const createServiceRoleClient = vi.fn();
const inngestSend = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireAdmin: () => requireAdmin() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));
vi.mock('../../src/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => inngestSend(...a) } }));

import {
  setOrgCorpusPolicyAction,
  setSourcesCorpusPolicyAction,
  setTeamSourcePolicyAction,
} from '../../app/(authed)/sources/corpus-policy-action';

beforeEach(() => {
  requireAdmin.mockResolvedValue({ orgId: 'org1', user: { id: 'user1' } });
  inngestSend.mockResolvedValue({ ids: ['x'] });
});
afterEach(() => vi.clearAllMocks());

// Mock the sources update chain: update().in().eq().neq().select() → rows.
function mockSourcesUpdate(rows: Array<{ id: string; kind: string | null }>, capture: (v: unknown) => void) {
  createServiceRoleClient.mockReturnValue({
    from: () => ({
      update: (vals: unknown) => {
        capture(vals);
        return {
          in: () => ({ eq: () => ({ neq: () => ({ select: async () => ({ data: rows, error: null }) }) }) }),
        };
      },
    }),
  });
}

describe('setSourcesCorpusPolicyAction', () => {
  it('rejects no sources', async () => {
    const res = await setSourcesCorpusPolicyAction([], { preset: 'recommended' });
    expect(res).toEqual({ ok: false, error: 'missing_source' });
  });

  it('rejects an invalid preset before touching the DB', async () => {
    const res = await setSourcesCorpusPolicyAction(['s1'], { preset: 'bogus' } as never);
    expect(res).toEqual({ ok: false, error: 'invalid_preset' });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('persists a full custom policy to all sources and reindexes each', async () => {
    let written: unknown;
    mockSourcesUpdate([{ id: 's1', kind: 'trello' }, { id: 's2', kind: 'trello' }], (v) => { written = v; });
    const policy = {
      preset: 'recommended' as const,
      connectorRules: [{ source: 'trello' as const, field: 'list' as const, op: 'in' as const, value: ['Done'] }],
      connectorOptions: { trello: { includeArchived: true } },
    };
    const res = await setSourcesCorpusPolicyAction(['s1', 's2'], policy);
    expect(res).toEqual({ ok: true, reindexed: 2 });
    expect((written as { corpus_policy: { connectorOptions?: unknown } }).corpus_policy.connectorOptions)
      .toEqual({ trello: { includeArchived: true } });
    expect(inngestSend).toHaveBeenCalledTimes(2);
  });

  it('clears the override when policy is null', async () => {
    let written: unknown;
    mockSourcesUpdate([{ id: 's1', kind: 'github' }], (v) => { written = v; });
    const res = await setSourcesCorpusPolicyAction(['s1'], null);
    expect(res).toEqual({ ok: true, reindexed: 1 });
    expect(written).toEqual({ corpus_policy: null });
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'risezome/source.index-requested' }),
    );
  });

  it('drops malformed sub-fields but keeps a valid preset', async () => {
    let written: unknown;
    mockSourcesUpdate([{ id: 's1', kind: 'jira' }], (v) => { written = v; });
    await setSourcesCorpusPolicyAction(['s1'], { preset: 'recommended', customExcludes: [1, 2] } as never);
    expect((written as { corpus_policy: { customExcludes?: unknown } }).corpus_policy.customExcludes).toBeUndefined();
  });
});

describe('setTeamSourcePolicyAction', () => {
  // sources.select(...).in().eq().neq() → org-owned rows; team_sources update
  // .eq('team_id').in('source_id') → captures the written view_policy.
  function mockTeamView(orgRows: Array<{ id: string; kind: string | null }>, capture: (v: unknown) => void) {
    createServiceRoleClient.mockReturnValue({
      from(table: string) {
        if (table === 'sources') {
          return { select: () => ({ in: () => ({ eq: () => ({ neq: async () => ({ data: orgRows, error: null }) }) }) }) };
        }
        // team_sources
        return {
          update: (vals: unknown) => {
            capture(vals);
            return { eq: () => ({ in: async () => ({ error: null }) }) };
          },
        };
      },
    });
  }

  it('rejects when no team or no sources', async () => {
    expect(await setTeamSourcePolicyAction('', ['s1'], { preset: 'recommended' })).toEqual({ ok: false, error: 'missing_source' });
    expect(await setTeamSourcePolicyAction('t1', [], { preset: 'recommended' })).toEqual({ ok: false, error: 'missing_source' });
  });

  it('writes the team view_policy for the org-owned sources and reindexes each', async () => {
    let written: unknown;
    mockTeamView([{ id: 's1', kind: 'confluence' }, { id: 's2', kind: 'confluence' }], (v) => { written = v; });
    const res = await setTeamSourcePolicyAction('t1', ['s1', 's2'], { preset: 'code_only' });
    expect(res).toEqual({ ok: true, reindexed: 2 });
    expect((written as { view_policy: { preset?: string } }).view_policy.preset).toBe('code_only');
    expect(inngestSend).toHaveBeenCalledTimes(2);
  });

  it('clears the team view when policy is null (inherit org default)', async () => {
    let written: unknown;
    mockTeamView([{ id: 's1', kind: 'github' }], (v) => { written = v; });
    const res = await setTeamSourcePolicyAction('t1', ['s1'], null);
    expect(res).toEqual({ ok: true, reindexed: 1 });
    expect(written).toEqual({ view_policy: null });
  });

  it('returns source_not_found when none of the ids belong to the org', async () => {
    mockTeamView([], () => {});
    expect(await setTeamSourcePolicyAction('t1', ['foreign'], null)).toEqual({ ok: false, error: 'source_not_found' });
    expect(inngestSend).not.toHaveBeenCalled();
  });
});

describe('setOrgCorpusPolicyAction', () => {
  it('upserts the org default and reindexes only override-less sources', async () => {
    let upserted: unknown;
    createServiceRoleClient.mockReturnValue({
      from(table: string) {
        if (table === 'org_corpus_policy') {
          return { upsert: async (vals: unknown) => { upserted = vals; return { error: null }; } };
        }
        // sources select for the fan-out
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                neq: async () => ({ data: [{ id: 'a', kind: 'github' }, { id: 'b', kind: 'jira' }], error: null }),
              }),
            }),
          }),
        };
      },
    });
    const res = await setOrgCorpusPolicyAction('recommended');
    expect(res).toEqual({ ok: true, reindexed: 2 });
    expect(upserted).toMatchObject({ org_id: 'org1', preset: 'recommended', updated_by: 'user1' });
    expect(inngestSend).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid preset', async () => {
    const res = await setOrgCorpusPolicyAction('nope');
    expect(res).toEqual({ ok: false, error: 'invalid_preset' });
  });
});
