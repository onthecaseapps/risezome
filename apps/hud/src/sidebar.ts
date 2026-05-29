import type {
  CardEvent,
  CardRetracted,
  CardUpdated,
  GapEvent,
  SynthesisDeltaEvent,
  SynthesisDoneEvent,
  SynthesisRetractedEvent,
  SynthesisStartEvent,
} from './types.js';
import { detectLanguage, highlightCode, parseSnippet } from './highlight.js';
import { renderIcon, type IconName } from './icons.js';

export interface SidebarOptions {
  readonly streamEl: HTMLElement;
  readonly pinnedEl: HTMLElement;
  readonly onPin?: (cardId: string) => void;
  readonly onUnpin?: (cardId: string) => void;
  readonly onLogGap?: (gapId: string) => void;
  readonly onDismissGap?: (gapId: string) => void;
}

interface CardRecord {
  card: CardEvent;
  el: HTMLElement;
  pinned: boolean;
}

interface SynthesisRecord {
  readonly synthesisId: string;
  readonly el: HTMLElement;
  readonly bodyEl: HTMLElement;
  readonly cursorEl: HTMLElement;
  readonly citationsEl: HTMLElement;
  readonly sourceCardIds: readonly string[];
  accumulatedText: string;
  readonly renderedCitations: Set<number>;
  /**
   * Cards consolidated into this synthesis on synthesisDone. We track the
   * record + the original sibling that came right after it in #streamEl, so
   * if the synthesis is later retracted/erred we can restore each card to
   * its original stream position instead of always sending it to the top.
   */
  consolidated: { record: CardRecord; nextSibling: ChildNode | null }[];
  /** Container the consolidated raw cards live inside while consolidated. */
  consolidatedContainer: HTMLElement | null;
}

export class Sidebar {
  readonly #streamEl: HTMLElement;
  readonly #pinnedEl: HTMLElement;
  readonly #announceEl: HTMLElement | null;
  readonly #badgeEl: HTMLElement | null;
  readonly #badgeCountEl: HTMLElement | null;
  readonly #onPin: (cardId: string) => void;
  readonly #onUnpin: (cardId: string) => void;
  readonly #onLogGap: (gapId: string) => void;
  readonly #onDismissGap: (gapId: string) => void;
  readonly #cards = new Map<string, CardRecord>();
  readonly #gaps = new Map<string, HTMLElement>();
  readonly #syntheses = new Map<string, SynthesisRecord>();
  /**
   * UI4 hover-safe scroll: when the mouse is over the stream the user is
   * likely reading. we suppress the auto-scroll-to-top and stash a counter
   * of "new content since hover started," surfaced as a pulsing badge.
   * On mouse-leave or badge click we scroll to top and reset.
   */
  #streamHovered = false;
  #pendingNewCount = 0;
  #emptyStateEl: HTMLElement | null = null;
  #emptyStateMsgEl: HTMLElement | null = null;
  #emptyStateTimer: ReturnType<typeof setInterval> | null = null;
  #lastEmptyMessageIdx = -1;

  constructor(options: SidebarOptions) {
    this.#streamEl = options.streamEl;
    this.#pinnedEl = options.pinnedEl;
    const doc = this.#streamEl.ownerDocument;
    this.#announceEl = doc.getElementById('synthesis-announce');
    this.#badgeEl = doc.getElementById('new-content-badge');
    this.#badgeCountEl = doc.getElementById('new-content-count');
    this.#onPin = options.onPin ?? ((): void => undefined);
    this.#onUnpin = options.onUnpin ?? ((): void => undefined);
    this.#onLogGap = options.onLogGap ?? ((): void => undefined);
    this.#onDismissGap = options.onDismissGap ?? ((): void => undefined);
    this.#wireScrollSafety();
    this.#wireEmptyState();
  }

