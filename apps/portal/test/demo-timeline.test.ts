import { describe, it, expect } from 'vitest';
import {
  INITIAL_STATE,
  TIMELINE,
  TIMELINE_END_MS,
  SYNTHESIS_TEXT,
  applyEvent,
  stateAtElapsed,
  stepFor,
  terminalState,
  type DemoState,
} from '../app/components/demo/demo-timeline';

describe('applyEvent (pure reducer)', () => {
  it('appends transcript lines and cards in order', () => {
    let s: DemoState = INITIAL_STATE;
    s = applyEvent(s, { kind: 'transcript', line: { id: 'a', speaker: 'P', text: 'one' } });
    s = applyEvent(s, { kind: 'transcript', line: { id: 'b', speaker: 'M', text: 'two' } });
    expect(s.transcript.map((l) => l.id)).toEqual(['a', 'b']);
    expect(s.cards).toHaveLength(0);
  });

  it('accumulates synthesis text across deltas then finalizes on done', () => {
    let s: DemoState = INITIAL_STATE;
    s = applyEvent(s, { kind: 'synthesisStart' });
    expect(s.synthesis?.streaming).toBe(true);
    s = applyEvent(s, { kind: 'synthesisDelta', delta: 'Hello ' });
    s = applyEvent(s, { kind: 'synthesisDelta', delta: 'world' });
    expect(s.synthesis?.text).toBe('Hello world');
    s = applyEvent(s, { kind: 'synthesisDone', citations: [1], sources: [] });
    expect(s.synthesis?.streaming).toBe(false);
    expect(s.synthesis?.citations).toEqual([1]);
  });

  it('ignores synthesis deltas that arrive before a start (no crash, no-op)', () => {
    const s = applyEvent(INITIAL_STATE, { kind: 'synthesisDelta', delta: 'orphan' });
    expect(s.synthesis).toBeNull();
  });

  it('expands a source only after the synthesis is done', () => {
    let s: DemoState = INITIAL_STATE;
    s = applyEvent(s, { kind: 'synthesisStart' });
    // Clicking while streaming is a no-op.
    s = applyEvent(s, { kind: 'expandSource', sourceId: 'pr-482' });
    expect(s.synthesis?.expandedSourceId).toBeNull();
    s = applyEvent(s, { kind: 'synthesisDone', citations: [1], sources: [] });
    s = applyEvent(s, { kind: 'expandSource', sourceId: 'pr-482' });
    expect(s.synthesis?.expandedSourceId).toBe('pr-482');
  });

  it('does not mutate the input state', () => {
    const before = INITIAL_STATE;
    applyEvent(before, { kind: 'card', card: { id: 'x', source: 'github', type: 'doc', title: 't', snippet: 's', rank: 1 } });
    expect(before).toBe(INITIAL_STATE);
    expect(before.cards).toHaveLength(0);
  });
});

describe('stateAtElapsed (cursor fold)', () => {
  it('returns the empty initial state at t=0', () => {
    expect(stateAtElapsed(0)).toEqual(INITIAL_STATE);
  });

  it('applies only events due so far at partial elapsed time', () => {
    // First transcript line fires at 250ms; nothing before it.
    expect(stateAtElapsed(249).transcript).toHaveLength(0);
    expect(stateAtElapsed(250).transcript).toHaveLength(1);
  });

  it('never surfaces intermediate cards at any point in the timeline', () => {
    for (let t = 0; t <= TIMELINE_END_MS; t += 200) {
      expect(stateAtElapsed(t).cards).toHaveLength(0);
    }
  });

  it('reaches the full terminal scene: no intermediate cards, finished synthesis with sources', () => {
    const end = terminalState();
    // No intermediate raw cards — the demo goes straight to AI synthesis.
    expect(end.cards).toHaveLength(0);
    expect(end.synthesis?.streaming).toBe(false);
    expect(end.synthesis?.text).toBe(SYNTHESIS_TEXT);
    expect(end.synthesis?.citations).toEqual([1, 2, 3]);
    // Supporting sources still live inside the AI Summary.
    expect(end.synthesis?.sources).toHaveLength(3);
    // The terminal scene has the top source expanded (the click-to-expand beat).
    expect(end.synthesis?.expandedSourceId).toBe('pr-482');
  });

  it('reduced-motion end-state equals re-playing the whole timeline event-by-event', () => {
    let folded: DemoState = INITIAL_STATE;
    for (const entry of TIMELINE) folded = applyEvent(folded, entry.event);
    expect(terminalState()).toEqual(folded);
  });

  it('maps each scene to its caption step', () => {
    // Empty / transcript-only → transcribing.
    expect(stepFor(INITIAL_STATE)).toBe('transcribing');
    let s: DemoState = applyEvent(INITIAL_STATE, {
      kind: 'transcript',
      line: { id: 'a', speaker: 'P', text: 'q' },
    });
    expect(stepFor(s)).toBe('transcribing');
    // Synthesis started but no text yet → gathering context.
    s = applyEvent(s, { kind: 'synthesisStart' });
    expect(stepFor(s)).toBe('gathering');
    // Text streaming → synthesizing.
    s = applyEvent(s, { kind: 'synthesisDelta', delta: 'Answer' });
    expect(stepFor(s)).toBe('synthesizing');
    // Done but no source clicked yet → still synthesizing (answer presented).
    s = applyEvent(s, { kind: 'synthesisDone', citations: [1], sources: [] });
    expect(stepFor(s)).toBe('synthesizing');
    // A source is expanded → viewing the citation.
    s = applyEvent(s, { kind: 'expandSource', sourceId: 'pr-482' });
    expect(stepFor(s)).toBe('viewing');
  });

  it('loops cleanly — resetting to t=0 reproduces the first events on re-advance', () => {
    // Simulate a loop: play to the end, then reset (stateAtElapsed(0)) and
    // advance again. The reset is empty and the first step reproduces step one.
    expect(stateAtElapsed(Number.POSITIVE_INFINITY).synthesis?.streaming).toBe(false);
    expect(stateAtElapsed(0)).toEqual(INITIAL_STATE);
    expect(stateAtElapsed(300).transcript[0]?.id).toBe('t1');
  });
});
