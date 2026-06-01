import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { EvalDebugClient } from './_client';

/**
 * Corpus eval dev page (DEV / staging only).
 *
 * Runs the golden-question eval through the REAL retrieval + synthesis path
 * (via the bot-worker /local-debug-eval endpoints, proxied through
 * /api/debug/eval) and shows per-question intermediates — retrieved sources
 * with scores, the synthesis answer, the citation verified/downgraded/dropped
 * breakdown, suppressed/refusal status, pass/fail, and optional RAGAS — to make
 * it easy to reason about WHY a question passes or fails. Also lets you add new
 * golden questions.
 *
 * Requirements: bot-worker running with LOCAL_DEBUG_ENABLED=true + VOYAGE_API_KEY
 * + ANTHROPIC_API_KEY, and BOT_WORKER_SECRET set in the portal env.
 */
export default async function EvalDebugPage(): Promise<ReactElement> {
  await requireAuthedUserWithOrg(); // gate; the client fetches via /api/debug/eval
  return <EvalDebugClient />;
}
