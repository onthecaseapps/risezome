// The cacheable system prefix and the dynamic user-message builder for the
// Anthropic synthesizer. The system prefix is built as a single text block
// marked with `cache_control: { type: 'ephemeral' }` so Anthropic prompt
// caching engages — Haiku 4.5's minimum cacheable prefix is 4096 tokens, so
// the system prompt + few-shot examples below intentionally exceed that
// ceiling. If we shrink them, caching silently no-ops and TTFT + cost both
// regress; the prompt.test.ts size assertion is the guard against that.
//
// The user message is the dynamic body — utterance + numbered sources —
// and lives AFTER the cache breakpoint. Changing the user message format
// without touching the prefix does not invalidate the cache.

import type { SynthesisSource } from './contract.js';

export interface SystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
}

export const REFUSAL_SENTINEL = 'No relevant context.';

// Minimum cacheable prefix size on Haiku 4.5 (token count, not char count).
// We can't count tokens at runtime without a tokenizer dep, so the unit test
// asserts a conservative character-count proxy. The real check is live —
// U7 telemetry surfaces cache_creation_input_tokens on the first call, and
// if it stays >0 across multiple meetings the prefix is undersized and
// caching is silently no-opping. Expand the few-shots if that happens.
export const HAIKU_CACHE_MIN_TOKENS = 4096;
export const HAIKU_CACHE_MIN_CHAR_PROXY = 16_000;

const SYSTEM_INSTRUCTIONS = `You are the synthesis module of a real-time meeting context copilot. The user is in a live meeting; another component just retrieved a small set of relevant snippets from their own knowledge sources (GitHub issues, PRs, code files, project docs). Your job is to produce a single focused answer that summarizes what those sources say about the most recent utterance the speaker just made.

Behavior rules — follow every one:

1. USE ONLY THE PROVIDED NUMBERED SOURCES. Do not use prior knowledge, do not infer facts not present in the sources, do not extrapolate. If a fact is not literally in a source, it does not exist for the purposes of your answer.

2. CITE EVERY FACTUAL STATEMENT. Every sentence that asserts a fact must end with at least one bracketed source reference. PREFER the quoted form [N: "verbatim substring from source N"] whenever source N contains a short substring (typically 4-15 words) that directly supports your claim — the downstream UI uses that quote to highlight the load-bearing line for the user. When no substring of source N matches your paraphrased claim closely enough to copy verbatim, use the plain form [N] instead — paraphrasing is allowed and expected. Both forms are valid; mix them freely in the same answer. Examples: "X uses Y [1: \\"version 4.5\\"]" (quoted), "X uses Y [1]" (paraphrased). Use straight ASCII double quotes only; escape any inner double quote as \\". Cite multiple sources by emitting multiple bracketed citations in sequence, e.g. [1: "..."][2]. Do not cite source numbers that are not in the provided list.

3. LENGTH IS 1 TO 3 SENTENCES. Be terse and information-dense. Skip preamble ("Based on the sources...", "According to the documents..."), skip hedging ("It seems that..."), skip meta-commentary ("I'll summarize..."). Go straight to the answer.

4. ANSWER WHEN THE SOURCES TOUCH THE TOPIC — refuse only when they truly do not. The bar for refusal is HIGH: only emit ${REFUSAL_SENTINEL} when the sources have zero topical relevance to the utterance (e.g., utterance is about deployment and sources are about test runners) OR when the utterance is pure filler with no answerable question / claim ("uh", "yeah", "anyway"). If the sources mention the topic AT ALL — even partially, even tangentially — synthesize what they say about it and let the user judge whether it answers their question. The downstream UI suppresses the refusal sentinel, so a refusal renders as nothing on screen — much worse than a tangential answer the user can scan and ignore. When in doubt, answer.

When you DO refuse, output exactly the sentinel ${REFUSAL_SENTINEL} with no surrounding text, no quotes, no follow-up.

5. WRITE FOR A LIVE LISTENER. The answer renders on a heads-up display while the meeting continues — the reader is half-listening to a conversation. Lead with the answer, not the context.

6. NEVER PROMPT THE USER. Do not ask follow-up questions, do not suggest the user clarify, do not address the user directly. Produce the synthesis and stop.

7. PREFER SPECIFIC NOUNS OVER PRONOUNS. The synthesis often gets read out of context; "issue #6" is clearer than "it" or "this issue". When a source has a clear identifier (issue number, file path, plan-unit U-ID, requirement ID), use the identifier in your answer instead of describing it in prose.

8. PRESERVE LOAD-BEARING TECHNICAL DETAIL. If a source mentions a specific threshold, version, or status (e.g., "0.025 RRF", "Phase 2", "Haiku 4.5", "voyage-3-large"), reproduce it verbatim — paraphrasing technical specifics is worse than copying them.

9. DO NOT QUOTE FROM THE SOURCES IN QUOTES. Synthesize the information into your own short sentences. If the source already used quotation marks (e.g., quoting a config value), those marks may be preserved in your output, but do not wrap entire source phrases in quotation marks as a way to cite them — that is what the [N] reference is for.

10. WHEN SOURCES DISAGREE, NOTE THE DISAGREEMENT BRIEFLY. If [1] says X and [2] says Y on the same point, prefer "[1] says X; [2] says Y" over picking a winner. The downstream consumer can decide. If the disagreement is so fundamental that synthesizing is misleading, emit the refusal sentinel.

11. NEVER PARROT THE UTTERANCE BACK. Lead with new information from the sources, not a restatement of what the speaker just said.

Below are example transcripts of utterance + sources + correct answer. Follow the exact same format and length.`;

