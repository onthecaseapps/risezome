import type { SupabaseClient } from '@supabase/supabase-js';
import { expandToParent, type ParentExpandOptions } from '@risezome/engine/parent-doc';

/**
 * Parent-document (small-to-big) retrieval (U8), gated by
 * RISEZOME_PARENT_DOC_ENABLED. When on, a winning child chunk is expanded to
 * surrounding parent context for the synthesizer (whole doc if it fits under
 * the char cap, else a window of neighbouring chunks). Citations still point
 * at the precise child. Off by default so it can be A/B'd against the eval.
 */

const DEFAULT_CAP_CHARS = 6000;
const DEFAULT_WINDOW_RADIUS = 1;

export function parentDocEnabled(): boolean {
  return process.env.RISEZOME_PARENT_DOC_ENABLED === 'true';
}

/**
 * Collapse retrieved hits to one per document, keeping the best-ranked
 * occurrence (input order is best-first). When one document is split across
 * several retrieved chunks, surfacing them as separate sources both confuses
 * citation (a verbatim quote lands in a sibling rank) and shows the user the
 * same doc as multiple cards. Deduping by docId — combined with parent-doc
 * expansion of the survivor — gives one source/card per document. Hits whose
 * docId can't be resolved are kept (the caller's loop skips truly-missing
 * ones). Order is preserved.
 */
export function dedupeByDoc<T>(items: readonly T[], docIdOf: (item: T) => string | undefined): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = docIdOf(item);
    if (id === undefined) {
      out.push(item);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function envOptions(): ParentExpandOptions {
  const cap = Number(process.env.RISEZOME_PARENT_DOC_CAP_CHARS);
  const radius = Number(process.env.RISEZOME_PARENT_DOC_WINDOW);
  return {
    capChars: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_CAP_CHARS,
    windowRadius:
      Number.isFinite(radius) && radius >= 0 ? Math.floor(radius) : DEFAULT_WINDOW_RADIUS,
  };
}

/** A winning chunk the caller wants expanded. */
export interface WinningChunk {
  readonly chunkId: string;
  readonly docId: string;
  readonly position: number;
  readonly text: string;
}

/**
 * For each winning chunk, return the expanded parent text keyed by chunkId.
 * Fetches the parent docs' body chunks (one query, excluding summary chunks)
 * and runs the pure expansion. On a fetch error, returns each child's own text
 * (graceful degrade — synthesis just sees the child, as before U8).
 */
export async function expandWinnersToParents(
  db: SupabaseClient,
  orgId: string,
  winners: readonly WinningChunk[],
): Promise<Map<string, string>> {
  const byChild = new Map<string, string>(winners.map((w) => [w.chunkId, w.text]));
  if (winners.length === 0) return byChild;

  const options = envOptions();
  const docIds = [...new Set(winners.map((w) => w.docId))];
  const { data: rows, error } = await db
    .from('doc_chunks')
    .select('doc_id, position, text')
    .eq('org_id', orgId) // U11: redundant org scope (defense-in-depth)
    .in('doc_id', docIds)
    .eq('is_summary', false);
  if (error !== null || rows === null) return byChild; // degrade to child-only

  // Group sibling body chunks by doc.
  const siblingsByDoc = new Map<string, { position: number; text: string }[]>();
  for (const r of rows as { doc_id: string; position: number; text: string }[]) {
    const list = siblingsByDoc.get(r.doc_id) ?? [];
    list.push({ position: r.position, text: r.text });
    siblingsByDoc.set(r.doc_id, list);
  }

  for (const w of winners) {
    byChild.set(
      w.chunkId,
      expandToParent({
        childText: w.text,
        childPosition: w.position,
        siblings: siblingsByDoc.get(w.docId) ?? [],
        options,
      }),
    );
  }
  return byChild;
}
