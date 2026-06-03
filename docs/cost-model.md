# Cost model & optimization review

Last updated: 2026-06-02

What does one hour of meeting cost to run, and where is the money going? This
models the live pipeline from the code (models, `max_tokens`, caching,
cadences, transcription/bot config) and ranks the optimization levers.

## TL;DR

- **A 1-hour meeting costs ~$2.00 regardless of how many questions are asked.**
- The cost is **~73% fixed meeting infrastructure** (Recall.ai bot + Deepgram
  transcription), **~25% periodic/always-on AI** (rolling summarizer, reranker,
  router/relevance classifiers, embeddings), and **~2% the actual answers**
  (synthesis).
- **Each answered question costs ~$0.004** (Haiku, 150 output tokens, cached
  prompt). Questions barely move the per-hour number — there is **no cost
  reason to limit how many questions a meeting asks.**
- The biggest levers are all on the *fixed* side: Recall pricing (commercial),
  Deepgram model/bundling, the rolling-summary cadence, and the reranker pool.

## Pricing assumptions (VERIFY — these drive everything)

> These are estimates as of the date above. Update this table and the model
> recomputes. Recall + Haiku 4.5 pricing especially should be confirmed.

| Service | Unit | Assumed price |
|---|---|---|
| Recall.ai bot | per bot-hour | **$0.99** (PAYG; ~$0.50 at volume) |
| Deepgram `nova-3` streaming | per audio-minute | **$0.0077** → $0.46/hr |
| Claude Haiku 4.5 — input | per 1M tokens | **$1.00** |
| Claude Haiku 4.5 — output | per 1M tokens | **$5.00** |
| Haiku 4.5 — cache write | per 1M tokens | $1.25 (1.25×) |
| Haiku 4.5 — cache read | per 1M tokens | $0.10 (0.1×) |
| Voyage `voyage-3-large` (embed) | per 1M tokens | **$0.18** |
| Voyage `rerank-2.5` | per 1M tokens | **$0.05** |

## The call inventory (from code)

Everything uses **`claude-haiku-4-5`** (no Sonnet/Opus anywhere) with short
outputs. Per-call cost and how often each fires in a 1-hour meeting:

| Call | max_tok | Cached prefix | Per-call ≈ | Fires / hr (1h mtg) |
|---|---|---|---|---|
| **Synthesis** | 150 | ~4.2K (read) | **$0.004** | once per *answered* question |
| **Rolling summarizer** | 600 | ~6.4K (may no-op*) | **$0.010** | ~25 (every ~2 min) |
| **Router classifier** | 200 | system cached; **tool defs NOT** | **$0.004** | ~20 (tool-shaped utterances) |
| **Relevance classifier** | 200 | ~4K (read) | **$0.0015** | ~30 (ambiguous utterances) |
| **CRAG expander** | 200 | none | $0.0006 | rare (on a retrieval miss) |
| **Recap** | 700 | full transcript (no reuse) | **$0.016** | 1 per meeting (at end) |
| **Query embed** (Voyage) | — | — | ~$0.00004 | ≤360 ticks, mostly cache hits → ~$0.01/hr total |
| **Reranker** (Voyage, if on) | — | — | ~$0.0013 | ~100 ticks-with-hits → ~$0.13/hr |

`*` The rolling-summary system prompt (~6.4 KB ≈ ~1.8K tokens) is likely **under
Haiku's 4096-token cache floor**, so its `cache_control` silently no-ops and we
pay full input every call. Synthesis/router/relevance prefixes are deliberately
sized over the floor and do cache.

**Index-time** costs (contextualizer + doc-summarizer Haiku calls + chunk
embeddings) are a **one-time corpus build / on-change** cost, not per-meeting —
excluded from the per-hour model. They matter for total bill at reindex time
but not for "cost per meeting hour."

## The 1-hour cost model

```
cost(1h, Q questions) = FIXED_PER_HOUR + Q × $0.004 + $0.016 (recap)
```

**FIXED_PER_HOUR** (paid even in a silent meeting):

| Component | $/hr | Notes |
|---|---|---|
| Recall.ai bot | 0.99 | per-minute, whole meeting |
| Deepgram nova-3 streaming | 0.46 | per audio-minute, whole meeting |
| Rolling summarizer (**demand-driven**) | ~0.05–0.10 | **now refreshes only when answering + stale (≤1 / 5 min); $0 in a question-less meeting** — see opt. #3 |
| Reranker (if `RISEZOME_RERANK_ENABLED`) | 0.13 | per tick-with-hits |
| Router + relevance classifiers | 0.13 | gated subsets of utterances |
| Query embeddings (cached) | 0.01 | negligible |
| **Fixed subtotal** | **~$1.80/hr** | (was ~$1.97 before the summarizer change) |

**Scenarios** (1-hour meeting):

| Questions asked | Synthesis cost | **Total** |
|---|---|---|
| 5 | $0.02 | **~$1.99** |
| 10 | $0.04 | **~$2.01** |
| 20 | $0.08 | **~$2.05** |
| 50 (chatty) | $0.20 | **~$2.17** |

The slope is ~$0.004/question. Doubling questions changes the bill by ~1%.

## Where the money goes (Q=10, ~$2.01)

