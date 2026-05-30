import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '../../../_lib/supabase-server';

/**
 * Sign out the current user. Clears Supabase session cookies and redirects
 * to /. Triggered by a POST from the topbar in authed pages.
 *
 * Using POST (not GET) avoids accidental sign-out from a link prefetch or
 * a browser pre-render. The form in the topbar uses method="post" + a
 * CSRF-safe form action.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/', request.url), { status: 303 });
}