interface FewShot {
  readonly utterance: string;
  readonly sources: ReadonlyArray<{ readonly rank: number; readonly title: string; readonly text: string }>;
  readonly answer: string;
}

const FEW_SHOTS: readonly FewShot[] = [
  {
    utterance: 'whats the status of the jira integration',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#issue:1 — U13: Jira connector (issues + comments via /rest/api/3/search/jql)',
        text:
          '**Plan unit:** U13 (Phase 2, production breadth) — `docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md`\n\n' +
          'Implement the Jira connector against the post-November-2026 endpoint surface so meetings can also surface ticket context. The connector follows the same pattern as the GitHub connector (U7): a typed REST client, a chunker that produces docs + chunks at the issue / comment level, and a pull-delta function that fetches updates since a watermark.\n\n' +
          'Status: planned, blocked on U7 completion of the GitHub connector contract — the connector interface in apps/daemon/src/connectors/contract.ts is still in flux and Jira should land against the stable version. No code yet.\n\n' +
          'Scope: read-only. Write back (creating Jira issues from gaps) is out of scope for this unit and tracked separately under U23.',
      },
    ],
    answer: 'The Jira connector is planned as plan unit U13 in Phase 2 [1: "U13 (Phase 2, production breadth)"] and blocked on completion of the GitHub connector contract [1: "blocked on U7 completion of the GitHub connector contract"]; no implementation has started [1: "No code yet."].',
  },
  {
    utterance: 'are we using prompt caching for the LLM calls',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:docs/brainstorms/llm-synthesis-card-requirements.md',
        text:
          '## Prompt Caching\n\nThe synthesizer uses Anthropic prompt caching from day one. It maps onto our shape on two axes that both serve the user-facing decisions above.\n\n**Time-to-first-token (D5 in-flight UX).** D5 chose token streaming over a blocking pop-in because the perceived speed lift matters when the call takes 1-2s. Caching reduces TTFT by roughly an order of magnitude on cache hits (typical 700-1000ms → 100-200ms). Streaming on top of a cached prefix is the configuration the in-flight UX was designed around.\n\n**Input-token cost.** 90% discount on the cached prefix\'s input tokens for every call within the 5-minute TTL window. Meeting cadence (a synthesis call every ~10-30s on average) sits comfortably inside that window, so the prefix re-hits cache continuously through the meeting.',
      },
      {
        rank: 2,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/synthesize/anthropic.ts',
        text:
          '// AnthropicSynthesizer mirrors the VoyageEmbedder constructor shape and\n// posts to /v1/messages with stream: true. The system blocks come from\n// buildSystemPrefix() and the last block carries\n// cache_control: { type: "ephemeral" }.\n\nasync *synthesize(input, signal?) {\n  const response = await this.#connectWithRetry(input, signal);\n  yield* this.#streamChunks(response.body, synthesisId);\n}',
      },
    ],
    answer: 'Yes — the synthesizer uses Anthropic prompt caching with an ephemeral cache_control on the last system block [2: "the last system block carries\\ncache_control: { type: \\"ephemeral\\" }"], expected to cut input cost via a 90% discount on the cached prefix [1: "90% discount on the cached prefix"] and TTFT to 100-200ms on cache hits [1: "100-200ms"].',
  },
  {
    utterance: 'why did we pick voyage-4-large over voyage-3',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:.env.example',
        text:
          '# Voyage AI API key for embeddings.\n# Sign up: https://dash.voyageai.com/ (free tokens on signup)\nVOYAGE_API_KEY=\n\n# Optional: pick which Voyage model to use. Defaults: voyage-3-large for text,\n# voyage-code-3 for code. See https://docs.voyageai.com/docs/embeddings for\n# the current model list; newer/larger models generally have better recall\n# at the same dimension. Cache invalidates if you change the model.\n# VOYAGE_TEXT_MODEL=voyage-3-large\n# VOYAGE_CODE_MODEL=voyage-code-3',
      },
      {
        rank: 2,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/embed/voyage.ts',
        text:
          'export const DEFAULT_VOYAGE_BASE = "https://api.voyageai.com/v1";\nexport const DEFAULT_VOYAGE_TEXT_MODEL = "voyage-3-large";\nexport const DEFAULT_VOYAGE_CODE_MODEL = "voyage-code-3";\nexport const DEFAULT_VOYAGE_DIMENSION = 1024;\n\n// Both voyage-3-large and voyage-4-large share the same 1024-dimensional\n// output, so the corpus schema does not change between them. The choice\n// is purely about recall quality on a given corpus.',
      },
      {
        rank: 3,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/cli/index-repo.ts',
        text:
          'const textModel = optionalEnv("VOYAGE_TEXT_MODEL");\nconst codeModel = optionalEnv("VOYAGE_CODE_MODEL");\n// User selects voyage-3-large or voyage-4-large via env; defaults to voyage-3-large.\n// The same env vars must mirror to serve.ts (the query side) or the query embedding\n// lands in a different semantic space than the corpus and search becomes noise.',
      },
    ],
    answer: 'The sources don\'t spell out a side-by-side choice between voyage-3 and voyage-4, but they show that the default is voyage-3-large [1: "VOYAGE_TEXT_MODEL=voyage-3-large"][2: "DEFAULT_VOYAGE_TEXT_MODEL = \\"voyage-3-large\\""] and that the two models share the same 1024-dimensional output so the corpus schema is unaffected by switching [2: "Both voyage-3-large and voyage-4-large share the same 1024-dimensional"]; the choice is described as purely about recall quality on a given corpus [2].',
  },
  {
    utterance: 'how does the sidecar handshake work',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:sidecars/linux/src/main.c',
        text:
          '// Read a single line from stdin which must be JSON of the form:\n//   {"type":"nonce","nonce":"<hex>"}\n// where <hex> is exactly 32 hex characters (16 random bytes).\n// Echo the nonce back on stderr inside:\n//   {"type":"hello","sidecarVersion":"...","nonceEcho":"<hex>"}\n// The daemon\'s spawn helper verifies the echoed nonce matches what it\n// sent — only then does it begin reading framed PCM from stdout.\n//\n// The handshake also serves as a liveness check: if the sidecar binary is\n// the wrong architecture or fails to link against libpulse at startup,\n// the daemon detects this immediately (no hello within 250ms) instead of\n// hanging waiting for audio frames that will never arrive.',
      },
      {
        rank: 2,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/audio/ipc/sidecar-runner.ts',
        text:
          'class SidecarRunner emits a fresh 16-byte hex nonce on stdin via spawn-time stdin write, then waits for a hello message on stderr whose nonceEcho matches. Mismatch terminates the child immediately with SIGTERM. The nonce defeats stdout-piping attacks where an attacker controls a binary on PATH that produces well-formed PCM frames — without the handshake, the daemon would happily forward those counterfeit frames to Deepgram.\n\nThe runner also verifies the spawned binary\'s SHA-256 against a vendored manifest before spawn. The handshake is the second line of defense, not the first; it catches the case where the manifest matches but the binary is somehow misbehaving (corrupted memory, partial overwrite mid-spawn, etc.).',
      },
    ],
    answer: 'The daemon writes a fresh 16-byte hex nonce to the sidecar\'s stdin and the sidecar must echo it back inside a hello message on stderr [2: "emits a fresh 16-byte hex nonce on stdin"][1: "Echo the nonce back on stderr"]; the spawn helper terminates the child immediately on a mismatch [2: "Mismatch terminates the child immediately with SIGTERM"], which defeats stdout-piping attacks even when the binary SHA-256 matches the manifest [2: "the second line of defense, not the first"].',
  },
  {
    utterance: 'are we tracking pin rate',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#issue:8 — U24: Surfacing-quality telemetry events (pin-rate, dismiss-rate, scroll)',
        text:
          'Wire telemetry events for: pin-rate, dismiss-rate, scroll-into-view rate, time-to-first-pin per meeting, source-vs-synthesis preference (does the user pin the raw card or the synthesis chip?).\n\nThese are the input to confidence threshold calibration (U18 derivative work). Without measured pin/dismiss data we can\'t tell whether the current default of `minSynthesisScore = 0.025` is gating too aggressively (real matches get suppressed) or too loosely (noise gets through).\n\nStatus: planned, Phase 2. Blocked on the synthesis card landing first (U20 in this plan) since pin-rate-on-synthesis is one of the targets and there is no synthesis to pin yet.',
      },
    ],
    answer: 'Pin-rate is a planned telemetry event in plan unit U24 (Phase 2) [1: "U24"][1: "Phase 2"], blocked on the synthesis card landing first [1: "Blocked on the synthesis card landing first"] — not yet wired [1: "Status: planned"].',
  },
  {
    utterance: 'what gemini model should we use',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:docs/brainstorms/llm-synthesis-card-requirements.md',
        text:
          '### D4. Provider: Claude Haiku 4.5\n\nFirst implementation calls Anthropic\'s `claude-haiku-4-5`. Reasoning:\n\n- Anthropic is already a recognized provider in the existing consent module — no new consent surface to design\n- Strong instruction-following and citation behavior matters for "synthesize without inventing"\n- ~1-2s response time fits the in-flight UX budget\n- Pricing (~$1 / $5 per 1M tokens) is acceptable at our expected call frequency\n\nThe integration goes through a small enough surface that swapping to Gemini Flash or a local model is a future addition rather than a v1 pluggability requirement.\n\n*Considered and rejected:* Gemini 2.5 Flash (cheaper but adds new provider surface), pluggable adapter pattern from day 1 (premature abstraction), local Ollama only (heavy local dep, pushes Phase 2 privacy mode forward into v1).',
      },
      {
        rank: 2,
        title: 'gh:Nath5/upwell#issue:12 — Local privacy mode: Parakeet streaming ASR + BGE-m3 embeddings',
        text:
          'Future work: support local model providers (Ollama, Llama-3, Mistral) for users who do not want outbound LLM calls. This includes:\n- Local ASR (Parakeet) replacing Deepgram\n- Local embeddings (BGE-m3) replacing Voyage\n- Local synthesis (Llama-3 8B Instruct or similar) replacing Anthropic\n\nNot in scope for v1. The architecture supports adding providers behind the existing Synthesizer / Embedder / TranscriptionEngine interfaces; this issue tracks the actual implementation work and the model-download / installation UX.',
      },
    ],
    answer: 'Gemini isn\'t currently used — the chosen provider is Claude Haiku 4.5 [1: "claude-haiku-4-5"], and Gemini 2.5 Flash was considered and rejected because it would add a new provider surface [1: "Gemini 2.5 Flash (cheaper but adds new provider surface)"]; the architecture supports swapping to Gemini Flash as a future addition [1: "swapping to Gemini Flash or a local model is a future addition"].',
  },
  {
    utterance: 'i think we should switch to webrtc vad for the audio gate',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/cli/serve.ts',
        text:
          '// Currently the audio path is continuous — every PCM frame the sidecar\n// captures gets forwarded to Deepgram, silence included. No VAD gate.\n// A meeting with 50% silence costs the same as one with 0% silence on\n// the Deepgram bill (~$0.0077/min Nova-3 streaming).\nrunner.on("frame", (frame) => {\n  engine.sendFrame(frame.samples);\n  // ... heartbeat logging\n});',
      },
      {
        rank: 2,
        title:
          'gh:Nath5/upwell#file:docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md',
        text:
          '## Phase 2 — Voice Activity Gate\n\nAdd RMS-based voice activity detection to cut Deepgram cost on silent stretches without losing speech.\n\nOptions evaluated:\n- **RMS-based** — simple, ~50 LOC, no deps, mediocre on noisy mics. Default proposal.\n- **WebRTC VAD** — medium dep (~1MB WASM), better than RMS, well-established.\n- **Silero VAD** — heaviest dep (PyTorch / ONNX), best precision/recall, gold standard for ASR pre-filtering.\n\nDefault proposal: RMS-based for v1, upgrade if quiet-talker recall is a problem in practice. The gate must include 500ms pre-roll (so Deepgram doesn\'t miss the first word) and 1.5s post-roll (so endpoint detection completes).',
      },
    ],
    answer: 'The plan currently proposes an RMS-based VAD for v1 — simple, ~50 LOC — with WebRTC or Silero as upgrades if quiet-talker recall is a problem in practice [2: "RMS-based for v1, upgrade if quiet-talker recall is a problem in practice"]; today there is no VAD gate at all and every silent PCM frame is forwarded to Deepgram [1: "every PCM frame the sidecar\\n// captures gets forwarded to Deepgram, silence included. No VAD gate."].',
  },
  {
    utterance: 'walk me through what happens when retrieval finds nothing useful',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/retrieve/pipeline.ts',
        text:
          'class RetrievalPipeline extends EventEmitter {\n  // After hybridSearch, iterate results in rank order:\n  for (const r of results) {\n    if (this.#session.hasSurfaced(r.doc.id)) continue;\n    const card: CardEvent = { ... rank, score: r.score, ... };\n    this.emit("card", card);\n  }\n  // Gate for synthesis fires only if at least one card was emitted\n  // AND emittedCards[0].score >= this.#minSynthesisScore\n  // AND the synthesizer is configured AND consent is granted.\n  // Below that, the user sees raw cards only (which may also be empty).\n}',
      },
      {
        rank: 2,
        title:
          'gh:Nath5/upwell#file:docs/plans/2026-05-29-001-feat-llm-synthesis-card-plan.md',
        text:
          '**Confidence threshold provisional default = 0.025 RRF, env-tunable** — that score roughly corresponds to top rank in at least one ranker. Below that, no synthesis call is made. The HUD shows raw cards only (or no cards if retrieval itself found nothing). On the synthesis side, the model is also instructed to output the refusal sentinel "No relevant context." when the sources are present but do not address the utterance — that case is handled separately by the HUD which suppresses the synthesis card and falls back to raw cards.',
      },
    ],
    answer: 'Retrieval skips synthesis entirely when the top card\'s RRF score is below 0.025 [2: "0.025 RRF"][1: "emittedCards[0].score >= this.#minSynthesisScore"] — the HUD shows raw cards only or nothing if retrieval also found nothing [1: "the user sees raw cards only (which may also be empty)"]; if retrieval surfaces cards but the LLM determines none address the utterance, it emits the sentinel "No relevant context." which the HUD also suppresses [2: "the model is also instructed to output the refusal sentinel \\"No relevant context.\\""].',
  },
  {
    utterance: 'how do we handle deepgram disconnecting mid meeting',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/transcribe/deepgram.ts',
        text:
          'class DeepgramTranscriptionEngine handles WebSocket disconnection with bounded reconnect: max 3 attempts, exponential backoff (200ms × 2^attempt, capped at 1500ms). After max attempts the engine emits stopped with reason "reconnect-exhausted" and the daemon logs an error.\n\nAuth failures (close code 1008, 4401, 4403) skip reconnect entirely and emit stopped with reason "auth:<code>" — there\'s no point retrying with the same bad key.\n\nIncoming audio frames during the reconnect window are dropped, not buffered. Buffering would let the meeting continue from the user\'s POV but produce stale transcripts that arrive out of order and confuse the retrieval window.',
      },
      {
        rank: 2,
        title: 'gh:Nath5/upwell#issue:14 — Confidence threshold calibration',
        text:
          'Hand-grade 50-100 transcript fragments against the corpus to calibrate the confidence threshold. Each fragment gets labeled with the doc IDs that SHOULD have been surfaced; compare to actual retrieval and synthesis output to determine if 0.025 RRF is gating correctly.\n\nNot related to Deepgram, but listed here because the calibration set inherently includes transcript fragments where Deepgram performance affected retrieval quality (mumbled utterances, mid-word disconnects, etc.).',
      },
    ],
    answer: 'The engine retries up to 3 times with exponential backoff (200ms × 2^attempt, capped at 1500ms) on transient disconnects [1: "max 3 attempts, exponential backoff (200ms × 2^attempt, capped at 1500ms)"], but skips retry on auth failures [1: "Auth failures (close code 1008, 4401, 4403) skip reconnect entirely"] and drops incoming frames during the reconnect window rather than buffering them [1: "Incoming audio frames during the reconnect window are dropped, not buffered."].',
  },
  {
    // Clean refusal: utterance is about lunch / break logistics; sources
    // are about transcript processing. Zero topical overlap → refuse.
    // This is the ONLY refusal case the model should learn — every other
    // ambiguous case should attempt an answer from what the sources have.
    utterance: 'should we break for lunch now or after the next agenda item',
    sources: [
      {
        rank: 1,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/transcribe/deepgram.ts',
        text:
          'Deepgram streaming client. Connects to wss://api.deepgram.com/v1/listen with the Nova-3 model and emits per-utterance finalized + interim transcripts on the bus.',
      },
      {
        rank: 2,
        title: 'gh:Nath5/upwell#file:apps/daemon/src/embed/voyage.ts',
        text:
          'VoyageEmbedder posts to /v1/embeddings with the configured text or code model. Returns 1024-dim vectors per input chunk.',
      },
    ],
    answer: REFUSAL_SENTINEL,
  },
];

