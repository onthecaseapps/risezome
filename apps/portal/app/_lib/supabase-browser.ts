'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser-side Supabase client. Use from Client Components. Uses the public
 * publishable key; RLS gates everything. Realtime subscriptions on private
 * channels authenticate against the user's JWT (Realtime calls `setAuth`
 * internally on subscribe).
 */
let cachedClient: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (cachedClient !== null) return cachedClient;
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  if (url === undefined || url.length === 0 || key === undefined || key.length === 0) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. ' +
        'See .env.example for required env vars.',
    );
  }
  cachedClient = createBrowserClient(url, key);
  return cachedClient;
}
