// HTTP endpoints behind the eval dev page (portal /debug/eval), gated by
// LOCAL_DEBUG_ENABLED and authed with the same BOT_WORKER_SECRET JWT the
// local-debug WS uses (passed in the path, minted by the portal proxy). The
// portal calls these server-side (its own /api route), so no CORS is needed.
//
// Routes (prefixed /local-debug-eval/ to avoid the /local-debug/* WS wildcard):
//   GET  /local-debug-eval/:jwt/questions  -> { questions }
//   POST /local-debug-eval/:jwt/questions  -> append a golden question
//   POST /local-debug-eval/:jwt/run        -> evaluate one question (rich view)

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { VoyageEmbedder } from '@risezome/engine/embed';
import { AnthropicSynthesizer } from '@risezome/engine/synthesize';
import { makeAnthropicJudge } from '@risezome/engine/eval';
import { verifyBotWsJwt } from '../jwt.js';
import {
  evaluateQuestion,
  loadGoldenSet,
  appendGoldenQuestion,
  type EvalDeps,
  type GoldenQuestion,
} from '../corpus-eval.js';

export interface EvalRouteConfig {
  readonly db: SupabaseClient;
  readonly secret: string | undefined;
  readonly voyageKey: string | undefined;
  readonly anthropicKey: string | undefined;
}

/** Sanitize an untrusted body into a GoldenQuestion (drop unknown fields). */
function cleanQuestion(input: unknown): GoldenQuestion | null {
  if (typeof input !== 'object' || input === null) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.q !== 'string' || o.q.trim().length === 0) return null;
  const strArray = (v: unknown): readonly string[] | undefined =>
    Array.isArray(v) && v.length > 0 && v.every((x): x is string => typeof x === 'string')
      ? v
      : undefined;
  const must = strArray(o.must_surface);
  const expect = strArray(o.expect_answer_contains);
  return {
    q: o.q.trim(),
    ...(must !== undefined ? { must_surface: must } : {}),
    ...(expect !== undefined ? { expect_answer_contains: expect } : {}),
    ...(o.expect_refusal === true ? { expect_refusal: true } : {}),
    ...(typeof o.note === 'string' && o.note.length > 0 ? { note: o.note } : {}),
  };
}

export function registerEvalRoutes(instance: FastifyInstance, cfg: EvalRouteConfig): void {
  const enabled = (): boolean => process.env.LOCAL_DEBUG_ENABLED === 'true';

  // Gate + verify the path JWT. On failure sends the reply and returns null.
  const auth = async (jwt: string, reply: FastifyReply): Promise<{ orgId: string } | null> => {
    if (!enabled()) {
      await reply.code(403).send({ error: 'local-debug disabled (set LOCAL_DEBUG_ENABLED=true)' });
      return null;
    }
    if (cfg.secret === undefined || cfg.secret.length === 0) {
      await reply.code(500).send({ error: 'BOT_WORKER_SECRET unset' });
      return null;
    }
    try {
      const payload = await verifyBotWsJwt(jwt, cfg.secret);
      return { orgId: payload.orgId };
    } catch {
      await reply.code(401).send({ error: 'jwt-invalid' });
      return null;
    }
  };

  instance.get<{ Params: { jwt: string } }>(
    '/local-debug-eval/:jwt/questions',
    async (req, reply) => {
      const a = await auth(req.params.jwt, reply);
      if (a === null) return;
      await reply.send({ questions: loadGoldenSet() });
    },
  );

  instance.post<{ Params: { jwt: string } }>(
    '/local-debug-eval/:jwt/questions',
    async (req, reply) => {
      const a = await auth(req.params.jwt, reply);
      if (a === null) return;
      const q = cleanQuestion(req.body);
      if (q === null) {
        await reply.code(400).send({ error: 'a non-empty "q" is required' });
        return;
      }
      appendGoldenQuestion(q);
      await reply.send({ ok: true, questions: loadGoldenSet() });
    },
  );

  instance.post<{ Params: { jwt: string }; Body: { question?: unknown; metrics?: boolean } }>(
    '/local-debug-eval/:jwt/run',
    async (req, reply) => {
      const a = await auth(req.params.jwt, reply);
      if (a === null) return;
      if (
        cfg.voyageKey === undefined ||
        cfg.voyageKey.length === 0 ||
        cfg.anthropicKey === undefined ||
        cfg.anthropicKey.length === 0
      ) {
        await reply.code(500).send({ error: 'VOYAGE_API_KEY / ANTHROPIC_API_KEY unset' });
        return;
      }
      const question = cleanQuestion(req.body?.question);
      if (question === null) {
        await reply.code(400).send({ error: 'question.q is required' });
        return;
      }
      const deps: EvalDeps = {
        db: cfg.db,
        embedder: new VoyageEmbedder({ apiKey: cfg.voyageKey }),
        synthesizer: new AnthropicSynthesizer({ apiKey: cfg.anthropicKey }),
        // SECURITY: the org is the JWT-verified caller org ONLY. Never trust a
        // client-supplied org (a member of org A must not query org B's corpus
        // by passing its id). See security plan U1 / S1.
        orgId: a.orgId,
        judge: req.body?.metrics === true ? makeAnthropicJudge({ apiKey: cfg.anthropicKey }) : null,
      };
      const view = await evaluateQuestion(deps, question);
      await reply.send(view);
    },
  );
}
