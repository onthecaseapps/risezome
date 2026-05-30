import { cookies } from 'next/headers';
import { createServerClient as createSsrClient } from '@supabase/ssr';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client bound to the request's cookies. Use this in
 * Server Components, Server Actions, and Route Handlers that act AS the
 * signed-in user. RLS applies.
 *
 * The cookie store mediates session refresh — the matching middleware in
 * apps/portal/middleware.ts touches `getUser()` on each request to write any
 * refreshed cookies back to the response.
 */
export async function createServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  return createSsrClient(requireEnv('NEXT_PUBLIC_SUPABASE_URL'), requireEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll called from a Server Component is a no-op; middleware
          // handles cookie refresh. Suppressing per Supabase SSR guidance.
        }
      },
    },
  });
}

/**
 * Service-role Supabase client. BYPASSES RLS. Reserved for trusted server
 * contexts: Inngest functions, webhook handlers, and the bot worker. Every
 * use must explicitly filter by `org_id`; once `@risezome/db-client` lands
 * (U14), prefer the typed wrapper over this raw client for org-scoped reads.
 */
export function createServiceRoleClient(): SupabaseClient {
  return createServiceClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SECRET_KEY'),
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
