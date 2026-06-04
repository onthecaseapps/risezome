# RAG precision — eval-gated results log

Running A/B log for the precision effort (plan `docs/plans/2026-06-03-004-feat-rag-synthesis-precision-plan.md`).
Hosted corpus, org `81b99444…` (536 docs), full real-time path, no `--metrics`.
Gate: **keep** iff precision ↑ AND relevant over-refusal ↑ ≤ ~2–3 pts AND p95 latency in budget.

| Unit | Flag | Precision | Over-refusal | Adjacent leak | p50 / p95 | Verdict |
|------|------|-----------|--------------|---------------|-----------|---------|
| Baseline | — | 84% | 2% | 12/34 | 3.37s / 4.79s | — |
| U3 v1 (strict prompt only) | `RISEZOME_RELEVANCE_STRICT` | 83% | 2% | 13/34 | 3.33s / 4.88s | **revert** — no effect (questions are `clearly_substantive`, bypass the judge) |
| U3 v2 (strict + route questions to judge) | `RISEZOME_RELEVANCE_STRICT` | 98% | 16% | 1/34 | 1.52s / 5.99s | **revert** — precision win, but over-refusal +14pt breaches guardrail |
| **U3 v3 (our-stack-aware + route)** | `RISEZOME_RELEVANCE_STRICT` | **98%** | **2%** | **1/34** | 3.48s / 6.16s | **KEEP** — precision +14pt, over-refusal flat |

## U3 learnings

- **The heuristic's `clearly_substantive` path bypasses the LLM judge.** Questions ("what is X",
  "how do you Y") never reach the judge, so a stricter judge prompt alone (v1) does nothing. The
  fix is to **route substantive utterances through the judge in strict mode** (`relevanceStrict`).
- **"Mentions a vendor → skip" is wrong.** It over-skips our-own questions about tools we use
  (Voyage/Postgres/Anthropic/GitHub). v2 hit 16% over-refusal that way. The judge must know **our
  stack**, and **specific-implementation questions surface** even without "our"/"we". Skip only on:
  other-platforms-we-don't-use · explicitly-generic ("in general"/"conceptually") · external facts
  (pricing) · word-collisions.
- **Remaining errors are genuinely borderline:** 1 over-refused relevant ("what external services
  does *the project* depend on") and 1 adjacent leak ("we should index the shared drive folders
  better" — a suggestion about our own roadmap).
- **Latency caveat:** routing every substantive question through the judge adds a Haiku call;
  p95 rose +1.4s (also inflated by sequential eval + rate-limit retries). Production mitigation:
  fire the judge **in parallel** with retrieval and discard retrieval on skip.

## Still to ship U3 in production

The eval validated the approach via `relevanceStrict` in the eval harness. To make it real, the
**bot-worker** path (`apps/bot-worker/src/retrieval.ts` `maybeRetrieveAndEmit`) must apply the same
routing (route `clearly_substantive` → judge when strict), and the daemon path follows in U10. The
prompt change (engine) already flows to both.
