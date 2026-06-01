// The cacheable system prefix and the dynamic user-message builder for the
// Anthropic synthesizer. The system prefix is built as a single text block
// marked with `cache_control: { type: 'ephemeral' }` so Anthropic prompt
// caching engages. Haiku 4.5's minimum cacheable prefix is 4096 tokens, so
// the system prompt + few-shot examples below intentionally exceed that
// ceiling. If we shrink them, caching silently no-ops and TTFT + cost both
// regress; the prompt.test.ts size assertion is the guard against that.
//
// The user message is the dynamic body (the recent transcript window +
// numbered sources) and lives AFTER the cache breakpoint. Changing the user
// message format without touching the prefix does not invalidate the cache.
//
// OUTPUT PROTOCOL: the model's first line is a machine-readable status tag
// (`STATUS: answer` or `STATUS: no_relevant_context`). This makes the
// refuse-vs-answer decision deterministic to parse instead of relying on a
// free-text sentinel that the model can wrap in prose. The status line is
// stripped before the answer body is streamed to the UI (see
// stripStatusPrefix). The legacy `No relevant context.` sentinel is still
// recognized as a fallback when a non-compliant response omits the tag.
//
// GROUNDING: the few-shot examples use a FICTIONAL product ("Marina", a
// boat-rental marketplace) with invented proper nouns. This is deliberate.
// If the examples contained this product's real stack (model names, vendors,
// plan-unit IDs), the model would recite those facts as if grounded whenever
// retrieval came back weak, citing whatever source was handy. Keeping the
// few-shots in an unrelated fictional domain means there is nothing real to
// leak: the model must answer from the retrieved sources or decline.

import type { SynthesisSource } from './contract.js';

export interface SystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral' };
}

/** Machine-readable first-line decision tag. */
export type SynthesisStatus = 'answer' | 'no_relevant_context';
export const STATUS_ANSWER = 'STATUS: answer';
export const STATUS_NO_CONTEXT = 'STATUS: no_relevant_context';

/** Legacy free-text refusal marker. Retained only as a parse fallback for
 *  responses that omit the STATUS line. */
export const REFUSAL_SENTINEL = 'No relevant context.';

// Minimum cacheable prefix size on Haiku 4.5 (token count, not char count).
// We can't count tokens at runtime without a tokenizer dep, so the unit test
// asserts a conservative character-count proxy. The real check is live:
// U7 telemetry surfaces cache_creation_input_tokens on the first call, and
// if it stays >0 across multiple meetings the prefix is undersized and
// caching is silently no-opping. Expand the few-shots if that happens.
export const HAIKU_CACHE_MIN_TOKENS = 4096;
export const HAIKU_CACHE_MIN_CHAR_PROXY = 16_000;

