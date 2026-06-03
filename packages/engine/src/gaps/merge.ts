/**
 * Knowledge Gaps — semantic merge (plan U4).
 *
 * Pure logic: no DB, no network. The assembly job (U6) supplies embeddings
 * (from Voyage) and existing-gap candidates (from a pgvector NN query); this
 * module decides what merges into what.
 *
 * Precision over recall (KTD5): the threshold is deliberately tight so that
 * questions sharing keywords but asking different things do NOT merge (AE2),
 * accepting that an occasional true duplicate stays separate (it just shows as
 * two gaps until a manager merges them). Distances are cosine over Voyage
 * voyage-3-large 1024-dim vectors; the corpus anchors are 0.30 "strong" and
 * 0.45 "relevance floor" (apps/bot-worker/src/corpus-search.ts).
 */

/**
 * Maximum cosine distance for two questions to be "the same gap". Tighter than
 * the corpus 0.30 "strong" anchor to protect AE2. Env-overridable for tuning;
 * calibrate against the AE1/AE2 fixtures before changing in production.
 */
export const GAP_MERGE_MAX_DISTANCE = (() => {
  const raw = process.env['RISEZOME_GAP_MERGE_MAX_DISTANCE'];
  const parsed = raw === undefined ? NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0.22;
})();

/** Cosine distance in [0, 2]; 0 == identical direction. Returns 1 for a zero vector. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function meanVector(vectors: ReadonlyArray<readonly number[]>): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const acc = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
  }
  for (let i = 0; i < dim; i++) acc[i] = (acc[i] ?? 0) / vectors.length;
  return acc;
}

export interface Embedded<T> {
  readonly item: T;
  readonly vector: readonly number[];
}

export interface DedupGroup<T> {
  readonly members: readonly T[];
  /** Centroid of the group's member vectors — the key for library matching. */
  readonly centroid: number[];
}

/**
 * Greedily collapse a single meeting's misses so two phrasings of the same
 * question in one call become one group (the intra-batch hole). Each item joins
 * the first existing group whose centroid is within `maxDistance`, else starts
 * a new group. Centroids are recomputed as members are added.
 */
export function dedupeWithinBatch<T>(
  items: ReadonlyArray<Embedded<T>>,
  maxDistance: number = GAP_MERGE_MAX_DISTANCE,
): Array<DedupGroup<T>> {
  const groups: Array<{ members: T[]; vectors: number[][]; centroid: number[] }> = [];
  for (const { item, vector } of items) {
    let placed = false;
    for (const g of groups) {
      if (cosineDistance(g.centroid, vector) <= maxDistance) {
        g.members.push(item);
        g.vectors.push([...vector]);
        g.centroid = meanVector(g.vectors);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ members: [item], vectors: [[...vector]], centroid: [...vector] });
    }
  }
  return groups.map((g) => ({ members: g.members, centroid: g.centroid }));
}

export interface GapCandidate {
  readonly gapId: string;
  readonly vector: readonly number[];
}

/**
 * Nearest existing gap to a dedup group's centroid within `maxDistance`, or
 * null when none qualifies (→ create a new gap). Ties resolve to the closest.
 */
export function findMergeTarget(
  centroid: readonly number[],
  candidates: ReadonlyArray<GapCandidate>,
  maxDistance: number = GAP_MERGE_MAX_DISTANCE,
): string | null {
  let best: { gapId: string; distance: number } | null = null;
  for (const c of candidates) {
    const d = cosineDistance(centroid, c.vector);
    if (d <= maxDistance && (best === null || d < best.distance)) {
      best = { gapId: c.gapId, distance: d };
    }
  }
  return best?.gapId ?? null;
}
