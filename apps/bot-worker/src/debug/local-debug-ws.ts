/**
 * Local-debug WebSocket endpoint.
 *
 * Debug-only path that mirrors the production Recall pipeline using the
 * Linux PulseAudio sidecar as the audio source. Lets prompt + filter
 * iteration happen against the user's mic / system audio without
 * spawning a Recall bot per test.
 *
 * Lifecycle:
 *   1. Portal opens WS to /local-debug with a Bearer token (JWT signed
 *      with BOT_WORKER_SECRET; carries orgId).
 *   2. Server spawns SidecarRunner + DeepgramTranscriptionEngine.
 *   3. PCM frames from sidecar → engine.sendFrame.
 *   4. Deepgram emits finalized utterances → debug pipeline:
 *      embed → corpus search → emit cards → synthesizer → stream
 *      textDeltas → emit done.
 *   5. All events are sent as JSON messages over the WS for the portal
 *      to render. NO Supabase persistence; NO Realtime broadcast — the
 *      debug page reads everything from the WS directly.
 *   6. On WS close (client disconnect, server shutdown), stop the
 *      sidecar runner and Deepgram engine.
 *
 * NOT FOR PRODUCTION. Auth is intentionally lighter than the Recall
 * path (no per-meeting JWT scoping, no rate-limit), and the pipeline
 * skips persistence entirely. Gate the route behind a env flag in
 * production deployments.
 */

import { type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WebSocket } from 'ws';
import { SidecarRunner } from './sidecar-runner.js';
import { DeepgramTranscriptionEngine } from './deepgram.js';
import { VoyageEmbedder } from '@risezome/engine/embed';
import {
  AnthropicSynthesizer,
  parseSynthesisOutput,
  type SynthesisSource,
} from '@risezome/engine/synthesize';
import type { AudioFrame } from '@risezome/shared-types';
import type { Utterance } from '@risezome/engine/transcribe';

export interface LocalDebugHandlerArgs {
  readonly db: SupabaseClient;
  readonly orgId: string;
  readonly anthropicKey: string;
  readonly anthropicModel: string;
  readonly voyageKey: string;
  readonly deepgramKey: string;
  readonly sidecarPath?: string;
  readonly logger: {
    info: (obj: object, msg?: string) => void;
    warn: (obj: object, msg?: string) => void;
    error: (obj: object, msg?: string) => void;
  };
}

const TOP_K = 5;
const SYNTHESIS_MAX_TOKENS = 200;

export async function handleLocalDebugWs(
  socket: WebSocket,
  args: LocalDebugHandlerArgs,
): Promise<void> {
  const sidecarPath = args.sidecarPath ?? defaultSidecarPath();

  args.logger.info({ orgId: args.orgId, sidecarPath }, 'local-debug.start');

  // The sidecar's nonce-handshake protocol requires a SHA-256 manifest.
  // For debug usage we trust the local binary; compute the SHA on the
  // fly so the user doesn't have to maintain a manifest file.
  let runner: SidecarRunner;
  try {
    const sha = await computeFileSha256(sidecarPath);
    runner = new SidecarRunner({
      sidecarPath,
      manifest: { [sidecarPath]: { sha256: sha } },
      args: ['--role=system'],
    });
  } catch (err) {
    send(socket, { type: 'error', message: `sidecar init failed: ${String((err as Error).message)}` });
    socket.close();
    return;
  }

  const engine = new DeepgramTranscriptionEngine({ apiKey: args.deepgramKey });
  const embedder = new VoyageEmbedder({ apiKey: args.voyageKey });
  const synthesizer = new AnthropicSynthesizer({
    apiKey: args.anthropicKey,
    model: args.anthropicModel,
    maxTokens: SYNTHESIS_MAX_TOKENS,
  });

  // In-flight synthesis abort controller — a new utterance abandons
  // the prior synthesis mid-stream so we don't render stale answers.
  let currentSynthesisAbort: AbortController | null = null;

  runner.on('frame', (frame: AudioFrame) => {
    engine.sendFrame(frame.samples);
  });

  runner.on('error', (err: Error) => {
    args.logger.error({ err: err.message }, 'local-debug.sidecar.error');
    send(socket, { type: 'error', message: `sidecar: ${err.message}` });
  });

  runner.on('stopped', () => {
    args.logger.info({}, 'local-debug.sidecar.stopped');
    send(socket, { type: 'sidecar-stopped' });
  });

  // Forward partial utterances to the client for the live transcript
  // view (no pipeline trigger).
  engine.on('partial', (t) => {
    forwardUtterance(socket, t.utterance);
  });

  // Final utterances also flow to the client AND trigger the retrieval
  // pipeline. Abort any in-flight synthesis so the latest utterance
  // wins (mirrors the daemon's per-utterance abort contract).
  engine.on('final', (t) => {
    forwardUtterance(socket, t.utterance);
    if (t.utterance.text.trim().length === 0) return;
    if (currentSynthesisAbort !== null) currentSynthesisAbort.abort();
    const ac = new AbortController();
    currentSynthesisAbort = ac;
    void runDebugPipeline({
      utteranceText: t.utterance.text,
      utteranceId: t.utterance.utteranceId,
      socket,
      args,
      embedder,
      synthesizer,
      abortSignal: ac.signal,
    }).catch((err: unknown) => {
      args.logger.warn({ err: String(err) }, 'local-debug.pipeline.error');
      send(socket, { type: 'pipeline-error', message: String(err) });
    });
  });

  engine.on('error', (err: Error) => {
    args.logger.error({ err: err.message }, 'local-debug.deepgram.error');
    send(socket, { type: 'error', message: `deepgram: ${err.message}` });
  });

  // Start them.
  try {
    await engine.start();
    await runner.start();
    send(socket, { type: 'ready' });
  } catch (err) {
    args.logger.error({ err: String(err) }, 'local-debug.start.failed');
    send(socket, { type: 'error', message: `start failed: ${String(err)}` });
    socket.close();
    return;
  }

  const cleanup = async (): Promise<void> => {
    args.logger.info({}, 'local-debug.cleanup');
    if (currentSynthesisAbort !== null) currentSynthesisAbort.abort();
    try {
      await runner.stop();
    } catch (err) {
      args.logger.warn({ err: String(err) }, 'local-debug.runner.stop.error');
    }
    try {
      await engine.stop();
    } catch (err) {
      args.logger.warn({ err: String(err) }, 'local-debug.engine.stop.error');
    }
  };

  socket.on('close', () => {
    void cleanup();
  });
  socket.on('error', (err) => {
    args.logger.warn({ err: String(err) }, 'local-debug.ws.error');
    void cleanup();
  });
}

