import type { DemoCard, DemoSource, DemoType } from './types';
import { TypeGlyph } from './glyphs';

const KNOWN_SOURCES: readonly DemoSource[] = ['github', 'jira', 'slack', 'code'];

/** Mirrors the HUD SOURCE_ACCENT map: known source → chip class, else default. */
export function sourceChipClass(source: DemoSource): string {
  const accent = KNOWN_SOURCES.includes(source) ? source : 'default';
  return `chip-source chip-source-${accent}`;
}

const TYPE_LABEL: Readonly<Record<DemoType, string>> = {
  issue: 'Issue',
  'pull-request': 'PR',
  code: 'Code',
  doc: 'Doc',
};

/** Mirrors HUD formatRank: rank 1 is the accented "Top match". */
export function rankLabel(rank: number): string {
  return rank === 1 ? 'Top match' : 'Match';
}

/** The "GITHUB · DOC … TOP MATCH" metadata row shared by raw and consolidated cards. */
export function CardHeaderRow({ card }: { card: DemoCard }): React.ReactElement {
  return (
    <div className="header">
      <span className="source">
        <span className={sourceChipClass(card.source)}>{card.source}</span>
        <span aria-hidden="true">·</span>
        <span className="chip-type">
          <TypeGlyph type={card.type} />
          {TYPE_LABEL[card.type]}
        </span>
      </span>
      <span className={card.rank === 1 ? 'score top' : 'score'}>{rankLabel(card.rank)}</span>
    </div>
  );
}