  // Empty-state messaging: when the stream has no cards/syntheses/gaps,
  // a small playful placeholder rotates a quirky line every 10s. Hidden
  // the moment the first real piece of content arrives; reappears if all
  // content is later removed.
  #wireEmptyState(): void {
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('div');
    el.className = 'empty-state';
    const msg = doc.createElement('span');
    msg.className = 'empty-state-msg';
    el.appendChild(msg);
    this.#emptyStateEl = el;
    this.#emptyStateMsgEl = msg;
    this.#streamEl.appendChild(el);
    this.#updateEmptyState();
    // MutationObserver fires on any direct childList change of the stream,
    // so we don't have to remember to call updateEmptyState() at every
    // render/remove site. Filters out our own toggling by checking the
    // class name on added/removed nodes.
    const win = doc.defaultView;
    if (win === null) return;
    const Observer = win.MutationObserver;
    if (Observer === undefined) return;
    const observer = new Observer(() => this.#updateEmptyState());
    observer.observe(this.#streamEl, { childList: true });
  }

  #updateEmptyState(): void {
    if (this.#emptyStateEl === null) return;
    const childCount = this.#streamEl.children.length;
    const emptyVisible = this.#emptyStateEl.parentNode === this.#streamEl;
    const realChildren = emptyVisible ? childCount - 1 : childCount;
    if (realChildren === 0) {
      if (!emptyVisible) this.#streamEl.appendChild(this.#emptyStateEl);
      this.#rotateEmptyMessage();
      this.#startEmptyTimer();
    } else {
      if (emptyVisible) this.#emptyStateEl.remove();
      this.#stopEmptyTimer();
    }
  }

  #startEmptyTimer(): void {
    if (this.#emptyStateTimer !== null) return;
    this.#emptyStateTimer = setInterval(() => this.#rotateEmptyMessage(), 10_000);
  }

  #stopEmptyTimer(): void {
    if (this.#emptyStateTimer !== null) {
      clearInterval(this.#emptyStateTimer);
      this.#emptyStateTimer = null;
    }
  }

  #rotateEmptyMessage(): void {
    if (this.#emptyStateMsgEl === null) return;
    const messages = EMPTY_STATE_MESSAGES;
    if (messages.length === 0) return;
    let idx = Math.floor(Math.random() * messages.length);
    // Avoid showing the same message twice in a row when we can.
    if (messages.length > 1 && idx === this.#lastEmptyMessageIdx) {
      idx = (idx + 1) % messages.length;
    }
    this.#lastEmptyMessageIdx = idx;
    this.#emptyStateMsgEl.textContent = messages[idx]!;
  }

  /** Test helper: stop the rotation timer to keep happy-dom test cleanup tidy. */
  destroy(): void {
    this.#stopEmptyTimer();
  }

  #wireScrollSafety(): void {
    this.#streamEl.addEventListener('mouseenter', () => {
      this.#streamHovered = true;
    });
    this.#streamEl.addEventListener('mouseleave', () => {
      this.#streamHovered = false;
      if (this.#pendingNewCount > 0) this.#flushPendingNew();
    });
    this.#badgeEl?.addEventListener('click', () => this.#flushPendingNew());
  }

  /** Called by every "new content lands at the top of the stream" code path. */
  #onNewContent(): void {
    if (this.#streamHovered) {
      this.#pendingNewCount += 1;
      if (this.#badgeCountEl !== null) {
        this.#badgeCountEl.textContent = String(this.#pendingNewCount);
      }
      this.#badgeEl?.classList.remove('hidden');
    } else {
      this.#scrollStreamToTop();
    }
  }

  #flushPendingNew(): void {
    this.#pendingNewCount = 0;
    if (this.#badgeCountEl !== null) this.#badgeCountEl.textContent = '0';
    this.#badgeEl?.classList.add('hidden');
    this.#scrollStreamToTop();
  }

  #scrollStreamToTop(): void {
    // happy-dom doesn't implement scrollIntoView smoothness; both happy-dom
    // and real browsers honor the call. Wrapped in try/catch for the
    // case where the element is detached.
    try {
      this.#streamEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      // ignore
    }
  }

  renderCard(card: CardEvent): void {
    if (this.#cards.has(card.cardId)) return;
    const el = this.#buildCardElement(card);
    // Newest first: prepend so fresh meeting context is always at the top
    // of the stream instead of pushing the user to scroll for it.
    this.#streamEl.insertBefore(el, this.#streamEl.firstChild);
    applyEnterAnimation(el);
    this.#cards.set(card.cardId, { card, el, pinned: false });
    this.#onNewContent();
  }

  updateCard(update: CardUpdated): void {
    const rec = this.#cards.get(update.cardId);
    if (rec === undefined) return;
    if (update.score !== undefined) {
      const scoreEl = rec.el.querySelector('.score');
      if (scoreEl !== null) scoreEl.textContent = formatScore(update.score);
    }
    if (update.triggeredBy !== undefined) {
      rec.card = { ...rec.card, triggeredBy: update.triggeredBy };
      this.#refreshTriggerClass(rec);
    }
    rec.el.classList.add('updated');
    setTimeout(() => rec.el.classList.remove('updated'), 250);
  }

  retractCard(retract: CardRetracted): void {
    const rec = this.#cards.get(retract.cardId);
    if (rec === undefined) return;
    rec.el.classList.add('retracting');
    rec.el.remove();
    this.#cards.delete(retract.cardId);
  }

  renderGap(gap: GapEvent): void {
    if (this.#gaps.has(gap.gapId)) return;
    const el = this.#buildGapElement(gap);
    this.#streamEl.insertBefore(el, this.#streamEl.firstChild);
    applyEnterAnimation(el);
    this.#gaps.set(gap.gapId, el);
    this.#onNewContent();
  }

  togglePin(cardId: string): void {
    const rec = this.#cards.get(cardId);
    if (rec === undefined) return;
    if (rec.pinned) {
      rec.pinned = false;
      this.#streamEl.appendChild(rec.el);
      rec.el.classList.remove('pinned');
      this.#onUnpin(cardId);
    } else {
      rec.pinned = true;
      this.#pinnedEl.appendChild(rec.el);
      rec.el.classList.add('pinned');
      this.#onPin(cardId);
    }
  }

  visibleCardCount(): number {
    return this.#cards.size;
  }

  visibleGapCount(): number {
    return this.#gaps.size;
  }

  visibleSynthesisCount(): number {
    return this.#syntheses.size;
  }

  // --- Synthesis card lifecycle ---

  renderSynthesisStart(start: SynthesisStartEvent): void {
    if (this.#syntheses.has(start.synthesisId)) return;
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('article');
    el.className = 'card synthesis';
    el.dataset['synthesisId'] = start.synthesisId;
    // U4: explicit kind attribute so tests + future selectors can target
    // the synthesis card by data attribute rather than class name (which
    // can change as we refactor visual treatment).
    el.dataset['kind'] = 'synthesis';
    // aria-live="off". per-token DOM mutations would spam SR; the
    // #synthesis-announce sibling element receives the final text once.
    el.setAttribute('aria-live', 'off');

    const header = doc.createElement('div');
    header.className = 'header';
    const label = doc.createElement('span');
    label.className = 'ai-label';
    label.textContent = 'AI SUMMARY';
    header.appendChild(label);

    const bodyEl = doc.createElement('div');
    bodyEl.className = 'synthesis-body';

    const cursorEl = doc.createElement('span');
    cursorEl.className = 'synthesis-cursor';
    cursorEl.textContent = '▊';
    cursorEl.setAttribute('aria-hidden', 'true');

    const citationsEl = doc.createElement('div');
    citationsEl.className = 'citations';

    el.append(header, bodyEl, cursorEl, citationsEl);
    this.#streamEl.insertBefore(el, this.#streamEl.firstChild);
    applyEnterAnimation(el);

    this.#syntheses.set(start.synthesisId, {
      synthesisId: start.synthesisId,
      el,
      bodyEl,
      cursorEl,
      citationsEl,
      sourceCardIds: start.sourceCardIds,
      accumulatedText: '',
      renderedCitations: new Set(),
      consolidated: [],
      consolidatedContainer: null,
    });
    this.#onNewContent();
  }

  appendSynthesisDelta(delta: SynthesisDeltaEvent): void {
    const rec = this.#syntheses.get(delta.synthesisId);
    if (rec === undefined) return;
    rec.accumulatedText += delta.delta;
    // Append text content cheaply. never re-render the whole body.
    rec.bodyEl.textContent = rec.accumulatedText;
    // Eager citation chip render: scan accumulated text for new [N] tokens.
    for (const match of rec.accumulatedText.matchAll(/\[(\d+)\]/g)) {
      const n = Number(match[1]);
      if (
        Number.isInteger(n)
        && n >= 1
        && n <= rec.sourceCardIds.length
        && !rec.renderedCitations.has(n)
      ) {
        rec.renderedCitations.add(n);
        this.#renderCitationChip(rec, n);
      }
    }
  }

  finalizeSynthesis(done: SynthesisDoneEvent): void {
    const rec = this.#syntheses.get(done.synthesisId);
    if (rec === undefined) return;
    // Remove the cursor.
    rec.cursorEl.remove();
    // Reconcile chips: drop any chip not in the final citation set.
    const finalSet = new Set(done.citations);
    const chips = Array.from(rec.citationsEl.querySelectorAll<HTMLElement>('.citation-chip'));
    for (const chip of chips) {
      const n = Number(chip.dataset['rank']);
      if (!finalSet.has(n)) {
        chip.remove();
        rec.renderedCitations.delete(n);
      }
    }
    // Strip invalid [N] tokens from the visible text. The synthesizer's
    // parser already drops out-of-range citations from the citations array,
    // but the original token stays in the streamed text and reads as junk
    // (e.g. "There are 15 open issues [0]."). Walk the body and remove any
    // [N] not in the final citations set, then tidy up the gaps.
    const validSet = new Set<number>(done.citations);
    const cleaned = rec.accumulatedText
      .replace(/\s*\[(\d+)\]/g, (m, raw: string) => {
        const n = Number(raw);
        return Number.isInteger(n) && validSet.has(n) ? m : '';
      })
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned !== rec.accumulatedText) {
      rec.bodyEl.textContent = cleaned;
    }
    // Announce the final text once. Use the cleaned form so screen readers
    // also benefit.
    if (this.#announceEl !== null) {
      this.#announceEl.textContent = cleaned;
    }
    // Consolidate: move the raw source cards from the main stream into a
    // grid inside the synthesis card. Restored to original positions on
    // synthesis removal (error/retract) so the user never loses access.
    this.#consolidateRawCards(rec);
  }

  removeSynthesis(synthesisId: string): void {
    const rec = this.#syntheses.get(synthesisId);
    if (rec === undefined) return;
    // Return any consolidated cards back to the main stream before tearing
    // the synthesis card down. the user expects the raw retrieval cards to
    // remain visible when synthesis fails/refuses/retracts.
    this.#deconsolidateRawCards(rec);
    rec.el.remove();
    this.#syntheses.delete(synthesisId);
  }

  retractSynthesis(retracted: SynthesisRetractedEvent): void {
    this.removeSynthesis(retracted.synthesisId);
  }

  // Moves the raw source cards out of #streamEl and into a grid inside the
  // synthesis card. Pinned cards (which live in #pinnedEl) are skipped. the
  // user already decided to keep them visible, no need to duplicate.
  #consolidateRawCards(rec: SynthesisRecord): void {
    const doc = this.#streamEl.ownerDocument;
    const movable: { record: CardRecord; nextSibling: ChildNode | null }[] = [];
    for (const cardId of rec.sourceCardIds) {
      const cardRec = this.#cards.get(cardId);
      if (cardRec === undefined) continue;
      if (cardRec.pinned) continue;
      // Only consolidate cards currently in the stream. if a card was
      // retracted before we got here, its el is detached and we skip.
      if (cardRec.el.parentNode !== this.#streamEl) continue;
      movable.push({ record: cardRec, nextSibling: cardRec.el.nextSibling });
    }
    if (movable.length === 0) return;

    const container = doc.createElement('div');
    container.className = 'synthesis-sources';
    const label = doc.createElement('div');
    label.className = 'synthesis-sources-label';
    label.textContent = `Sources (${String(movable.length)})`;
    container.appendChild(label);
    const grid = doc.createElement('div');
    grid.className = 'synthesis-sources-grid';
    container.appendChild(grid);

    for (const entry of movable) {
      entry.record.el.classList.add('consolidated');
      grid.appendChild(entry.record.el);
    }
    rec.el.appendChild(container);
    rec.consolidated = movable;
    rec.consolidatedContainer = container;
  }

  // Restores consolidated cards to their original positions in #streamEl
  // before the synthesis card disappears. Each card is reinserted before
  // the sibling it was originally followed by, so the user perceives the
  // stream state as if no consolidation had ever happened.
  #deconsolidateRawCards(rec: SynthesisRecord): void {
    for (const entry of rec.consolidated) {
      entry.record.el.classList.remove('consolidated');
      // If the original next sibling still exists in the stream, insert
      // before it; otherwise append. nextSibling may have been removed
      // (e.g., retracted) in the interim.
      if (
        entry.nextSibling !== null
        && entry.nextSibling.parentNode === this.#streamEl
      ) {
        this.#streamEl.insertBefore(entry.record.el, entry.nextSibling);
      } else {
        this.#streamEl.appendChild(entry.record.el);
      }
    }
    rec.consolidated = [];
    if (rec.consolidatedContainer !== null) {
      rec.consolidatedContainer.remove();
      rec.consolidatedContainer = null;
    }
  }

  #renderCitationChip(rec: SynthesisRecord, rank: number): void {
    const doc = this.#streamEl.ownerDocument;
    const cardId = rec.sourceCardIds[rank - 1];
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'citation-chip';
    chip.dataset['rank'] = String(rank);
    if (typeof cardId === 'string') chip.dataset['cardId'] = cardId;
    chip.textContent = `[${String(rank)}]`;
    chip.addEventListener('click', () => {
      if (typeof cardId !== 'string') return;
      const target = doc.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    rec.citationsEl.appendChild(chip);
  }

  #buildCardElement(card: CardEvent): HTMLElement {
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('article');
    el.className = 'card';
    el.dataset.cardId = card.cardId;
    if (card.triggeredBy === 'question-provisional') {
      el.classList.add('provisional');
    }

    const header = doc.createElement('div');
    header.className = 'header';
    const sourceLabel = doc.createElement('span');
    sourceLabel.className = 'source';
    sourceLabel.append(buildSourceChip(doc, card.source), buildTypeChip(doc, card.type));
    const scoreLabel = doc.createElement('span');
    scoreLabel.className = 'score';
    scoreLabel.textContent = formatRank(card.rank);
    if (card.rank === 1) scoreLabel.classList.add('top');
    header.append(sourceLabel, scoreLabel);

    const title = doc.createElement('div');
    title.className = 'title';
    const titleText = card.title === '' ? card.docId : card.title;
    if (typeof card.url === 'string' && card.url.length > 0) {
      const link = doc.createElement('a');
      link.href = card.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = titleText;
      title.appendChild(link);
    } else {
      title.textContent = titleText;
    }

    const snippetEl = buildSnippet(doc, card);

    const actions = doc.createElement('div');
    actions.className = 'actions';
    const pinBtn = makeIconButton(doc, 'thumbtack', 'Pin', () => this.togglePin(card.cardId));
    pinBtn.dataset['action'] = 'pin';
    actions.append(pinBtn);

    el.append(header, title, snippetEl, actions);
    return el;
  }

  #buildGapElement(gap: GapEvent): HTMLElement {
    const doc = this.#streamEl.ownerDocument;
    const el = doc.createElement('article');
    el.className = 'card gap';
    el.dataset.gapId = gap.gapId;

    const header = doc.createElement('div');
    header.className = 'header';
    header.textContent = 'Gap';

    const title = doc.createElement('div');
    title.className = 'title';
    title.textContent = gap.question;

    const snippet = doc.createElement('div');
    snippet.className = 'snippet prose';
    snippet.textContent = truncate(gap.contextWindow, 600);

    const actions = doc.createElement('div');
    actions.className = 'actions';
    const logBtn = makeIconButton(doc, 'bookmark', 'Log gap', () => this.#onLogGap(gap.gapId));
    const dismissBtn = makeIconButton(doc, 'xmark', 'Dismiss', () => {
      this.#gaps.delete(gap.gapId);
      el.remove();
      this.#onDismissGap(gap.gapId);
    });
    actions.append(logBtn, dismissBtn);

    el.append(header, title, snippet, actions);
    return el;
  }

  #refreshTriggerClass(rec: CardRecord): void {
    rec.el.classList.toggle('provisional', rec.card.triggeredBy === 'question-provisional');
  }
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// Card action buttons (Pin / Log gap / Dismiss). icon on the left, label
// on the right. Single helper so styling stays consistent and adding new
// actions is a one-liner.
// Quirky empty-state messages playing on Upwell's oceanographic theme
// (upwelling = deep water rising to the surface). 10-second rotation
// keeps the HUD feeling alive during quiet stretches without becoming
// distracting. New messages are easy to add. just append.
export const EMPTY_STATE_MESSAGES: readonly string[] = [
  'Waiting for some swell information to surface.',
  'Preparing to propel pertinent payloads.',
  'Listening for ripples in the conversation.',
  'Casting nets across your repos.',
  'Calm currents. Awaiting your voice.',
  'Polling the depths of your corpus.',
  'Riding the swell, awaiting landfall.',
  'Sieving signal from the chatter.',
  'Idle waters run deep. Speak to fathom them.',
  'Buoys are bobbing, results incoming.',
  'Calibrating the conversational compass.',
  'Sharpening the synthesizer’s edges.',
  'Beachcombing the corpus while you think.',
  'Hush mode engaged. The HUD listens.',
];

