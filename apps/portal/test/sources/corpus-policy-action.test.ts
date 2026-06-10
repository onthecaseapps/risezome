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
  setSourceCorpusPolicyAction,
  setOrgCorpusPolicyAction,
} from '../../app/(authed)/sources/corpus-policy-action';

beforeEach(() => {
  requireAdmin.mockResolvedValue({ orgId: 'org1', user: { id: 'user1' } });
  inngestSend.mockResolvedValue({ ids: ['x'] });
});
afterEach(() => vi.clearAllMocks());

describe('setSourceCorpusPolicyAction', () => {
  it('rejects an invalid preset before touching the DB', async () => {
    const res = await setSourceCorpusPolicyAction('s1', 'bogus');
    expect(res).toEqual({ ok: false, error: 'invalid_preset' });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it('persists the override and reindexes the source', async () => {
    let written: unknown;
    createServiceRoleClient.mockReturnValue({
      from() {
        return {
          update(vals: unknown) {
            written = vals;
            return {
              eq: () => ({
                eq: () => ({
                  neq: () => ({
                    select: () => ({ maybeSingle: async () => ({ data: { id: 's1', kind: 'github' }, error: null }) }),
                  }),
                }),
              }),
            };
          },
        };
      },
    });
    const res = await setSourceCorpusPolicyAction('s1', 'index_everything');
    expect(res).toEqual({ ok: true, reindexed: 1 });
    expect(written).toEqual({ corpus_policy: { preset: 'index_everything' } });
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'risezome/source.index-requested', data: expect.objectContaining({ mode: 'full' }) }),
    );
  });

  it('clears the override when preset is null', async () => {
    let written: unknown;
    createServiceRoleClient.mockReturnValue({
      from: () => ({
        update: (vals: unknown) => {
          written = vals;
          return {
            eq: () => ({ eq: () => ({ neq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 's1', kind: 'trello' }, error: null }) }) }) }) }),
          };
        },
      }),
    });
    const res = await setSourceCorpusPolicyAction('s1', null);
    expect(res.ok).toBe(true);
    expect(written).toEqual({ corpus_policy: null });
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'risezome/trello.index-requested' }),
    );
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
