// Shared live-answer dedup helpers (Mechanism A + Mechanism B).
//
// Extracted verbatim from `src/retrieval.ts` so BOTH the production path
// (`maybeRetrieveAndEmit`) and the local-debug path (`src/debug/local-debug-ws.ts`)
// can apply the same answered-span voiding (Mechanism A) and same-source-set
// suppression (Mechanism B). The debug page reimplements the pipeline wiring
// (it calls `runPipeline` directly), so before this module it silently lacked
// the dedup the prod path got in 933d2c8; importing these here keeps the two in
// lockstep.
//
// All three helpers are PURE — no runtime mutation. The window-pruning of the
// answered-source-set ledger stays with the caller (it owns the runtime state).

/**
 * Mechanism A — the EFFECTIVE window: `recentFinals` with any utterance text
 * present in `consumedFinals` (already answered) removed, BUT the current
 * utterance (the last element — the new, not-yet-answered question) is ALWAYS
 * kept. This is the view that feeds all question UNDERSTANDING (query build,
 * ambient join, synthesizer recentContext); the raw `recentFinals` rolling
 * window is unaffected. Empty in ⇒ empty out.
 */
export function effectiveWindow(
  recentFinals: readonly string[],
  consumedFinals: readonly string[],
): string[] {
  if (recentFinals.length === 0) return [];
  const consumed = new Set(consumedFinals);
  const lastIdx = recentFinals.length - 1;
  return recentFinals.filter((text, i) => i === lastIdx || !consumed.has(text));
}

/**
 * Mechanism B (read side, PURE) — true when the candidate grounded source set
 * duplicates a recent answered set: non-empty AND every candidate docId is
 * contained in a single answered entry within the recency window (the new answer
 * would add no new source). Order-independent.
 *
 * This is the pure form of the predicate that was inline in `retrieval.ts`; the
 * caller is responsible for pruning `answeredSets` by the window FIRST (or, as
 * here, this checks the window per-entry so a stale entry can't match — callers
 * still prune for unbounded-growth reasons). No mutation of `answeredSets`.
 */
export function isDuplicateAnswerSourceSet(
  candidateDocIds: readonly string[],
  answeredSets: readonly { docIds: string[]; at: number }[],
  now: number,
  windowMs: number,
): boolean {
  if (candidateDocIds.length === 0) return false;
  return answeredSets.some((entry) => {
    if (now - entry.at >= windowMs) return false;
    const answered = new Set(entry.docIds);
    return candidateDocIds.every((id) => answered.has(id));
  });
}

/**
 * Mechanism A (record side, PURE) — append `window` to `consumed`, dedupe
 * (preserving order; iterating newest-last so the cap keeps the freshest
 * entries), drop empties, and cap to the last `cap` entries.
 */
export function addConsumedFinals(
  consumed: readonly string[],
  window: readonly string[],
  cap: number,
): string[] {
  const merged = [...consumed, ...window];
  const seen = new Set<string>();
  const deduped: string[] = [];
  // Iterate newest-last so the cap keeps the freshest entries.
  for (const txt of merged) {
    if (txt.length === 0 || seen.has(txt)) continue;
    seen.add(txt);
    deduped.push(txt);
  }
  return deduped.length > cap ? deduped.slice(-cap) : deduped;
}

// Mechanism A — bound on the answered-transcript-span ledger so a long meeting
// can't grow `consumedFinals` unboundedly. Comfortably larger than the rolling
// window, so every still-in-window answered utterance stays voidable.
export const CONSUMED_FINALS_CAP = 60;

// Near-duplicate / same-source recency window (KTD4). A question whose grounded
// source set duplicates one answered within this window is suppressed. Shared by
// the prod path (`retrieval.ts`) and the local-debug path so both make the same
// suppression decision. Env-overridable via RISEZOME_QUESTION_DUP_WINDOW_MS.
export const QUESTION_DUP_WINDOW_MS =
  Number.parseInt(process.env.RISEZOME_QUESTION_DUP_WINDOW_MS ?? '300000', 10) || 300_000;
