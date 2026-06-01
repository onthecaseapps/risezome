import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────
const sendSpy = vi.fn();
const requireAuthedUserWithOrg = vi.fn();
const createServerClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({
  requireAuthedUserWithOrg: () => requireAuthedUserWithOrg(),
}));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServerClient: () => createServerClient(),
}));
vi.mock('../../src/inngest/client', () => ({ inngest: { send: (e: unknown) => sendSpy(e) } }));

import { toggleBotOptInAction } from '../../app/(authed)/upcoming/opt-in-action';

/** Supabase stub: an eligible future zoom event for `user_1`, update ok. */
function makeSupabase(): unknown {
  return {
    from() {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: 'evt_1',
                  user_id: 'user_1',
                  start_at: new Date(Date.now() + 3_600_000).toISOString(),
                  conference_url: 'https://zoom.us/j/1',
                  platform: 'zoom',
                  bot_optin: false,
                },
                error: null,
              }),
            }),
          }),
        }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
    },
  };
}

function form(eventId: string, optin: boolean): FormData {
  const fd = new FormData();
  fd.set('eventId', eventId);
  fd.set('bot_optin', optin ? 'true' : 'false');
  return fd;
}

beforeEach(() => {
  createServerClient.mockResolvedValue(makeSupabase());
});
afterEach(() => vi.clearAllMocks());

describe('toggleBotOptInAction — R7 bot-invite gating', () => {
  it('rejects a member without the grant from launching (toggle ON)', async () => {
    requireAuthedUserWithOrg.mockResolvedValue({ user: { id: 'user_1' }, canInviteBot: false });
    const result = await toggleBotOptInAction(form('evt_1', true));
    expect(result).toEqual({ ok: false, error: 'bot_invite_not_permitted' });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('allows a manager / granted member to launch (toggle ON fires the event)', async () => {
    requireAuthedUserWithOrg.mockResolvedValue({ user: { id: 'user_1' }, canInviteBot: true });
    const result = await toggleBotOptInAction(form('evt_1', true));
    expect(result).toEqual({ ok: true, bot_optin: true });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('always allows toggling OFF, even without the grant', async () => {
    requireAuthedUserWithOrg.mockResolvedValue({ user: { id: 'user_1' }, canInviteBot: false });
    const result = await toggleBotOptInAction(form('evt_1', false));
    expect(result).toEqual({ ok: true, bot_optin: false });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