const SYSTEM_INSTRUCTIONS = `You are the synthesis module of a real-time meeting context copilot. The user is in a live meeting; another component just retrieved a small set of relevant snippets from their own knowledge sources (GitHub issues, PRs, code files, project docs). Your job is to answer the question the recent transcript window is asking, using only those snippets.

OUTPUT PROTOCOL (read this first):

Your VERY FIRST line must be exactly one of these two tags, with nothing else on the line:
STATUS: answer
STATUS: no_relevant_context

- "STATUS: answer" means you are answering. Write the 1 to 3 sentence synthesis on the lines AFTER the status line, with inline citations.
- "STATUS: no_relevant_context" means you are declining. You MAY add one short sentence on the next line saying why you declined; that sentence is used only for an internal debug view and is never shown to the end user (production renders nothing at all when you decline). Do NOT write a synthesis when you decline.

Never put anything except the status word on the first line. Never produce a synthesis without a status line above it.

CHOOSING THE STATUS:

The bar for "no_relevant_context" is HIGH. Choose "answer" whenever the sources touch the topic at all, even partially or tangentially, and let the user judge whether it helps. Choose "no_relevant_context" ONLY when one of these holds:
- The sources have zero topical relevance to what the window is about (for example, the window is about lunch logistics and the sources are about test runners).
- The recent transcript window AS A WHOLE contains no answerable question or claim (pure filler such as "uh", "yeah", "anyway").

Judge filler across the WHOLE window, never the latest line alone. A short final line like "what ai models" is NOT filler when an earlier line ("models are used here") completes it into a real question ("what AI models are used here"). Assemble the question from the window before you decide. If you can state what the speaker is asking, you have an answerable question.

When a source is split into a "Matched excerpt" and "Surrounding context", judge that source's RELEVANCE from the matched excerpt alone, because the matched excerpt is the passage retrieval actually selected for this question. The surrounding context is wider supporting material that legitimately ranges beyond the question, so do NOT treat its broader scope as a reason to decline. If any matched excerpt is on-topic, you have relevant context, answer; then use the surrounding context to make the answer complete and specific.

When in doubt, answer. Declining renders as nothing on the user's screen, which is worse than a tangential answer they can scan and ignore.

GROUNDING IS ABSOLUTE:

Answer ONLY from the numbered sources provided in this specific request. Do NOT use facts from the example transcripts below, do NOT use general knowledge, do NOT use anything you remember about how systems like this are usually built. The examples below teach you the FORMAT and the CITATION STYLE; their content is about an unrelated fictional product and must never appear in a real answer. If the sources in front of you do not contain a fact, that fact does not exist for your answer, no matter how confident you feel about it. A confident answer with a citation that does not actually support it is the worst possible output.

BEHAVIOR RULES FOR THE ANSWER BODY (follow every one):

1. USE ONLY THE PROVIDED NUMBERED SOURCES. Do not use prior knowledge, do not infer facts not present in the sources, do not extrapolate. If a fact is not literally in a source, it does not exist for the purposes of your answer.

2. CITE EVERY FACTUAL STATEMENT, AND MAKE THE CITATION REAL. Every sentence that asserts a fact must end with at least one bracketed source reference. STRONGLY PREFER the quoted form [N: "verbatim substring from source N"]: copy a short substring (typically 4-15 words) that ACTUALLY appears in source N and directly supports your claim. The downstream UI highlights that substring, and a verifier drops any quote that is not found verbatim in source N, so an invented quote silently deletes your citation. Only use the bare form [N] when you are paraphrasing and no single substring captures the claim. Use straight ASCII double quotes only; escape any inner double quote as \\". Cite multiple sources in sequence, e.g. [1: "..."][2]. Never cite a source number that is not in the provided list, and never attach a quote that is not in that source.

   THE CITATION IS INVISIBLE TO THE READER except as a small numbered chip: the quoted text inside [N: "..."] is NEVER shown inline, it only drives a source highlight. So every fact, name, number, and noun must stand on its own in your prose. NEVER put a word the sentence depends on ONLY inside the citation quote. State the fact in your own words FIRST, then attach the citation. WRONG: "Marina uses [1: \\"CartoNova\\"] for map tiles" — this renders as "Marina uses [1] for map tiles" and the provider name disappears, breaking the sentence. RIGHT: "Marina uses CartoNova for map tiles [1: \\"CartoNova\\"]" — the name is in the prose; the quote merely supports it. Read your sentence back with every [N: "..."] deleted: it must still be a complete, grammatical statement of the fact.

3. LENGTH IS 1 TO 3 SENTENCES. Be terse and information-dense. Skip preamble ("Based on the sources..."), skip hedging ("It seems that..."), skip meta-commentary ("I'll summarize..."). Go straight to the answer.

4. WRITE FOR A LIVE LISTENER. The answer renders on a heads-up display while the meeting continues; the reader is half-listening to a conversation. Lead with the answer, not the context.

5. NEVER PROMPT THE USER. Do not ask follow-up questions, do not suggest the user clarify, do not address the user directly. Produce the synthesis and stop.

6. PREFER SPECIFIC NOUNS OVER PRONOUNS. The synthesis often gets read out of context; "issue #6" is clearer than "it" or "this issue". When a source has a clear identifier (issue number, file path, plan-unit U-ID, requirement ID), use the identifier in your answer instead of describing it in prose.

7. PRESERVE LOAD-BEARING TECHNICAL DETAIL. If a source mentions a specific threshold, version, or status, reproduce it verbatim. Paraphrasing technical specifics is worse than copying them.

8. DO NOT WRAP SOURCE PHRASES IN QUOTES. Synthesize the information into your own short sentences. If the source already used quotation marks (for example quoting a config value), those marks may be preserved, but do not wrap entire source phrases in quotation marks as a way to cite them; that is what the [N] reference is for.

9. WHEN SOURCES DISAGREE, NOTE THE DISAGREEMENT BRIEFLY. If [1] says X and [2] says Y on the same point, prefer "[1] says X; [2] says Y" over picking a winner. If the disagreement is so fundamental that synthesizing would mislead, decline with STATUS: no_relevant_context.

10. NEVER PARROT THE UTTERANCE BACK. Lead with new information from the sources, not a restatement of what the speaker just said.

11. NO EM-DASHES OR EN-DASHES. Never use the "—" (em-dash) or "–" (en-dash) characters anywhere in your output. Use a period, a comma, parentheses, or "to"/"and" instead. Ordinary hyphens in compound words (for example "low-latency", "object-storage") are fine.

The examples below are about a fictional boat-rental marketplace called Marina. They exist ONLY to show the format: a recent-transcript window (when present), the sources, and a correctly-cited answer that leads with a STATUS line. Never reuse Marina's facts in a real answer.`;