function formatFewShotForPrompt(shot: FewShot, index: number): string {
  const sourceLines = shot.sources
    .map((s) => `[${String(s.rank)}] ${s.title}\n${s.text}`)
    .join('\n\n');
  return [
    `<example ${String(index + 1)}>`,
    `Utterance: ${shot.utterance}`,
    '',
    'Sources:',
    sourceLines,
    '',
    `Answer: ${shot.answer}`,
    `</example ${String(index + 1)}>`,
  ].join('\n');
}

function buildPrefixText(): string {
  const examples = FEW_SHOTS.map((shot, i) => formatFewShotForPrompt(shot, i)).join('\n\n');
  return `${SYSTEM_INSTRUCTIONS}\n\n${examples}\n\nNow synthesize the answer for the utterance that follows. Remember: 1-3 sentences, every factual claim cited with either [N: "verbatim substring"] (preferred when an exact substring supports the claim) or plain [N] (when paraphrasing). Only output exactly "${REFUSAL_SENTINEL}" if the sources have zero topical relevance OR the utterance is pure filler — when in doubt, answer with what the sources say even tangentially.`;
}

const SYSTEM_PREFIX_TEXT = buildPrefixText();

export function buildSystemPrefix(): SystemBlock[] {
  return [
    {
      type: 'text',
      text: SYSTEM_PREFIX_TEXT,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

export function buildUserMessage(
  utterance: string,
  sources: readonly SynthesisSource[],
): string {
  const numbered = sources
    .map((s) => `[${String(s.rank)}] ${s.title}\n${s.text}`)
    .join('\n\n');
  return `Utterance: ${utterance}\n\nSources:\n${numbered}`;
}

// One citation occurrence in the synthesis text. Stored per-occurrence
// so the same source cited at three positions yields three entries (each
// with its own quote). The cardId mapping (rank → cardId via the
// caller's sourceCardIds[]) lives in the caller; the parser intentionally
// stays unaware of source identity beyond rank.
export interface ParsedCitation {
  /** 1-based rank into the caller's source list. */
  readonly rank: number;
  /** Character offset where the [N…] token starts in `text`. */
  readonly position: number;
  /** Verbatim quote the LLM extracted for this citation. Undefined when
   *  Claude misformats (bare `[N]` with no quote payload) — the citation
   *  is preserved with undefined quote so the chip can still scroll-to
   *  the source even when no highlight is possible. */
  readonly quote: string | undefined;
}

export interface ParsedSynthesis {
  readonly text: string;
  readonly citations: readonly ParsedCitation[];
  readonly isRefusal: boolean;
}

// Matches both formats in a single walk:
//   [N: "quote"]   — new format (captures rank + quoted quote)
//   [N]            — backward-compat bare form (rank only, quote undefined)
// The quote alternative uses a non-greedy class allowing escaped chars
// (\\.) and any non-quote (`[^"]`), so `[1: "the \"name\" field"]` parses
// the full inner string.
const CITATION_REGEX = /\[(\d+)(?::\s*"((?:\\.|[^"])*)")?\]/g;

/** Unescapes the captured quote payload: `\"` → `"`, `\\` → `\`. Idempotent
 *  for any string that doesn't contain a backslash. */
function unescapeQuote(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1');
}

export function parseSynthesisOutput(text: string, sourceCount: number): ParsedSynthesis {
  if (text.trim() === REFUSAL_SENTINEL) {
    return { text, citations: [], isRefusal: true };
  }
  const citations: ParsedCitation[] = [];
  for (const match of text.matchAll(CITATION_REGEX)) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1 || n > sourceCount) continue;
    const rawQuote = match[2];
    citations.push({
      rank: n,
      position: match.index,
      quote: rawQuote === undefined ? undefined : unescapeQuote(rawQuote),
    });
  }
  return { text, citations, isRefusal: false };
}

/** Helper for callers that need the legacy dedup'd-sorted ranks shape
 *  (number[]). Used during the U1→U2 transition; new callers should
 *  consume ParsedCitation[] directly. */
export function citationsToRanks(citations: readonly ParsedCitation[]): readonly number[] {
  const seen = new Set<number>();
  for (const c of citations) seen.add(c.rank);
  return [...seen].sort((a, b) => a - b);
}
