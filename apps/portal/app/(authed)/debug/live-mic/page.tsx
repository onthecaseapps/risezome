import type { ReactElement } from 'react';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { signBotWsJwt } from '../../../_lib/bot-ws-jwt';
import { LiveMicDebugClient } from './_client';

/**
 * Local-mic debug page (DEV / staging only).
 *
 * Lets you exercise the synthesis pipeline against a local microphone
 * via the Linux PulseAudio sidecar instead of paying for a Recall.ai
 * bot per test. Prompt + filter changes can be iterated against real
 * audio without the Recall round-trip.
 *
 * Flow:
 *   1. Click "Start" → opens WS to bot-worker /local-debug/<jwt>.
 *   2. Bot-worker spawns sidecar + Deepgram, runs retrieval+synthesis
 *      per finalized utterance, streams events back.
 *   3. Page renders utterances (left), retrieval cards (middle),
 *      synthesis with citations (right). Debug-focused layout.
 *   4. Click "Stop" → closes WS → bot-worker tears down sidecar.
 *
 * Requirements:
 *   - bot-worker running with LOCAL_DEBUG_ENABLED=true + DEEPGRAM_API_KEY +
 *     VOYAGE_API_KEY + ANTHROPIC_API_KEY
 *   - Linux host (sidecar binary at sidecars/linux/build/upwell-sidecar-linux)
 *   - BOT_WORKER_HTTP_URL or BOT_WORKER_BASE_URL env in portal
 */
export default async function LiveMicDebugPage(): Promise<ReactElement> {
  const { orgId } = await requireAuthedUserWithOrg();

  const secret = process.env['BOT_WORKER_SECRET'];
  const wsBaseUrl =
    process.env['BOT_WORKER_BASE_URL'] ?? process.env['BOT_WORKER_HTTP_URL'] ?? 'ws://localhost:8787';

  if (secret === undefined || secret.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-xl font-semibold">Local-mic debug</h1>
        <p className="mt-3 text-sm text-rose-400">
          BOT_WORKER_SECRET is not set in the portal&apos;s environment. Set it
          and reload.
        </p>
      </div>
    );
  }

  // Short-lived JWT (15min) — the WS itself will be torn down on stop.
  const token = await signBotWsJwt(
    { meetingId: 'debug', orgId },
    secret,
    15 * 60,
  );

  // Normalize HTTP base to ws/wss for the browser WebSocket URL.
  const wsUrl = wsBaseUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/$/, '');

  return <LiveMicDebugClient wsUrl={`${wsUrl}/local-debug/${token}`} orgId={orgId} />;
}
