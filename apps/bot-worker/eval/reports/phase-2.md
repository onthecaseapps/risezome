# Phase 2 — label correction + parent-document retrieval (U8)

Two changes, measured against the same post-Phase-1 contextualized corpus
(1252/1253 chunks contextualized, 154 summaries). All runs:
`eval/replay.ts <org> --metrics`, 10 golden questions, rerank + CRAG enabled.

## 1. Golden-label correction

The replay scorer gated pass on `recall === 1` over `must_surface` — brittle
doc-id/title keyword guesses. A correct, cited answer false-failed whenever
retrieval surfaced a legitimately-different doc than the guess. Pass is now
driven by the end-to-end answer (`expect_answer_contains` / `expect_refusal`);
`must_surface` recall is still reported as an informational retrieval signal
(`meanRecall`) but no longer gates. RAGAS context-precision/recall measures
retrieval quality.

Re-scoring the identical corpus: **4/10 → 9/10 pass.** The 5 former "fails"
were correct, cited answers (ai-models, bot-join, deepgram, reindex,
citations). The lone real fail is "what database → SQLite", a genuinely-wrong
answer from a stale `docs/plans/archive/` doc (the corpus-hygiene gap).

## 2. Parent-document (small-to-big) retrieval (U8)

Embed precise child chunks; expand a winning child to parent context for
synthesis (whole doc under a char cap, else a neighbour window). Citations
still point at the child. Env-gated `RISEZOME_PARENT_DOC_ENABLED` (default
off); `RISEZOME_PARENT_DOC_CAP_CHARS` (6000), `RISEZOME_PARENT_DOC_WINDOW` (1).

| Run | pass | deepgram | faithfulness | answer-rel | ctx-precision | ctx-recall |
|---|---|---|---|---|---|---|
| A — U8 off (baseline) | 9/10 | answers | 1.00 | 0.80 | 0.64 | 1.00 |
| B — U8 blanket | 8/10 | **refuses** | 1.00 | 0.90 | 0.67 | 1.00 |
| B2 — U8 blanket (confirm) | 8/10 | **refuses** | 1.00 | 0.92 | 0.48 | 1.00 |
| C — U8 + focus split | 9/10 | answers | 1.00 | 0.95 | 0.40 | 1.00 |

### Finding: blanket expansion regresses precise lookups

With blanket expansion (B), "how do we handle deepgram disconnecting" flipped
from a correct answer to a **refusal** — reproduced in B2. Retrieval was
identical across runs (U8 doesn't change retrieval); the regression came purely
from expansion. The precise reconnect chunk *was* the answer; expanding it to
the whole file (plus noisy archived plans in the pool) buried the answer in
surrounding context, so the synthesizer judged the wider context
non-responsive and declined. Classic small-to-big failure: helps scattered
facts, hurts precise lookups.

### Fix: judge on the tight excerpt, formulate from the full context

Each source now carries a `focus` (the tight child that matched) alongside
`text` (the expanded parent). The synthesis prompt instructs the model to judge
RELEVANCE from the matched excerpt — so wider context can't make a precise
source read as off-topic — then draw on the full context to compose a complete
answer. `focus` is always a substring of `text`, so citation quotes still
verify against `text`.

Run C: the deepgram refusal is **gone** (9/10, matching the U8-off baseline),
answer-relevancy is the **highest of all runs (0.95)**, faithfulness holds at
1.00. Context-precision drops to 0.40, but that is a measurement artifact —
RAGAS scores the wider expanded `text` it was given; retrieval surfaced the
identical chunks, so true retrieval precision is unchanged.

### Verdict

The focus split makes U8 **safe** (no pass regression vs off) and lifts answer
quality (relevancy), at the cost of feeding synthesis wider context. On this
10-question set U8 does not move the pass rate (the one fail is the unrelated
stale-corpus issue), so the benefit is qualitative — fuller, better-anchored
answers. Shipped behind the flag, **default off**. Enable for live feel;
revisit a smaller cap if the wider context proves noisy in practice.

## Follow-ups (unchanged priority order)

1. **Corpus hygiene** — exclude/down-rank `docs/plans/archive/**`. It directly
   causes the only hard fail ("what database → SQLite") and adds noise that
   worsened the blanket-U8 regression.
2. **U7 routing manifest** — would route architecture questions away from
   archived planning docs (the structural version of #1).
