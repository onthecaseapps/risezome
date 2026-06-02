import type { SkillResult } from '@risezome/engine/skills';
import { formatAsSource } from '@risezome/engine/skills';
import type { SynthesisSource } from '@risezome/engine/synthesize';

export type ToolRecoveryStatus = 'clean' | 'repaired' | 'unresolved';

export interface ToolSourceDecision {
  /** Whether the skill result should reach synthesis as the tool source. */
  readonly keep: boolean;
  /** Telemetry status: 'clean' = no recovery signal; else the recovery status. */
  readonly status: ToolRecoveryStatus;
}

/**
 * Router safety-net (plan U4). Given a skill's result, decide whether it
 * should be kept as the synthesis tool source or dropped so synthesis falls
 * back to RAG:
 *  - no recovery signal → keep (clean common path).
 *  - `'repaired'` → keep (a real scope survived; the caveat rides in the source
 *    text and the synthesizer frames it honestly, U5).
 *  - `'unresolved'` → drop (KTD8: the misparse left the query unscoped or
 *    couldn't be salvaged; a confident broad answer would mislead).
 *
 * The router is agnostic to *why* a result is unresolved — unscoped re-run,
 * transient validation failure, or unsalvageable bogus arg all converge here.
 * The caller applies this decision BEFORE invoking synthesis, so a dropped
 * result never emits a premature `synthesisStart` (KTD7 flash-fix invariant).
 */
export function decideToolSource(skillResult: SkillResult): ToolSourceDecision {
  const status = skillResult.recovery?.status;
  if (status === 'unresolved') return { keep: false, status: 'unresolved' };
  if (status === 'repaired') return { keep: true, status: 'repaired' };
  return { keep: true, status: 'clean' };
}

/**
 * Assemble the sources synthesis runs over, applying the safety-net decision.
 * A kept tool result sits at `[0]` (cited as [1]); RAG cards follow. A dropped
 * (`'unresolved'`) result leaves RAG-only. Pure — used to characterize the
 * `mergedSources` seam in `retrieval.ts` without the whole pipeline.
 */
export function buildMergedSources(
  skillResult: SkillResult | null,
  skillName: string,
  skillArgs: Record<string, unknown>,
  ragSources: readonly SynthesisSource[],
): { readonly mergedSources: SynthesisSource[]; readonly status: ToolRecoveryStatus | 'none' } {
  if (skillResult === null) return { mergedSources: [...ragSources], status: 'none' };
  const decision = decideToolSource(skillResult);
  if (!decision.keep) return { mergedSources: [...ragSources], status: decision.status };
  const toolSource = formatAsSource(skillResult, skillName, skillArgs);
  return { mergedSources: [toolSource, ...ragSources], status: decision.status };
}
