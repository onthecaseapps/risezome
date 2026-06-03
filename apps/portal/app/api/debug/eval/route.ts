// Server-side proxy for the eval dev page. Mints the bot-worker JWT (keeps
// BOT_WORKER_SECRET server-side) and forwards to the bot-worker's
// /local-debug-eval endpoints, so the browser talks same-origin (no CORS).
//
//   GET  /api/debug/eval                      -> list golden questions
//   POST /api/debug/eval  {action:'run',...}  -> evaluate one question
//   POST /api/debug/eval  {action:'add',...}  -> append a golden question
import { NextResponse } from 'next/server';
import { requireAuthedUserWithOrg } from '../../../_lib/auth';
import { signBotWsJwt } from '../../../_lib/bot-ws-jwt';

function httpBase(): string {
  const raw =
    process.env['BOT_WORKER_BASE_URL'] ??
    process.env['BOT_WORKER_HTTP_URL'] ??
    'http://localhost:8787';
  return raw.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
}

async function mintToken(orgId: string): Promise<string | null> {
  const secret = process.env['BOT_WORKER_SECRET'];
  if (secret === undefined || secret.length === 0) return null;
  return signBotWsJwt({ meetingId: 'eval', orgId }, secret, 15 * 60);
}

function passThrough(res: Response, text: string): NextResponse {
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function GET(): Promise<Response> {
  const { orgId } = await requireAuthedUserWithOrg();
  const token = await mintToken(orgId);
  if (token === null)
    return NextResponse.json({ error: 'BOT_WORKER_SECRET unset' }, { status: 500 });
  const res = await fetch(`${httpBase()}/local-debug-eval/${token}/questions`, {
    cache: 'no-store',
  });
  return passThrough(res, await res.text());
}

export async function POST(req: Request): Promise<Response> {
  const { orgId } = await requireAuthedUserWithOrg();
  const token = await mintToken(orgId);
  if (token === null)
    return NextResponse.json({ error: 'BOT_WORKER_SECRET unset' }, { status: 500 });

  const body = (await req.json()) as { action?: string; question?: unknown; metrics?: boolean };
  const base = httpBase();

  if (body.action === 'run') {
    const res = await fetch(`${base}/local-debug-eval/${token}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // org is carried by the minted JWT only — never forwarded in the body
      // (the bot-worker derives org from the verified token). See security U1.
      body: JSON.stringify({ question: body.question, metrics: body.metrics === true }),
      cache: 'no-store',
    });
    return passThrough(res, await res.text());
  }
  if (body.action === 'add') {
    const res = await fetch(`${base}/local-debug-eval/${token}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.question),
      cache: 'no-store',
    });
    return passThrough(res, await res.text());
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 });
}
