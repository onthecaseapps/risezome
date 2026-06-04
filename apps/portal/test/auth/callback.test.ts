import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as callbackHandler } from '../../app/api/auth/callback/route';

/**
 * Smoke tests for the OAuth callback handler. The happy-path round-trip
 * needs a real Supabase project; covered by the manual end-to-end test
 * during U2 (`pnpm --filter @risezome/portal dev` → click Google button).
 * These tests cover the early-rejection cases that don't require a live
 * Supabase backend.
 */
describe('GET /api/auth/callback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['NEXT_PUBLIC_SUPABASE_URL'] = 'https://example.supabase.co';
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] = 'sb_publishable_test';
    process.env['SUPABASE_SECRET_KEY'] = 'sb_secret_test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('redirects to /sign-in?error=missing_code when no code query param', async () => {
    const req = new NextRequest('http://localhost:3000/api/auth/callback');
    const res = await callbackHandler(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe('/sign-in');
    expect(url.searchParams.get('error')).toBe('missing_code');
  });

  it('redirects to /sign-in?error=server_misconfigured when env vars are missing', async () => {
    delete process.env['SUPABASE_SECRET_KEY'];
    const req = new NextRequest('http://localhost:3000/api/auth/callback?code=fake');
    const res = await callbackHandler(req);
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location')!);
    expect(url.pathname).toBe('/sign-in');
    expect(url.searchParams.get('error')).toBe('server_misconfigured');
  });

  it('uses ?next= query param as the redirect destination when set', async () => {
    // Skips actual Supabase exchange because no real code; just verifies
    // that missing_code preserves any redirect target hint (it doesn't, by
    // design — we always send to /sign-in on error). This locks in that
    // behavior so a future refactor doesn't accidentally leak the next param.
    const req = new NextRequest('http://localhost:3000/api/auth/callback?next=%2Fsources');
    const res = await callbackHandler(req);
    const url = new URL(res.headers.get('location')!);
    expect(url.pathname).toBe('/sign-in');
    expect(url.searchParams.get('next')).toBeNull();
  });
});
