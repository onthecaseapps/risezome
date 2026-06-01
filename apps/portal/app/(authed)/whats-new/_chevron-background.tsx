import type { ReactElement } from 'react';
import styles from './chevron-background.module.css';

/**
 * Full-bleed Risezome rising-chevron background, ported from the Claude
 * Design handoff. Renders absolutely into its (relative) parent. The
 * page composites a centered content card on top.
 */
export function ChevronBackground(): ReactElement {
  return (
    <div className={styles.stage} aria-hidden="true">
      <div className={styles.field} />

      {/* rising bubbles for depth */}
      <div className={styles.bub} style={{ left: '14%', bottom: 0, width: 10, height: 10, animationDuration: '13s' }} />
      <div className={styles.bub} style={{ left: '26%', bottom: 0, width: 6, height: 6, animationDuration: '17s', animationDelay: '3s' }} />
      <div className={styles.bub} style={{ left: '72%', bottom: 0, width: 12, height: 12, animationDuration: '15s', animationDelay: '1.5s' }} />
      <div className={styles.bub} style={{ left: '84%', bottom: 0, width: 7, height: 7, animationDuration: '19s', animationDelay: '6s' }} />
      <div className={styles.bub} style={{ left: '48%', bottom: 0, width: 5, height: 5, animationDuration: '21s', animationDelay: '9s' }} />

      {/* big rising chevrons */}
      <div className={styles.markWrap}>
        <svg viewBox="5 3.5 22 21" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
          <g>
            <path className={`${styles.chev} ${styles.c1}`} d="M6 24l10-8 10 8" strokeWidth="0.85" opacity="0.2" />
            <path className={`${styles.chev} ${styles.c2}`} d="M8 16.5l8-6.4 8 6.4" strokeWidth="0.85" opacity="0.42" />
            <path className={`${styles.chev} ${styles.c3}`} d="M10.5 9.2L16 5l5.5 4.2" strokeWidth="0.95" opacity="0.85" />
          </g>
        </svg>
      </div>

      <div className={styles.grain} />
    </div>
  );
}