interface PipelineArgs {
  readonly utteranceText: string;
  readonly utteranceId: string;
  readonly socket: WebSocket;
  readonly args: LocalDebugHandlerArgs;
  readonly embedder: VoyageEmbedder;
  readonly synthesizer: AnthropicSynthesizer;
  readonly abortSignal: AbortSignal;
}

/**
 * Per-utterance pipeline. Embeds → searches → emits cards → runs
 * synthesizer → streams textDeltas → emits done with citations. No
 * persistence; everything goes to the WS as JSON events.
 */
async function runDebugPipeline(p: PipelineArgs): Promise<void> {
  const traceId = randomUUID();
  const synthesisId = `synth_${randomUUID()}`;
  const { socket, args, embedder, synthesizer, abortSignal } = p;

  // ── Embed
  send(socket, { type: 'embed-start', utteranceId: p.utteranceId, traceId });
  const embedResult = await embedder.embed({
    items: [{ text: p.utteranceText, domain: 'text' }],
  });
  if (abortSignal.aborted) return;
  const vec = embedResult.vectors[0]?.vector;
  if (vec === undefined) {
    send(socket, { type: 'retrieval-skip', reason: 'embed_no_vector', traceId });
    return;
  }

  // ── Hybrid search via the existing RPC
  const queryLiteral = `[${Array.from(vec).join(',')}]`;
  const { data: vectorRows, error: searchErr } = await args.db.rpc('search_corpus_vector', {
    p_org_id: args.orgId,
    p_query_vector: queryLiteral,
    p_limit: TOP_K,
  });
  if (searchErr !== null) {
    send(socket, { type: 'retrieval-skip', reason: 'search_failed', traceId, detail: searchErr.message });
    return;
  }
  const hits = (vectorRows ?? []) as Array<{ chunk_id: string; distance: number }>;
  if (hits.length === 0) {
    send(socket, { type: 'retrieval-skip', reason: 'no_hits', traceId });
    return;
  }

  // ── Enrich with chunk + doc metadata
  const chunkIds = hits.map((h) => h.chunk_id);
  const { data: chunkRows } = await args.db
    .from('doc_chunks')
    .select('chunk_id, doc_id, domain, text, position')
    .in('chunk_id', chunkIds);
  const chunkById = new Map(
    (chunkRows ?? []).map((c) => [
      c.chunk_id as string,
      {
        doc_id: c.doc_id as string,
        domain: c.domain as string,
        text: c.text as string,
        position: c.position as number,
      },
    ]),
  );
  const docIds = Array.from(new Set(Array.from(chunkById.values()).map((c) => c.doc_id)));
  const { data: docRows } = await args.db
    .from('docs')
    .select('id, source, type, title, url')
    .in('id', docIds);
  const docById = new Map(
    (docRows ?? []).map((d) => [
      d.id as string,
      {
        source: d.source as string,
        type: d.type as string,
        title: d.title as string,
        url: (d.url as string | null) ?? null,
      },
    ]),
  );

  // ── Build per-rank source list + emit card events
  const sources: SynthesisSource[] = [];
  const cardIds: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const chunk = chunkById.get(hit.chunk_id);
    if (chunk === undefined) continue;
    const doc = docById.get(chunk.doc_id);
    if (doc === undefined) continue;
    const cardId = `dbg_${randomUUID()}`;
    cardIds.push(cardId);
    sources.push({ rank: i + 1, title: doc.title, text: chunk.text });
    send(socket, {
      type: 'card',
      traceId,
      utteranceId: p.utteranceId,
      cardId,
      rank: i + 1,
      docId: chunk.doc_id,
      title: doc.title,
      source: doc.source,
      docType: doc.type,
      url: doc.url,
      snippet: chunk.text.slice(0, 400),
      body: chunk.text,
      distance: hit.distance,
    });
  }
  if (sources.length === 0) {
    send(socket, { type: 'retrieval-skip', reason: 'enrichment_empty', traceId });
    return;
  }

  if (abortSignal.aborted) return;

  // ── Synthesize, stream textDeltas, parse on done
  send(socket, {
    type: 'synthesisStart',
    synthesisId,
    sourceCardIds: cardIds,
    traceId,
    utteranceId: p.utteranceId,
  });

  let accumulated = '';
  try {
    for await (const chunk of synthesizer.synthesize(
      { utterance: p.utteranceText, sources },
      abortSignal,
    )) {
      if (abortSignal.aborted) return;
      if (chunk.type === 'textDelta') {
        accumulated += chunk.delta;
        send(socket, { type: 'synthesisDelta', synthesisId, delta: chunk.delta });
      } else if (chunk.type === 'done') {
        const parsed = parseSynthesisOutput(accumulated, sources.length);
        const richCitations = parsed.citations.flatMap((c) => {
          const cardId = cardIds[c.rank - 1];
          if (cardId === undefined) return [];
          return [
            {
              rank: c.rank,
              cardId,
              position: c.position,
              ...(c.quote !== undefined ? { quote: c.quote } : {}),
            },
          ];
        });
        send(socket, {
          type: parsed.isRefusal ? 'synthesisRefusal' : 'synthesisDone',
          synthesisId,
          stopReason: chunk.stopReason,
          accumulatedText: accumulated,
          citations: richCitations,
          usage: chunk.usage,
        });
        return;
      }
    }
  } catch (err) {
    if (abortSignal.aborted) return;
    send(socket, {
      type: 'synthesisError',
      synthesisId,
      message: (err as Error).message,
    });
  }
}

