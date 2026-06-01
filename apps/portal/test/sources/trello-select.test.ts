import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const sendSpy = vi.fn();
const requireAuthedUserWithOrg = vi.fn();
const createServiceRoleClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({
  requireAuthedUserWithOrg: () => requireAuthedUserWithOrg(),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServiceRoleClient: () => createServiceRoleClient(),
}));
vi.mock('../../src/inngest/client', () => ({ inngest: { send: (e: unknown) => sendSpy(e) } }));

import { selectTrelloBoardsAction } from '../../app/(authed)/sources/trello-select-action';

/**
 * Minimal chainable Supabase stub: connection lookup, existing-source lookup
 * (returns null → new board), and source insert → select → single.
 */
function makeSupabase(opts: { connection: { id: string } | null; insertError?: string }): unknown {
  let inserts = 0;
  return {
    from(table: string) {
      if (table === 'trello_connections') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.connection, error: null }) }) }),
        };
      }
      // sources: select().eq().eq().eq().maybeSingle() (existing lookup → none)
      //          + insert().select().single() (create)
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => {
              inserts += 1;
              if (opts.insertError !== undefined) {
                return { data: null, error: { message: opts.insertError } };
              }
              return { data: { id: `src_${inserts}` }, error: null };
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

describe('selectTrelloBoardsAction', () => {
  it('creates a source and emits a trello.index-requested event per selected board', async () => {
    const res = await selectTrelloBoardsAction(
      form([{ id: 'b1', name: 'Roadmap' }, { id: 'b2', name: 'Bugs' }]),
    );
    expect(res).toEqual({ ok: true, count: 2 });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'risezome/trello.index-requested' }),
    );
  });

  it('rejects an empty selection without emitting events', async () => {
    const res = await selectTrelloBoardsAction(form([]));
    expect(res).toEqual({ ok: false, error: 'empty_selection' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed selection payload', async () => {
    const res = await selectTrelloBoardsAction(form('not json'));
    expect(res).toMatchObject({ ok: false });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('fails when the org has no Trello connection', async () => {
    createServiceRoleClient.mockReturnValue(makeSupabase({ connection: null }));
    const res = await selectTrelloBoardsAction(form([{ id: 'b1', name: 'Roadmap' }]));
    expect(res).toEqual({ ok: false, error: 'trello_not_connected' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('surfaces the DB error (no silent ok) and emits nothing when the source write fails', async () => {
    createServiceRoleClient.mockReturnValue(
      makeSupabase({ connection: { id: 'conn_1' }, insertError: 'no unique or exclusion constraint (42P10)' }),
    );
    const res = await selectTrelloBoardsAction(form([{ id: 'b1', name: 'Roadmap' }]));
    expect(res).toEqual({ ok: false, error: 'no unique or exclusion constraint (42P10)' });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
