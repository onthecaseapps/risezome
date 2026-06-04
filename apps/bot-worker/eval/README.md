# Corpus eval

`golden-questions.jsonl` is the labeled set the corpus/RAG path is replayed against
(`eval/replay.ts`, the `/debug/eval` dev page, and `test/eval/replay.test.ts`).

## Three precision buckets

Each line carries an optional `bucket` (absent ⇒ `relevant`). The bucket drives the
precision / over-refusal scoring:

| `bucket` | What it is | Correct outcome | Labeling |
|----------|------------|-----------------|----------|
| `relevant` (default) | A genuine question about **this repo's** code/docs | **Surface** a grounded answer | `expect_answer_contains` (and/or `must_surface`) |
| `offtopic` | Ordinary chit-chat / small talk | **Suppress** (no card) | `expect_refusal: true` |
| `adjacent` | Topically near the corpus but **not about our stuff** (the hard negatives that leak today) | **Suppress** (no card) | `expect_refusal: true` |

`adjacent` items are deliberately hard: generic versions of corpus topics
("what's the best vector database", "how does RAG work conceptually") and
term-collisions where a corpus word appears in unrelated chatter ("reconcile my
expense report", "the retention party for Sarah", "a parking citation"). These
are exactly the utterances that retrieve something topically-adjacent and leak a
card today.

## Metrics

- **Precision** — of the items that surfaced, the fraction that were `relevant`.
- **Over-refusal** — of `relevant` items, the fraction wrongly suppressed (the guardrail).
- **Latency** — p50/p95 wall-clock per item across the full real-time path.

The set is linted by `validateGoldenSet` (a suppress-bucket line must set
`expect_refusal: true`; a `relevant` line must not, and must declare an expected
answer/surface) — `test/eval/replay.test.ts` fails CI on a mislabeled line, so
the set stays trustworthy as it grows (the eval-regression practice).

## Running

```sh
# from apps/bot-worker (needs SUPABASE_URL, SUPABASE_SECRET_KEY, VOYAGE_API_KEY,
# ANTHROPIC_API_KEY and a corpus org id):
pnpm tsx --env-file=.env eval/replay.ts <orgId> [--metrics]
```

Adding a question: append one JSONL line with the right `bucket` and labels, then
run the test to confirm it lints. Keep `relevant` items answerable from indexed
content; keep `offtopic`/`adjacent` genuinely unanswerable from our corpus.