function forwardUtterance(socket: WebSocket, utt: Utterance): void {
  send(socket, {
    type: 'utterance',
    text: utt.text,
    isFinal: utt.isFinal,
    utteranceId: utt.utteranceId,
    revision: utt.revision,
    at: Date.now(),
  });
}

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== 1) return; // OPEN
  socket.send(JSON.stringify(payload));
}

function defaultSidecarPath(): string {
  // RISEZOME_SIDECAR_PATH env var wins when set.
  const fromEnv = process.env['RISEZOME_SIDECAR_PATH'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  // Walk up from this source file's location to find the repo root
  // (the directory containing the `sidecars/` folder). pnpm's dev
  // script sets cwd to apps/bot-worker/, not the repo root, so a
  // naive cwd-relative resolution misses by one directory.
  //
  // .../apps/bot-worker/src/debug/local-debug-ws.ts → walk up to
  // .../upwell/ (5 hops), then sidecars/linux/build/upwell-sidecar-linux.
  const here = fileURLToPath(import.meta.url);
  let dir = resolve(here, '..');
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'sidecars/linux/build/upwell-sidecar-linux');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // Last resort: cwd-relative. If we land here the resulting error
  // message ("ENOENT … apps/bot-worker/sidecars/…") is the signal
  // that walk-up found nothing — set RISEZOME_SIDECAR_PATH or build
  // the sidecar binary at sidecars/linux/build/upwell-sidecar-linux.
  return resolve(process.cwd(), 'sidecars/linux/build/upwell-sidecar-linux');
}

async function computeFileSha256(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  return new Promise((resolveSha, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolveSha(hash.digest('hex')));
    stream.on('error', reject);
  });
}
