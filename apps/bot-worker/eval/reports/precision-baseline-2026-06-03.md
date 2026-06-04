# RAG precision baseline — 2026-06-03

Pre-tuning baseline for the precision effort (plan `docs/plans/2026-06-03-004-feat-rag-synthesis-precision-plan.md`).
Full real-time path (relevance gate → retrieval → synthesis), no `--metrics`, hosted corpus
(org `81b99444…`, 536 docs). The comparison point every tuning unit (U3–U9) is kept-or-reverted against.

## Headline

| Metric | Baseline |
|--------|----------|
| Precision (relevant / surfaced) | **84%** |
| Over-refusal (relevant suppressed) | **2%** |
| Latency p50 / p95 | **3.37s / 4.79s** |
| Overall pass | 120/134 (90%), mean recall 0.50 |

## Per bucket

| Bucket | n | surfaced | suppressed | pass |
|--------|---|----------|------------|------|
| relevant | 64 | 63 | 1 | 62 |
| offtopic | 36 | 0 | 36 | 36 |
| adjacent | 34 | **12** | 22 | 22 |

## Reading

- **Off-topic chit-chat is already fully suppressed** (0/36 leak) — the heuristic + fail-open judge
  handle pure small talk. No work needed there.
- **The entire precision loss is the adjacent bucket: 12/34 (35%) hard-negatives leak a card.**
  Precision = 63 / (63 + 12) = 84%. Closing those 12 → precision ≈ 95%+. This is what U3
  (about-our-work judge gate), U5 (absolute grade), and U8 (strip-refine) target.
- **Over-refusal already low (2%)** → headroom to tighten; guardrail keeps it ≤ ~4–5%.
- **Latency p50 already at/over the ~3s budget.** The eval runs synthesis to completion
  sequentially (production streams), but units that add Haiku calls (U5, U8) must watch p95 —
  gate the grader behind `isLowConfidenceHits` as planned.

## Target

Drive the 12 adjacent leaks toward 0 (precision → ~95%+) while keeping relevant over-refusal
≤ ~4–5% and p95 latency within budget.
