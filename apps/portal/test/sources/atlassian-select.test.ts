import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendSpy = vi.fn();
const requireAuthedUserWithOrg = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireAuthedUserWithOrg: () => requireAuthedUserWithOrg() }));
vi.mock('../../app/_lib/supabase-server', () => ({ createServiceRoleClient: () => createServiceRoleClient() }));
vi.mock('../../src/inngest/client', () => ({ inngest: { send: (e: unknown) => sendSpy(e) } }));

import { selectAtlassianResourcesAction } from '../../app/(authed)/sources/atlassian-select-action';

function makeSupabase(opts: { connection: { id: string } | null }): unknown {
  let upserts = 0;
  return {
    from(table: string) {
      if (table === 'atlassian_connections') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.connection, error: null }) }) }) };
      }
      return {
        upsert: () => ({
          select: () => ({
            single: async () => {
              upserts += 1;
              return { data: { id: `src_${upserts}` }, error: null };
            },
          }),
        }),
      };
    },
  };
}

function form(selection: unknown): FormData {
  const fd = new FormData();
  if (typeof selection === 'string') fd.set('selection', selection);
  else if (selection !== undefined) fd.set('selection', JSON.stringify(selection));
  return fd;
}

beforeEach(() => {
  requireAuthedUserWithOrg.mockResolvedValue({ orgId: 'org_1' });
  createServiceRoleClient.mockReturnValue(makeSupabase({ connection: { id: 'conn_1' } }));
});
afterEach(() => vi.clearAllMocks());

describe('selectAtlassianResourcesAction', () => {
  it('creates a source and emits the kind-specific event per resource', async () => {
    const res = await selectAtlassianResourcesAction(
      form([
        { kind: 'jira', id: 'PROJ', name: 'Platform' },
        { kind: 'confluence', id: 'SPACE1', name: 'Eng Docs' },
      ]),
    );
    expect(res).toEqual({ ok: true, count: 2 });
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'risezome/jira.index-requested' }));
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'risezome/confluence.index-requested' }));
  });

  it('rejects an unknown kind / empty selection', async () => {
    const a = await selectAtlassianResourcesAction(form([{ kind: 'slack', id: 'x', name: 'y' }]));
    expect(a).toEqual({ ok: false, error: 'empty_selection' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('fails when the org has no Atlassian connection', async () => {
    createServiceRoleClient.mockReturnValue(makeSupabase({ connection: null }));
    const res = await selectAtlassianResourcesAction(form([{ kind: 'jira', id: 'P', name: 'P' }]));
    expect(res).toEqual({ ok: false, error: 'atlassian_not_connected' });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
