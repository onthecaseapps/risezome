import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

/**
 * Refresh the Supabase session cookie on every request to an authed route.
 * Pattern adapted from the Supabase SSR Next.js App Router guide. The middleware
 * recreates the SSR client, calls getUser() to trigger a refresh-if-needed,
 * and writes refreshed cookies back to the response.
 *
 * Matcher excludes static assets and Next internals so the auth probe doesn't
 * fire on every CSS file fetch.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.next({ request });

  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const key = process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  if (url === undefined || url.length === 0 || key === undefined || key.length === 0) {
    // Not configured yet (early-dev state). Pass through without refresh.
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touching getUser() is what causes a refresh-if-needed. The user value is
  // discarded; we only care about the cookie side-effect.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Skip Next.js internals, image optimization, and favicon. Auth probe runs
  // on the routes that actually need a session: marketing pages allow public
  // access but middleware harmlessly no-ops when no session is present.
  // The signed-webhook endpoints (Recall + GitHub webhooks, Inngest) are also
  // excluded — they authenticate via signatures, never cookies, so the session
  // probe was a wasted auth round-trip on hot unauthenticated paths.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/recall/webhook|api/github/webhook|api/inngest).*)',
  ],
};
