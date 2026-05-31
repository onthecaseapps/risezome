import type { ReactElement } from 'react';
import type { CardEvent, KnownSource, KnownType } from '../types';
import { KNOWN_SOURCES, KNOWN_TYPES } from '../types';
import { TypeGlyph } from './glyphs';

const TYPE_LABEL: Readonly<Record<KnownType, string>> = {
  issue: 'Issue',
  'pull-request': 'PR',
  code: 'Code',
  doc: 'Doc',
  card: 'Card',
  page: 'Page',
};

function isKnownSource(s: string): s is KnownSource {
  return (KNOWN_SOURCES as readonly string[]).includes(s);
}

function isKnownType(t: string): t is KnownType {
  return (KNOWN_TYPES as readonly string[]).includes(t);
}

/** Mirrors the HUD SOURCE_ACCENT map: known source → chip class, else default. */
export function sourceChipClass(source: string): string {
  const accent = isKnownSource(source) ? source : 'default';
  return `chip-source chip-source-${accent}`;
}

/** Mirrors HUD formatRank: rank 1 is the accented "Top match". */
export function rankLabel(rank: number): string {
  return rank === 1 ? 'Top match' : 'Match';
}

/** The "GITHUB · DOC … TOP MATCH" metadata row shared by raw and consolidated cards. */
export function CardHeaderRow({ card }: { card: CardEvent }): ReactElement {
  const typeLabel = isKnownType(card.type) ? TYPE_LABEL[card.type] : card.type;
  return (
    <div className="header">
      <span className="source">
        <span className={sourceChipClass(card.source)}>{card.source}</span>
        <span aria-hidden="true">·</span>
        <span className="chip-type">
          {isKnownType(card.type) ? <TypeGlyph type={card.type} label={typeLabel} /> : null}
          {typeLabel}
        </span>
      </span>
      <span className={card.rank === 1 ? 'score top' : 'score'}>{rankLabel(card.rank)}</span>
    </div>
  );
}
