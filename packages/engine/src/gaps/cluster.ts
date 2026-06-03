/**
 * Knowledge Gaps — section clustering (plan U5).
 *
 * Pure logic. The assembly job (U6) supplies gap embeddings, existing-section
 * centroids, and a `namer` (Haiku). This module decides placement and proposes
 * new sections — it NEVER renames or restructures an existing section, so a
 * manager's curation survives re-clustering (KTD6 / AE3).
 *
 * Curation invariants the CALLER must uphold (enforced by input selection, not
 * here): pass only `section_pinned = false` gaps to `assignSections` (a moved
 * gap is never re-placed); `proposeSections` only ever creates new sections, so
 * `name_locked` sections are inherently untouched.
 */

import { cosineDistance, dedupeWithinBatch, type Embedded } from './merge.js';

/**
 * Maximum cosine distance for a gap to join a section / for two gaps to seed a
 * section together. Looser than the merge threshold — sections are coarse
 * topical buckets, not "same question". Env-overridable.
 */
export const SECTION_ASSIGN_MAX_DISTANCE = (() => {
  const raw = process.env['RISEZOME_GAP_SECTION_MAX_DISTANCE'];
  const parsed = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.45;
})();

export interface SectionRef {
  readonly sectionId: string;
  readonly centroid: readonly number[];
}

export interface GapToPlace {
  readonly gapId: string;
  readonly vector: readonly number[];
  readonly title: string;
}

export interface Placement {
  readonly gapId: string;
  /** null == leave in the Uncategorized bucket (R9). */
  readonly sectionId: string | null;
}

/**
 * Place each (unpinned) gap into the nearest existing section within
 * `maxDistance`, else Uncategorized. Does not mutate sections.
 */
export function assignSections(
  gaps: ReadonlyArray<GapToPlace>,
  sections: ReadonlyArray<SectionRef>,
  maxDistance: number = SECTION_ASSIGN_MAX_DISTANCE,
): Placement[] {
  return gaps.map((g) => {
    let best: { sectionId: string; distance: number } | null = null;
    for (const s of sections) {
      const d = cosineDistance(g.vector, s.centroid);
      if (d <= maxDistance && (best === null || d < best.distance)) {
        best = { sectionId: s.sectionId, distance: d };
      }
    }
    return { gapId: g.gapId, sectionId: best?.sectionId ?? null };
  });
}

export interface ProposedSection {
  readonly name: string;
  readonly gapIds: readonly string[];
  readonly centroid: number[];
}

export type SectionNamer = (questions: readonly string[]) => Promise<string>;

/**
 * Cluster the Uncategorized pile and propose a named section for each cluster
 * of 2+ gaps (a lone uncategorized gap does not spawn a section — it waits for
 * company). The `namer` turns a cluster's questions into a short section name.
 */
export async function proposeSections(
  uncategorized: ReadonlyArray<GapToPlace>,
  namer: SectionNamer,
  maxDistance: number = SECTION_ASSIGN_MAX_DISTANCE,
): Promise<ProposedSection[]> {
  const embedded: Array<Embedded<GapToPlace>> = uncategorized.map((g) => ({
    item: g,
    vector: g.vector,
  }));
  const groups = dedupeWithinBatch(embedded, maxDistance).filter((g) => g.members.length >= 2);

  const proposed: ProposedSection[] = [];
  for (const g of groups) {
    const name = await namer(g.members.map((m) => m.title));
    proposed.push({
      name,
      gapIds: g.members.map((m) => m.gapId),
      centroid: g.centroid,
    });
  }
  return proposed;
}
