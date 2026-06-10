import { serve } from 'inngest/next';
import { inngest } from '../../../src/inngest/client';
import { allInngestFunctions } from '../../../src/inngest/functions';

/**
 * Inngest function registry, exposed at /api/inngest.
 *
 * - GET  → introspection (the dev CLI uses this to discover functions)
 * - POST → function invocation (Inngest's dispatcher calls this with the event)
 * - PUT  → sync request (deploy-time registration)
 *
 * Functions come from the SINGLE registry in src/inngest/functions/index.ts —
 * this file previously kept its own hand-maintained list, which silently
 * drifted (indexGithubIssuesFn was exported from the registry but never
 * registered here, so issues indexing never ran).
 *
 * Production uses INNGEST_SIGNING_KEY to verify inbound requests; local dev
 * with the Inngest dev CLI runs unsigned. The signing key is the ONLY thing
 * standing between a public POST and forged invocation of org-scoped functions
 * (recap / gap-assembly / key rotation all take orgId from the event payload) —
 * so a production runtime without it must FAIL CLOSED on invocation/sync
 * requests rather than silently serving unsigned. (Checked per-request, not at
 * module load: `next build` evaluates this module with NODE_ENV=production and
 * no runtime secrets.)
 */
const handlers = serve({
  client: inngest,
  functions: allInngestFunctions,
});

/**
 * Fail closed whenever the signing key is absent UNLESS we're explicitly in
 * Inngest dev mode (the local dev CLI runs unsigned and sets INNGEST_DEV). The
 * earlier `NODE_ENV === 'production'` gate left a hole: a public preview/staging
 * deploy where NODE_ENV isn't exactly "production" and the key is unset would
 * accept UNSIGNED, forged function invocations — and functions derive org from
 * the (otherwise-signed) event payload, so that's a cross-org trigger/write.
 */
function signingKeyMissing(): boolean {
  if ((process.env.INNGEST_SIGNING_KEY ?? '').length > 0) return false;
  const devMode =
    process.env.INNGEST_DEV === '1' ||
    process.env.INNGEST_DEV === 'true' ||
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test';
  return !devMode;
}

export const GET = handlers.GET;

export async function POST(req: Request, ctx: unknown): Promise<Response> {
  if (signingKeyMissing()) {
    console.error('[inngest] refusing unsigned invocation: INNGEST_SIGNING_KEY is not set in production');
    return new Response('signing key not configured', { status: 500 });
  }
  return (handlers.POST as (req: Request, ctx: unknown) => Promise<Response>)(req, ctx);
}

export async function PUT(req: Request, ctx: unknown): Promise<Response> {
  if (signingKeyMissing()) {
    console.error('[inngest] refusing unsigned sync: INNGEST_SIGNING_KEY is not set in production');
    return new Response('signing key not configured', { status: 500 });
  }
  return (handlers.PUT as (req: Request, ctx: unknown) => Promise<Response>)(req, ctx);
}