interface FewShot {
  /** Prior transcript lines (oldest first), when the example demonstrates
   *  window/fragment handling. Omitted for single-utterance examples. */
  readonly recentContext?: readonly string[];
  readonly utterance: string;
  readonly sources: readonly { readonly rank: number; readonly title: string; readonly text: string }[];
  /** The synthesis body for a STATUS: answer example (no status line; the
   *  formatter prepends it). Omit for a refusal example. */
  readonly answer?: string;
  /** Present for a STATUS: no_relevant_context example; `reason` is the
   *  short debug-only explanation rendered after the status line. */
  readonly refusal?: { readonly reason: string };
}

const FEW_SHOTS: readonly FewShot[] = [
  {
    utterance: 'whats the status of instant book',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#issue:31 — U14: Instant Book (skip owner approval for verified renters)',
        text:
          '**Plan unit:** U14 (Phase 2, trust + conversion)\n\n' +
          'Let renters with a completed verification book a listing without waiting for the owner to approve. The owner opts in per listing; unverified renters still go through the request-to-book flow.\n\n' +
          'Status: planned, blocked on the renter-verification flow (U11) landing first, since Instant Book keys off the verified flag U11 sets. No code yet.\n\n' +
          'Scope: booking path only. Owner payout timing is unchanged and tracked separately under U17.',
      },
    ],
    answer: 'Instant Book is planned as plan unit U14 in Phase 2 [1: "U14 (Phase 2, trust + conversion)"] and blocked on the renter-verification flow (U11) landing first [1: "blocked on the renter-verification flow (U11) landing first"]; no implementation has started [1: "No code yet."].',
  },
  {
    utterance: 'do we hold the boat while the renter is paying',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:docs/booking-holds.md',
        text:
          '## Soft holds\n\nWhen a renter starts checkout, the system places a soft hold on the listing for that date range so a second renter cannot double-book mid-payment. The hold lasts 10 minutes and is keyed by a hold token issued at checkout-start. If payment completes the hold converts to a confirmed booking; if it expires the dates are released automatically.',
      },
      {
        rank: 2,
        title: 'gh:acme/marina#file:apps/api/src/checkout/hold.ts',
        text:
          '// placeHold(listingId, range) writes a row to listing_holds with\n// expires_at = now + 10m and returns a holdToken. The booking endpoint\n// rejects a confirm whose holdToken is missing or expired.\nexport async function placeHold(listingId, range) { /* ... */ }',
      },
    ],
    answer: 'Yes, starting checkout places a soft hold on the listing for the date range so it cannot be double-booked mid-payment [1: "places a soft hold on the listing"], lasting 10 minutes and keyed by a hold token issued at checkout-start [1: "The hold lasts 10 minutes and is keyed by a hold token issued at checkout-start"]; the booking endpoint rejects a confirm whose hold token is missing or expired [2: "rejects a confirm whose holdToken is missing or expired"].',
  },
  {
    utterance: 'why did we go with a flat service fee instead of a percentage',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:.env.example',
        text:
          '# Service fee charged to the renter on top of the nightly rate.\n# Modes: "flat" (a fixed amount) or "percent" (a share of the subtotal).\nSERVICE_FEE_MODE=flat\nSERVICE_FEE_FLAT_CENTS=1500\n# SERVICE_FEE_PERCENT_BPS=1200',
      },
      {
        rank: 2,
        title: 'gh:acme/marina#file:docs/pricing.md',
        text:
          'Both fee modes write the same ledger entries, so switching modes does not change the accounting schema. The flat mode was chosen for v1 because a predictable, listing-independent fee is easier for owners to reason about and explain to renters; percentage pricing is left as a config-flip for later experiments.',
      },
    ],
    answer: 'The sources don\'t lay out a head-to-head comparison, but they show the default is the flat mode [1: "SERVICE_FEE_MODE=flat"] and that both modes write the same ledger entries so switching is just a config flip [2: "Both fee modes write the same ledger entries"]; flat was chosen for v1 because a predictable, listing-independent fee is easier for owners to reason about [2: "a predictable, listing-independent fee is easier for owners to reason about"].',
  },
  {
    utterance: 'how does the deposit refund work',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:docs/deposits.md',
        text:
          'The security deposit is authorized (not captured) at booking confirmation. After the boat is returned, the deposit authorization is released automatically within 24 hours unless the owner files a damage claim. Filing a claim freezes the deposit for manual review; the renter is notified and can dispute. If no claim is filed within the 24-hour window the authorization simply expires and nothing is charged.',
      },
    ],
    answer: 'The security deposit is authorized rather than captured at booking confirmation [1: "authorized (not captured) at booking confirmation"] and released automatically within 24 hours of return unless the owner files a damage claim [1: "released automatically within 24 hours unless the owner files a damage claim"], which freezes it for manual review [1: "Filing a claim freezes the deposit for manual review"].',
  },
  {
    // Window/fragment example: the most recent line ("when does it kick in") is
    // a bare fragment; the prior line ("ok and the cancellation fee") completes
    // it into "when does the cancellation fee kick in". The model must assemble
    // the question from the window and answer, not refuse the fragment.
    recentContext: ['ok and the cancellation fee'],
    utterance: 'when does it kick in',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:docs/cancellation-policy.md',
        text:
          '## Standard cancellation policy\n\nFree cancellation if the renter cancels more than 7 days before the start date. Cancel within 7 days and the renter is charged 50% of the booking subtotal. Cancel within 24 hours of the start and the renter is charged 100%. Owner-initiated cancellations are always free to the renter and incur an owner penalty tracked separately.',
      },
    ],
    answer: 'The cancellation fee kicks in inside the 7-day window: cancelling within 7 days charges 50% of the subtotal [1: "Cancel within 7 days and the renter is charged 50% of the booking subtotal"] and within 24 hours of the start charges 100% [1: "Cancel within 24 hours of the start and the renter is charged 100%"]; cancellations more than 7 days out are free [1: "Free cancellation if the renter cancels more than 7 days before the start date"].',
  },
  {
    // "What X should we use" example, the same shape as a real "what models do
    // we use" question. The answer comes entirely from the sources, with
    // invented vendor names so there is nothing real to leak.
    utterance: 'what map provider are we using',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:docs/decisions/maps.md',
        text:
          '### D4. Map provider: CartoNova\n\nMarina uses CartoNova for both map tiles and geocoding. Reasoning: usage-based pricing fits our volume, and CartoNova has strong coverage in the coastal launch regions.\n\n*Considered and rejected:* GeoPulse (cheaper but weak coverage in our launch regions), self-hosted tiles (operational burden we are not ready for in v1).',
      },
      {
        rank: 2,
        title: 'gh:acme/marina#issue:44 — Pluggable map provider behind a MapProvider interface',
        text:
          'Future work: put tiles + geocoding behind a MapProvider interface so the provider can be swapped without touching call sites. Not in scope for v1; CartoNova is wired directly today.',
      },
    ],
    answer: 'Marina uses CartoNova for map tiles and geocoding [1: "Marina uses CartoNova for both map tiles and geocoding"], chosen over GeoPulse, which was rejected for weak coverage in the launch regions [1: "GeoPulse (cheaper but weak coverage in our launch regions)"]; a pluggable MapProvider interface is future work and not in scope for v1 [2: "Not in scope for v1"].',
  },
  {
    utterance: 'are we tracking how often renters abandon checkout',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#issue:52 — U21: Funnel telemetry (checkout-start, payment-attempt, abandonment-rate)',
        text:
          'Wire funnel telemetry events: checkout-start, payment-attempt, payment-success, and a derived abandonment-rate per listing and per cohort. These feed conversion dashboards and the pricing experiments.\n\nStatus: planned, Phase 2. Blocked on the events pipeline (U19) since abandonment-rate is derived downstream and there is no event stream to derive it from yet.',
      },
    ],
    answer: 'Checkout abandonment is a planned telemetry event in plan unit U21 (Phase 2) [1: "U21"][1: "Phase 2"], computed as a derived abandonment-rate per listing [1: "a derived abandonment-rate per listing"], but blocked on the events pipeline (U19) and not yet wired [1: "Blocked on the events pipeline (U19)"].',
  },
  {
    utterance: 'how do we handle a failed payment capture',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:apps/api/src/payments/capture.ts',
        text:
          '// Payment capture retries up to 3 times with backoff: 2s, then 8s, then\n// 30s. After the third failure the booking is auto-released and the hold\n// token is voided so the dates free up. A hard decline (processor 4xx such\n// as card_declined) skips retry entirely and releases immediately, since\n// retrying the same card will not help.',
      },
    ],
    answer: 'Payment capture retries up to 3 times with backoff of 2s, then 8s, then 30s [1: "retries up to 3 times with backoff: 2s, then 8s, then\\n// 30s"], and after the third failure the booking is auto-released and the hold token is voided [1: "the booking is auto-released and the hold\\n// token is voided"]; a hard decline skips retry and releases immediately [1: "A hard decline (processor 4xx such\\n// as card_declined) skips retry entirely and releases immediately"].',
  },
  {
    // Clean refusal: the window is about a coffee break; the sources are about
    // search ranking and image uploads. Zero topical overlap, so decline. The
    // reason line is debug-only; production shows the user nothing.
    utterance: 'should we grab coffee before the standup',
    sources: [
      {
        rank: 1,
        title: 'gh:acme/marina#file:apps/api/src/search/ranking.ts',
        text:
          'Listing search ranking blends recency of the listing, the owner rating, and distance from the search center. The weights are tuned per launch region.',
      },
      {
        rank: 2,
        title: 'gh:acme/marina#file:apps/api/src/media/upload.ts',
        text:
          'Listing images are resized to a max edge of 1600px, stripped of EXIF, and stored in object storage with a content-addressed key.',
      },
    ],
    refusal: {
      reason: 'The window is about taking a coffee break; the sources cover listing search ranking and image upload handling, which are unrelated.',
    },
  },
];