function makeIconButton(
  doc: Document,
  icon: IconName,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.title = label;
  btn.append(renderIcon(doc, icon, { size: '12px' }));
  const text = doc.createElement('span');
  text.className = 'icon-btn-label';
  text.textContent = label;
  btn.append(text);
  btn.addEventListener('click', onClick);
  return btn;
}

function formatRank(rank: number): string {
  if (rank === 1) return 'Top match';
  return 'Match';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// Code chunks arrive with a `// path:lines\n<body>` prefix. When present,
// render the location as a separate pill and the body as a scrollable,
// syntax-highlighted block. Otherwise fall back to plain prose so issue
// titles, doc paragraphs, and other non-code snippets still read naturally.
function buildSnippet(doc: Document, card: CardEvent): HTMLElement {
  const parsed = parseSnippet(card.snippet);
  if (parsed.location === null) {
    const el = doc.createElement('div');
    el.className = 'snippet prose';
    el.textContent = truncate(card.snippet, 600);
    return el;
  }

  const wrap = doc.createElement('div');
  wrap.className = 'snippet code';

  const loc = doc.createElement('div');
  loc.className = 'code-location';
  if (typeof card.url === 'string' && card.url.length > 0) {
    const a = doc.createElement('a');
    a.href = card.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = parsed.location;
    loc.appendChild(a);
  } else {
    loc.textContent = parsed.location;
  }
  wrap.appendChild(loc);

  const pre = doc.createElement('pre');
  pre.className = 'code-block';
  const codeEl = doc.createElement('code');
  const language = detectLanguage(parsed.location);
  codeEl.className = `language-${language}`;
  codeEl.innerHTML = highlightCode(parsed.body, language);
  pre.appendChild(codeEl);
  wrap.appendChild(pre);

  return wrap;
}

// U3: Source/type chips. Two small pills near the card title that signal
// where a card came from and what kind of artifact it is.
//
// The color palette below is **internal-convention discriminability**,
// NOT brand colors. Brand-mimicking colors actively confuse users —
// GitHub isn't purple, Slack isn't green, Jira's blue is darker than
// Tailwind's. The glyph carries the brand signal; the color just
// distinguishes sources visually at a glance. Future contributors:
// please don't "fix" these to brand without re-reading the brainstorm
// in docs/brainstorms/hud-visual-polish-requirements.md.
const SOURCE_ACCENT: Readonly<Record<string, string>> = {
  github: 'github',
  jira: 'jira',
  slack: 'slack',
  code: 'code',
};

interface TypeGlyph {
  readonly icon: IconName;
  readonly label: string;
}

const TYPE_GLYPH: Readonly<Record<string, TypeGlyph>> = {
  'issue': { icon: 'circleDot', label: 'Issue' },
  'pull-request': { icon: 'codePullRequest', label: 'Pull request' },
  'code': { icon: 'code', label: 'Code' },
  'doc': { icon: 'fileLines', label: 'Doc' },
};

function buildSourceChip(doc: Document, source: string): HTMLElement {
  const chip = doc.createElement('span');
  const accent = SOURCE_ACCENT[source] ?? 'default';
  chip.className = `chip-source chip-source-${accent}`;
  chip.textContent = source;
  return chip;
}

function buildTypeChip(doc: Document, type: string): HTMLElement {
  const glyph = TYPE_GLYPH[type];
  if (glyph === undefined) {
    // Unknown type: fall back to the source label only (no chip rendered).
    // Empty span keeps the .source flex layout consistent.
    const empty = doc.createElement('span');
    empty.className = 'chip-type chip-type-unknown';
    return empty;
  }
  const chip = doc.createElement('span');
  chip.className = `chip-type chip-type-${type}`;
  chip.dataset['glyph'] = glyph.icon;
  chip.appendChild(renderIcon(doc, glyph.icon, { ariaLabel: glyph.label, size: '0.85em' }));
  return chip;
}

// Adds the `is-entering` class to a freshly-inserted element and cleans it up
// via TWO mechanisms: an `animationend` listener AND a setTimeout safety net.
// The timeout matters because `animationend` does not fire reliably when
// animations are suppressed (prefers-reduced-motion) or when the tab is
// occluded. Both removals are idempotent; whichever fires first wins.
//
// Duration constant slightly longer than the CSS animation (220ms) so the
// setTimeout doesn't preempt a real animation that's about to complete.
const ENTER_ANIMATION_CLEANUP_MS = 400;
function applyEnterAnimation(el: HTMLElement): void {
  el.classList.add('is-entering');
  const cleanup = (): void => {
    el.classList.remove('is-entering');
  };
  el.addEventListener('animationend', cleanup, { once: true });
  setTimeout(cleanup, ENTER_ANIMATION_CLEANUP_MS);
}
