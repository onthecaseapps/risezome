// Test helper: build a `Response` whose body is a `ReadableStream` that
// emits SSE-formatted chunks. The existing `voyage.test.ts` pattern uses
// single-shot `new Response(string)`, which doesn't exercise the chunked
// `body.pipeThrough(new TextDecoderStream())` path. Anything that streams
// (Anthropic synthesis, future streaming providers) needs this helper.
//
// Usage:
//   const response = sseResponse({
//     events: [
//       { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: {...} } } },
//       { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
//       { event: 'message_stop', data: { type: 'message_stop' } },
//     ],
//   });

export interface SseEventInput {
  /** Optional explicit `event:` line. Omit and rely on the `type` field inside `data`. */
  readonly event?: string;
  /** JSON-serialized as the `data:` line. */
  readonly data: unknown;
  /** Optional pre-`data` delay (ms) — simulates real-network arrival pacing. */
  readonly delayMs?: number;
}

export interface SseResponseOptions {
  readonly events: readonly SseEventInput[];
  readonly status?: number;
  readonly headers?: Record<string, string>;
  /** When true, the stream terminates abruptly without a final blank line — exercises the parser's tail-flush. */
  readonly truncated?: boolean;
}

export function sseResponse(options: SseResponseOptions): Response {
  const encoder = new TextEncoder();
  const events = options.events;
  const truncated = options.truncated === true;

  // Web-standard ReadableStream (Node 22 global); do NOT import from
  // 'node:stream/web' — that's a different class and would break
  // body.pipeThrough() type compatibility on Response.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const ev of events) {
        if (typeof ev.delayMs === 'number' && ev.delayMs > 0) {
          await new Promise((r) => setTimeout(r, ev.delayMs));
        }
        const lines: string[] = [];
        if (typeof ev.event === 'string') lines.push(`event: ${ev.event}`);
        lines.push(`data: ${JSON.stringify(ev.data)}`);
        lines.push('');
        lines.push('');
        controller.enqueue(encoder.encode(lines.join('\n')));
      }
      if (truncated) {
        // Skip the trailing blank line — leaves a partial block in the buffer.
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/event-stream',
      ...(options.headers ?? {}),
    },
  });
}

// Convenience: emit one SSE block as a raw byte payload (used by tests that
// need to assemble a chunked stream by hand — e.g., abort-mid-stream tests).
export function sseChunk(eventType: string, data: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}
