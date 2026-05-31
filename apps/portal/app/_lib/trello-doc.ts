import type { TrelloCard, TrelloComment } from './trello-client';

/**
 * Stable corpus id for a Trello card. Uses the immutable card `id` (never
 * `idShort`, which regenerates on board move) and the board id for namespacing,
 * mirroring the GitHub indexer's deterministic `docs.id` convention.
 */
export function trelloCardDocId(boardId: string, cardId: string): string {
  return `trello:${boardId}:${cardId}`;
}

/**
 * Build the indexable text for a Trello card: name, description, then the
 * comment thread (`author: text`). Comments carry the "why" that accrues in
 * discussion, so they're part of the card's text (not separate docs) — the card
 * stays the citable unit. Blank sections are omitted so empty descriptions /
 * comment-less cards don't add noise.
 */
export function buildCardDocText(card: TrelloCard, comments: readonly TrelloComment[]): string {
  const parts: string[] = [card.name.trim()];

  const desc = card.desc.trim();
  if (desc.length > 0) parts.push(desc);

  const commentLines = comments
    .map((c) => {
      const text = c.text.trim();
      if (text.length === 0) return null;
      const who = c.author ?? 'Unknown';
      return `${who}: ${text}`;
    })
    .filter((line): line is string => line !== null);

  if (commentLines.length > 0) {
    parts.push(`Comments:\n${commentLines.join('\n')}`);
  }

  return parts.join('\n\n');
}