| Bucket | $/hr | Share |
|---|---|---|
| Recall.ai bot | 0.99 | **49%** |
| Deepgram transcription | 0.46 | **23%** |
| Rolling summarizer | 0.25 | 12% |
| Reranker (if on) | 0.13 | 7% |
| Router + relevance | 0.13 | 7% |
| Synthesis (the answers) | 0.04 | **2%** |
| Recap + embeddings | 0.03 | 1% |

Infrastructure (Recall + Deepgram) is ~72%. The LLM that produces the actual
value (synthesis) is ~2%.

## Optimization levers (ranked by impact)

### 1. Recall.ai bot — ~49% of cost (commercial, biggest lever)
Mostly a pricing negotiation, not code. PAYG ~$0.99/hr drops toward ~$0.50 at
committed volume — that alone is ~25% of the whole bill. Worth a committed-use
or enterprise tier as volume grows. Product-side: the idle-leave timeouts
(`waiting_room 1200s`, `noone_joined 600s`, `everyone_left 30s`) already bound
wasted bot-minutes; keep them tight.

### 2. Deepgram transcription — ~23% (model + bundling)
- **nova-3 → nova-2 streaming** if quality holds: ~$0.0077 → ~$0.0059/min, a
  ~23% cut on this line (~$0.46 → $0.35/hr). Worth an A/B on transcript quality.
- **Deepgram volume/commit pricing** as minutes scale.
- Evaluate Recall's **bundled transcription** vs our-key Deepgram — but the
  current ZDR posture (`retention: null`, our Deepgram key, fail-closed
  assertion in `recall-bot-launcher.ts`) is deliberate; only switch if a bundled
  option preserves zero-retention.

### 3. Rolling summarizer — ✅ IMPLEMENTED (demand-driven)
**Before:** fired every ~2 min with a ~5K-token transcript window *even in a
quiet meeting* — a fully-fixed cost regardless of whether anyone asked anything.

**Now:** the summary only serves answering, so it is **lazy / demand-driven**
(`apps/bot-worker/src/summarizer-runtime.ts`). The cadence timer is gone;
`recordUtterance()` just accumulates the transcript, and `refreshIfStale()` is
called from the synthesis path (`retrieval.ts` → `index.ts`) when a question is
actually being answered. It re-runs the summary only if the current one is older
than `DEFAULT_REFRESH_STALENESS_MS` (5 min), asynchronously (never blocks the
answer; benefits the next question).

Result: **$0 in a question-less meeting**, and at most ~1 refresh per 5-min
window during active Q&A (≈$0.05–0.10/hr instead of ~$0.25). Net ~−$0.15–0.20/hr,
and it scales the cost to actual usage. Remaining (optional): shrink
`DEFAULT_TRANSCRIPT_CHAR_CAP` 20K → 12K if summaries stay good on less context.

### 4. Reranker — ~7% (if enabled in prod)
`RISEZOME_RERANK_ENABLED` ships off but is set in this deployment. It sends
**25 chunk docs per tick-with-hits** to `rerank-2.5`.
- **`RERANK_POOL` 25 → 10**: ~60% fewer rerank tokens (~$0.13 → $0.05/hr) — the
  top-3 rarely come from rank 11–25 after RRF.
- **Gate it**: skip rerank when the top fused score already dominates (only
  rerank when the top candidates are close). 
- Re-confirm in eval that rerank earns its keep vs RRF alone.

### 5. Router tool-defs caching — ❌ not needed (already cached)
The tools array carries no `cache_control` marker, which looks like an uncached
~2.5K tokens/call — but it isn't. Anthropic builds the cache prefix in the order
**`tools → system → messages`**, and `buildClassifierSystem()` already puts a
`cache_control: ephemeral` breakpoint on the system block (`router/prompt.ts:111`).
A breakpoint on the system block caches *everything before it*, including the
tools. So the 13 tool defs are already in the cached prefix (read at 0.1× after
the first call within the 5-min window). No change to make. Same holds for the
relevance classifier's forced single tool. (This corrects an earlier draft that
counted the router tools as uncached — the router per-call estimate above is
therefore slightly conservative.)

### 6. Leave synthesis alone
Already well-optimized: cached prefix, 150 `max_tokens`, Haiku, fires only on
grounded+relevant utterances. At ~$0.004/question there's nothing to win.

### Net achievable (code-side, no Recall renegotiation)
**Done:** demand-driven rolling summary (−$0.15–0.20/hr, and $0 in quiet
meetings). **Remaining:** nova-2 (−$0.11) + rerank pool/gate (−$0.08) ≈ −$0.19/hr.
Combined ≈ **−$0.35–0.40/hr (~18–20%)**, landing ~$1.60/hr. Renegotiating Recall
to ~$0.50 adds another ~$0.49 → **~$1.10/hr (~45% total).** (The router tool-def
cache from an earlier draft is dropped — it was already cached; see opt. #5.)

## Caveats

- Pricing is estimated (see the assumptions table) — Recall and Haiku 4.5 most
  affect the result; confirm before acting.
- Frequencies (25 summaries, 20 router, 30 relevance, 100 rerank-hits per hour)
  are reasonable-meeting guesses; a very chatty or very quiet meeting shifts the
  *fixed* AI components, not the per-question slope.
- Index-time corpus costs (contextualization + per-doc summaries + embeddings)
  are excluded — they're a separate, one-time/on-change line.
