import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve display names for auth users via the admin API, PAGINATED.
 *
 * `listUsers({ perPage: 1000 })` alone silently truncates past 1000 auth users
 * (it's project-wide, not org-scoped) — names beyond page 1 then degraded to
 * raw UUIDs with no error. Pages until exhausted, with a hard cap as a runaway
 * guard. Returns a map of userId → display name (full_name → email → id).
 */
const PER_PAGE = 1000;
const MAX_PAGES = 20;

export async function listAuthUserNames(service: SupabaseClient): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error !== null) {
      console.error(`[auth-admin] listUsers page ${String(page)} failed:`, error.message);
      break; // partial map is better than none; callers fall back to the id
    }
    for (const u of data.users) {
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta['full_name'] === 'string' ? (meta['full_name'] as string) : null;
      names.set(u.id, name ?? u.email ?? u.id);
    }
    if (data.users.length < PER_PAGE) break;
  }
  return names;
}