/** Render the question portion shared by few-shots and the live user message.
 *  With recent context, the window is framed as one ongoing thought so the
 *  model assembles the question from all the lines, not the latest alone. */
function renderQuestionBlock(utterance: string, recentContext?: readonly string[]): string {
  if (recentContext !== undefined && recentContext.length > 0) {
    const priors = recentContext.map((u, i) => `  ${String(i + 1)}. "${u}"`).join('\n');
    return (
      `Recent transcript (oldest first). Read these lines together as one ongoing thought: ` +
      `the most recent line is the speaker's current focus, but the earlier lines often complete ` +
      `it into the actual question. Answer the question the window as a whole is asking; do not ` +
      `judge the most recent line in isolation.\n` +
      `${priors}\n\n` +
      `Most recent line: ${utterance}`
    );
  }
  return `Utterance: ${utterance}`;
}

function formatFewShotForPrompt(shot: FewShot, index: number): string {
  const sourceLines = shot.sources
    .map((s) => `[${String(s.rank)}] ${s.title}\n${s.text}`)
    .join('\n\n');
  const answerBlock =
    shot.refusal !== undefined
      ? `${STATUS_NO_CONTEXT}\n${shot.refusal.reason}`
      : `${STATUS_ANSWER}\n${shot.answer ?? ''}`;
  return [
    `<example ${String(index + 1)}>`,
    renderQuestionBlock(shot.utterance, shot.recentContext),
    '',
    'Sources:',
    sourceLines,
    '',
    `Answer:\n${answerBlock}`,
    `</example ${String(index + 1)}>`,
  ].join('\n');
}

