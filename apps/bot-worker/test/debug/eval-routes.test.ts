import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { signBotWsJwt } from '../../src/jwt';

/**
 * Security regression for U1 / S1: the eval `/run` endpoint must derive the org
 * from the verified JWT ONLY. A caller authenticated for org A must never be
 * able to query org B's corpus by passing `orgId` in the request body.
 */

// Capture the deps handed to evaluateQuestion so we can assert which org it ran for.
const { evaluateQuestion } = vi.hoisted(() => ({
  evaluateQuestion: vi.fn(async (_deps: { orgId: string }) => ({ ok: true })),
}));
vi.mock('../../src/corpus-eval.js', () => ({
  evaluateQuestion,
  loadGoldenSet: () => [],
  appendGoldenQuestion: () => undefined,
}));

// Imported after the mock is registered.
const { registerEvalRoutes } = await import('../../src/debug/eval-routes');

const SECRET = 'test-secret-' + 'x'.repeat(40);
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeApp(): ReturnType<typeof Fastify> {
  // Match production (src/index.ts): the JWT travels as a path param and exceeds
  // Fastify's default maxParamLength of 100.
  const app = Fastify({ maxParamLength: 2000 });
  registerEvalRoutes(app, {
    db: {} as unknown as SupabaseClient,
    secret: SECRET,
    voyageKey: 'vk',
    anthropicKey: 'ak',
  });
  return app;
}

beforeAll(() => {
  process.env.LOCAL_DEBUG_ENABLED = 'true';
});
afterAll(() => {
  delete process.env.LOCAL_DEBUG_ENABLED;
});

describe('eval /run org isolation (U1)', () => {
  it('runs against the JWT org, ignoring a client-supplied body orgId', async () => {
    evaluateQuestion.mockClear();
    const app = makeApp();
    await app.ready();
    const token = await signBotWsJwt({ meetingId: 'eval', orgId: ORG_A }, SECRET, 600);

    const res = await app.inject({
      method: 'POST',
      url: `/local-debug-eval/${token}/run`,
      payload: { question: { q: 'what is x' }, metrics: false, orgId: ORG_B }, // hostile org override
    });

    expect(res.statusCode).toBe(200);
    expect(evaluateQuestion).toHaveBeenCalledTimes(1);
    const deps = evaluateQuestion.mock.calls[0]![0];
    expect(deps.orgId).toBe(ORG_A); // JWT org, NOT the body's ORG_B
    await app.close();
  });

  it('uses the JWT org when no body orgId is present', async () => {
    evaluateQuestion.mockClear();
    const app = makeApp();
    await app.ready();
    const token = await signBotWsJwt({ meetingId: 'eval', orgId: ORG_A }, SECRET, 600);

    const res = await app.inject({
      method: 'POST',
      url: `/local-debug-eval/${token}/run`,
      payload: { question: { q: 'what is x' }, metrics: false },
    });

    expect(res.statusCode).toBe(200);
    const deps = evaluateQuestion.mock.calls[0]![0];
    expect(deps.orgId).toBe(ORG_A);
    await app.close();
  });

  it('rejects an invalid JWT (401) before running anything', async () => {
    evaluateQuestion.mockClear();
    const app = makeApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/local-debug-eval/not-a-real-jwt/run`,
      payload: { question: { q: 'x' } },
    });
    expect(res.statusCode).toBe(401);
    expect(evaluateQuestion).not.toHaveBeenCalled();
    await app.close();
  });
});
