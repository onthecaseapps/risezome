import { afterEach, describe, expect, it, vi } from 'vitest';

// Confirms the manager-only surfaces route through requireManager — a member
// (whom requireManager redirects) cannot mutate workspace settings.
const requireManager = vi.fn();
const createServerClient = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../app/_lib/auth', () => ({ requireManager: () => requireManager() }));
vi.mock('../../app/_lib/supabase-server', () => ({
  createServerClient: () => createServerClient(),
}));

import { saveBotSettingsAction } from '../../app/(authed)/settings/meeting-bot/save-action';

const settings = { field: 'auto_join' as const, value: true };

afterEach(() => vi.clearAllMocks());

describe('settings save-action is manager-gated', () => {
  it('a member is rejected (requireManager redirects)', async () => {
    requireManager.mockRejectedValue(new Error('REDIRECT:/upcoming'));
    await expect(saveBotSettingsAction(settings)).rejects.toThrow('REDIRECT:/upcoming');
  });

  it('a manager proceeds', async () => {
    requireManager.mockResolvedValue({ user: { id: 'mgr_1' }, orgId: 'org_1' });
    createServerClient.mockResolvedValue({
      from: () => ({ upsert: async () => ({ error: null }) }),
    });
    expect(await saveBotSettingsAction(settings)).toEqual({ ok: true });
  });
});