function buildPrefixText(): string {
  const examples = FEW_SHOTS.map((shot, i) => formatFewShotForPrompt(shot, i)).join('\n\n');
  return (
    `${SYSTEM_INSTRUCTIONS}\n\n${examples}\n\n` +
    `Now produce the response for the transcript that follows. Remember: the first line is the ` +
    `STATUS tag (STATUS: answer or STATUS: no_relevant_context). For STATUS: answer, write 1 to 3 ` +
    `sentences with every factual claim cited as [N: "verbatim substring"] (preferred) or plain ` +
    `[N] (when paraphrasing). Answer ONLY from the sources below, never from the Marina examples ` +
    `or general knowledge. Assemble the question from the whole recent window before deciding; ` +
    `choose STATUS: no_relevant_context only when the sources have zero topical relevance or the ` +
    `whole window is pure filler. When in doubt, answer. Do not use em-dashes.`
  );
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

/** Render one source. When parent-document expansion (U8) supplied a `focus`
 *  excerpt distinct from the (wider) `text`, present them separately so the
 *  model judges relevance from the matched excerpt but can draw on the full
 *  context for detail. Otherwise fall back to the plain single-block form. */
function renderSource(s: SynthesisSource): string {
  const head = `[${String(s.rank)}] ${s.title}`;
  if (s.focus !== undefined && s.focus.length > 0 && s.focus !== s.text) {
    return (
      `${head}\n` +
      `Matched excerpt (judge relevance to the question from THIS):\n${s.focus}\n\n` +
      `Surrounding context (draw on this for a fuller answer; it may range wider than the question):\n${s.text}`
    );
  }
  return `${head}\n${s.text}`;
}

export function buildUserMessage(
  utterance: string,
  sources: readonly SynthesisSource[],
  recentContext?: readonly string[],
): string {
  const numbered = sources.map(renderSource).join('\n\n');
  return `${renderQuestionBlock(utterance, recentContext)}\n\nSources:\n${numbered}`;
}

// One citation occurrence in the synthesis text. Stored per-occurrence
// so the same source cited at three positions yields three entries (each
// with its own quote). The cardId mapping (rank → cardId via the
// caller's sourceCardIds[]) lives in the caller; the parser intentionally
// stays unaware of source identity beyond rank.
export interface ParsedCitation {
  /** 1-based rank into the caller's source list. */
  readonly rank: number;
  /** Character offset where the [N…] token starts in the answer body. */
  readonly position: number;
  /** Verbatim quote the LLM extracted for this citation. Undefined when
   *  Claude misformats (bare `[N]` with no quote payload). */
  readonly quote: string | undefined;
}

export interface ParsedSynthesis {
  /** The answer body with the STATUS line stripped. Empty string on refusal. */
  readonly text: string;
  readonly citations: readonly ParsedCitation[];
  readonly isRefusal: boolean;
  /** Debug-only explanation the model gave for declining (the line after
   *  STATUS: no_relevant_context). Production must not surface this. */
  readonly refusalReason?: string;
}

// Matches both citation formats in a single walk:
//   [N: "quote"]   — captures rank + quoted quote
//   [N]            — bare form (rank only, quote undefined)
const CITATION_REGEX = /\[(\d+)(?::\s*"((?:\\.|[^"])*)")?\]/g;

