import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient as createSsrClient } from '@supabase/ssr';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { sanitizeNext } from '../../../_lib/safe-next';

/**
 * OAuth callback. Google redirected the user back here after their consent;
 * the URL carries a `code` we exchange for a Supabase session. The session
 * carries Google's `provider_token` (access token) + `provider_refresh_token`
 * — we persist those to user_google_tokens (refresh token encrypted at
 * rest via pgcrypto) so Inngest functions can refresh the access token
 * offline.
 *
 * Errors: a bad/missing code or a Supabase exchange failure redirects to
 * /sign-in?error=... with a clean banner. We avoid silently 500-ing — auth
 * errors are user-facing and need clear surfacing.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  // Sanitize the post-auth redirect — an attacker-supplied absolute `next`
  // would otherwise resolve off-origin (open redirect). Invite links make
  // this reachable by anyone holding a token.
  const next = sanitizeNext(url.searchParams.get('next'));

  if (code === null) {
    return NextResponse.redirect(new URL('/sign-in?error=missing_code', url.origin));
  }

  const supabaseUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const publishableKey = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  const secretKey = process.env['SUPABASE_SECRET_KEY'];
  const encryptionKey = process.env['USER_TOKEN_ENCRYPTION_KEY'];
  if (
    supabaseUrl === undefined ||
    supabaseUrl.length === 0 ||
    publishableKey === undefined ||
    publishableKey.length === 0 ||
    secretKey === undefined ||
    secretKey.length === 0 ||
    encryptionKey === undefined ||
    encryptionKey.length === 0
  ) {
    return NextResponse.redirect(new URL('/sign-in?error=server_misconfigured', url.origin));
  }

  // Build the response shell early so we can attach refreshed cookies as
  // the SSR client touches them during the exchange.
  const response = NextResponse.redirect(new URL(next, url.origin));

  const cookieStore = await cookies();
  const supabase = createSsrClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error !== null) {
    const reason = encodeURIComponent(error.message);
    return NextResponse.redirect(new URL(`/sign-in?error=exchange_failed&reason=${reason}`, url.origin));
  }

  // Persist Google's refresh token + access token under the user's id.
  // Service-role client bypasses RLS for the write; we explicitly set
  // user_id from the session so it's still scoped correctly.
  const session = data.session;
  const user = data.user;
  if (session !== null && user !== null && session.provider_refresh_token !== undefined) {
    const service = createServiceClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const accessToken = session.provider_token ?? '';
    const refreshToken = session.provider_refresh_token;
    // expires_at on the session is for the SUPABASE token, not the Google
    // one. Google access tokens are 1h; use that as our window.
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    // Encrypt the refresh token via the SQL helper. Single round-trip:
    // we run the encrypt + upsert in one rpc-style call via the function.
    const { data: encrypted, error: encryptErr } = await service.rpc('encrypt_refresh_token', {
      plaintext: refreshToken,
      key: encryptionKey,
    });
    if (encryptErr !== null) {
      // Soft-fail: log + continue. The user still gets signed in; calendar
      // sync just won't work for them until they re-auth. Logged at error
      // level so it's noticed during early beta.
       
      console.error('[auth.callback] encrypt_refresh_token failed:', encryptErr);
    } else {
      const { error: upsertErr } = await service.from('user_google_tokens').upsert(
        {
          user_id: user.id,
          access_token: accessToken,
          refresh_token_enc: encrypted as unknown as string,
          expires_at: expiresAt,
          scope: 'https://www.googleapis.com/auth/calendar.events.readonly openid email profile',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (upsertErr !== null) {
         
        console.error('[auth.callback] user_google_tokens upsert failed:', upsertErr);
      } else {
        // Token stored — kick off an immediate calendar sync so the user
        // lands on /upcoming with data already there instead of waiting
        // for the 5-min cron. Best-effort: we look up the user's first
        // org membership; if they're brand-new (still going to onboarding),
        // we skip and let the cron pick them up after they pick an org.
        const { data: membership } = await service
          .from('org_members')
          .select('org_id')
          .eq('user_id', user.id)
          .order('joined_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        if (membership !== null) {
          const { inngest } = await import('../../../../src/inngest/client');
          await inngest.send({
            name: 'risezome/calendar.sync-requested',
            data: { userId: user.id, orgId: membership.org_id as string, reason: 'sign-in' },
          });
        }
      }
    }
  }

  return response;
}
