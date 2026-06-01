import type { SkillResultItem } from '@risezome/engine/skills';
import type { CollectedCard } from './filter.js';

/**
 * Shared card → result-item formatting for the list-shaped Trello skills, so
 * "board › column · members" reads identically across trello_list,
 * trello_by_member, and trello_recently_active.
 */

/** "Roadmap › Doing · Alice, Bob" — board, column, then assignees when present. */
export function cardSubtitle(c: CollectedCard): string {
  const parts = [c.boardName, c.card.listName].filter((s) => s.length > 0);
  let subtitle = parts.join(' › ');
  if (c.card.members.length > 0) {
    subtitle += `${subtitle.length > 0 ? ' · ' : ''}${c.card.members.join(', ')}`;
  }
  return subtitle;
}

export function cardItem(c: CollectedCard): SkillResultItem {
  const subtitle = cardSubtitle(c);
  return {
    title: c.card.name,
    ...(c.card.url.length > 0 ? { url: c.card.url } : {}),
    ...(subtitle.length > 0 ? { subtitle } : {}),
  };
}