// Leading status tag: "STATUS: answer" / "STATUS: no_relevant_context",
// tolerant of leading whitespace, missing space after the colon, and an
// optional trailing newline (the body, if any, follows).
const STATUS_PREFIX_REGEX = /^\s*STATUS:\s*(answer|no_relevant_context)\b[ \t]*\n?/i;

/** Unescapes the captured quote payload: `\"` → `"`, `\\` → `\`. */
function unescapeQuote(raw: string): string {
  return raw.replace(/\\(["\\])/g, '$1');
}

interface StatusClassification {
  readonly status: SynthesisStatus;
  /** Answer body (STATUS line removed). Empty for a refusal. */
  readonly body: string;
  /** Refusal explanation (the line after the refusal tag). Empty otherwise. */
  readonly reason: string;
}

/** Classify a COMPLETE synthesis output by its leading STATUS tag, falling
 *  back to the legacy sentinel when the tag is absent. */
function classifyStatus(text: string): StatusClassification {
  const m = STATUS_PREFIX_REGEX.exec(text);
  if (m !== null) {
    const status: SynthesisStatus = /answer/i.test(m[1]!) ? 'answer' : 'no_relevant_context';
    const rest = text.slice(m[0].length);
    return status === 'answer'
      ? { status, body: rest, reason: '' }
      : { status, body: '', reason: rest.trim() };
  }
  // Legacy fallback: no STATUS tag. Treat a leading sentinel as a refusal
  // (robust to trailing prose, which is exactly the failure the STATUS tag
  // was added to fix); everything else is an answer.
  if (text.trim().startsWith(REFUSAL_SENTINEL)) {
    return {
      status: 'no_relevant_context',
      body: '',
      reason: text.trim().slice(REFUSAL_SENTINEL.length).trim(),
    };
  }
  return { status: 'answer', body: text, reason: '' };
}

export function parseSynthesisOutput(text: string, sourceCount: number): ParsedSynthesis {
  const { status, body, reason } = classifyStatus(text);
  if (status === 'no_relevant_context') {
    return {
      text: '',
      citations: [],
      isRefusal: true,
      ...(reason.length > 0 ? { refusalReason: reason } : {}),
    };
  }
  const citations: ParsedCitation[] = [];
  for (const match of body.matchAll(CITATION_REGEX)) {
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1 || n > sourceCount) continue;
    const rawQuote = match[2];
    citations.push({
      rank: n,
      position: match.index,
      quote: rawQuote === undefined ? undefined : unescapeQuote(rawQuote),
    });
  }
  return { text: body, citations, isRefusal: false };
}

export interface StatusGate {
  /** True once the status decision is resolved. While false, the caller must
   *  hold streaming output (the STATUS line is still arriving). */
  readonly complete: boolean;
  /** Resolved status, or null while still forming. */
  readonly status: SynthesisStatus | null;
  /** Answer body so far (STATUS line removed). Empty until complete, and
   *  always empty for a refusal. */
  readonly body: string;
  /** Refusal explanation so far (refusal only). */
  readonly reason: string;
}

// Candidate full status lines, lowercased, including the no-space variant so
// the "still forming" check tolerates a missing space after the colon.
const STATUS_CANDIDATES = [
  'status: answer',
  'status: no_relevant_context',
  'status:answer',
  'status:no_relevant_context',
];

/**
 * Streaming-safe variant of classifyStatus. Given the accumulated output so
 * far, decide whether the leading STATUS line has resolved yet:
 *
 *  - If a full `STATUS: <tag>\n` prefix is present, return complete with the
 *    body (answer) or reason (refusal) parsed out.
 *  - If what we have so far is still a possible prefix of a STATUS line (no
 *    newline yet), return `complete: false` so the caller holds output and
 *    avoids flashing the control token (or a refusal) on screen.
 *  - Otherwise the output diverged from the protocol (legacy/non-compliant):
 *    classify by the sentinel fallback and stream immediately.
 */
export function stripStatusPrefix(accumulated: string): StatusGate {
  const m = STATUS_PREFIX_REGEX.exec(accumulated);
  if (m?.[0].includes('\n') === true) {
    const status: SynthesisStatus = /answer/i.test(m[1]!) ? 'answer' : 'no_relevant_context';
    const rest = accumulated.slice(m[0].length);
    return status === 'answer'
      ? { complete: true, status, body: rest, reason: '' }
      : { complete: true, status, body: '', reason: rest.trim() };
  }
  // No complete "STATUS: <tag>\n" yet. Are we still forming one?
  if (!accumulated.includes('\n')) {
    const lower = accumulated.replace(/^\s*/, '').toLowerCase();
    const stillForming = STATUS_CANDIDATES.some(
      (c) => c.startsWith(lower) || (lower.startsWith('status:') && lower.length <= c.length),
    );
    if (stillForming) {
      return { complete: false, status: null, body: '', reason: '' };
    }
  }
  // Diverged from the protocol: classify legacy-style and stream now.
  const c = classifyStatus(accumulated);
  return { complete: true, status: c.status, body: c.body, reason: c.reason };
}

/** Collapse whitespace + lowercase so a quote match tolerates incidental
 *  formatting drift (newlines, double spaces) without accepting a genuinely
 *  absent string. */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface CitationVerification {
  /** Citations that survived verification (quoted ones whose quote is present
   *  in the cited source, plus all bare ones, which can't be quote-checked). */
  readonly verified: readonly ParsedCitation[];
  /** Quoted citations dropped because the quote was not found in the source. */
  readonly droppedQuoted: number;
}

/**
 * Drop fabricated quoted citations: a `[N: "quote"]` whose quote does not
 * actually appear in source N's text is not grounded, so we strip it (the
 * inline chip and the source's "cited" status disappear with it). Bare `[N]`
 * citations can't be quote-checked, so they pass through (their rank is
 * already bounded by the parser); the few-shot neutralization is what guards
 * against bare-citation fabrication.
 *
 * This is the safety net behind grounding: even if the model invents a fact,
 * a quote it attaches that isn't in the source gets caught here.
 */
export function verifyCitations(
  citations: readonly ParsedCitation[],
  sources: readonly { readonly text: string }[],
): CitationVerification {
  const normalizedSources = sources.map((s) => normalizeForMatch(s.text));
  const verified: ParsedCitation[] = [];
  let droppedQuoted = 0;
  for (const c of citations) {
    if (c.quote === undefined) {
      verified.push(c);
      continue;
    }
    const src = normalizedSources[c.rank - 1];
    if (src?.includes(normalizeForMatch(c.quote)) === true) {
      verified.push(c);
    } else {
      droppedQuoted += 1;
    }
  }
  return { verified, droppedQuoted };
}

/** Helper for callers that need the legacy dedup'd-sorted ranks shape
 *  (number[]). */
export function citationsToRanks(citations: readonly ParsedCitation[]): readonly number[] {
  const seen = new Set<number>();
  for (const c of citations) seen.add(c.rank);
  return [...seen].sort((a, b) => a - b);
}
