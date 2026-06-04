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
| U3 on **expanded set** (165q) | `RISEZOME_RELEVANCE_STRICT` | **99%** | **1%** | **1/48** | 3.37s / 5.87s | **holds** — +31 hard edge cases, no new failure class |

## U5 decision: not pursued

We extended the set with 31 hard edge cases (ownership-light relevant, generic-but-our-stack
adjacent, product-praise off-topic) specifically to find a failure class U5 (post-retrieval absolute
grading) could fix. It found none — precision rose to **99%**, over-refusal fell to **1%**, and the
only two residuals are the same borderline cases:
- Over-refused "what external services does *the project* depend on" — a **pre-retrieval** judge
  coin-flip; a post-retrieval grader never sees it, so U5 can't help.
- Leaked "we should index the shared drive folders better" — retrieves our **real roadmap**; a
  post-retrieval grader would likely surface it too (it genuinely *is* about our product).

U3 alone meets the precision goal on a stress-tested set. **U5's added latency now outweighs its
benefit; deferred** (revisit only if a real failure class emerges in production telemetry).

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

## Pipeline consolidation faithfulness gate (2026-06-04)

Plan `docs/plans/2026-06-04-001-refactor-unify-retrieval-pipeline-plan.md` (U4): after migrating
prod + dev-sidecar + eval onto one shared `pipeline/core.ts`, the corpus eval (now running the SAME
core as prod) must reproduce the U3 numbers — proof the consolidation didn't change behavior.

| | U3 (pre-consolidation, 165q) | U4 (consolidated core, 165q) |
|---|---|---|
| Precision | 99% | **99%** |
| Over-refusal | 1% | **1%** |
| relevant surfaced | 74/75 | 74/75 |
| offtopic suppressed | 42/42 | 42/42 |
| adjacent suppressed | 47/48 | 47/48 |
| latency p50/p95 | 3.37s/5.87s | 3.51s/5.91s |

Identical precision/over-refusal/per-bucket counts and the same two borderline residuals. **PASS** —
the eval validates prod by construction; U2 (prod) and U3 (dev-sidecar) are verified end-to-end.
