import type { TrelloCard, TrelloComment } from './trello-client';
import { orgScopedDocId } from './doc-id';

/**
 * Stable corpus id for a Trello card. Uses the immutable card `id` (never
 * `idShort`, which regenerates on board move) and the board id for namespacing,
 * mirroring the GitHub indexer's deterministic `docs.id` convention, then
 * org-scopes it so two orgs sharing a board don't collide on the PK.
 */
export function trelloCardDocId(orgId: string, boardId: string, cardId: string): string {
  return orgScopedDocId(orgId, `trello:${boardId}:${cardId}`);
}

/**
 * Build the indexable text for a Trello card: name, a list/members phrase
 * line (the column a card sits in IS its status on a Trello board — "what's
 * in Doing" should match), the description, then the comment thread
 * (`author: text`). Comments carry the "why" that accrues in discussion, so
 * they're part of the card's text (not separate docs) — the card stays the
 * citable unit. Blank sections are omitted so empty descriptions /
 * comment-less cards don't add noise.
 */
export function buildCardDocText(card: TrelloCard, comments: readonly TrelloComment[]): string {
  const parts: string[] = [card.name.trim()];

  const meta: string[] = [];
  if (card.listName.trim().length > 0) meta.push(`List: ${card.listName.trim()}.`);
  if (card.members.length > 0) meta.push(`Members: ${card.members.join(', ')}.`);
  if (meta.length > 0) parts.push(meta.join(' '));

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
