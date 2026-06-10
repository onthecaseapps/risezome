import { describe, it, expect } from 'vitest';
import { groupEventsByDay } from '../app/(authed)/upcoming/_day-groups';

const LA = 'America/Los_Angeles';

function ev(startAtIso: string): { start_at: string } {
  return { start_at: startAtIso };
}

describe('groupEventsByDay (F3 — viewer-zone day grouping)', () => {
  it('groups by the VIEWER zone day, not UTC: a PST 6 PM meeting is Today, not Tomorrow', () => {
    // 2026-06-10T01:00Z is 6 PM on Jun 9 in Los Angeles.
    const now = new Date('2026-06-09T20:00:00Z'); // Jun 9, 1 PM in LA
    const groups = groupEventsByDay([ev('2026-06-10T01:00:00.000Z')], LA, now);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.dayKey).toBe('2026-06-09');
    expect(groups[0]?.day).toBe('Today');
  });

  it('splits events into per-day buckets, preserving the sorted order', () => {
    const now = new Date('2026-06-09T20:00:00Z');
    const groups = groupEventsByDay(
      [
        ev('2026-06-09T22:00:00.000Z'), // Jun 9 LA → Today
        ev('2026-06-10T18:00:00.000Z'), // Jun 10 LA → Tomorrow
        ev('2026-06-10T20:00:00.000Z'),
        ev('2026-06-12T18:00:00.000Z'), // Jun 12 LA → weekday label
      ],
      LA,
      now,
    );
    expect(groups.map((g) => [g.day, g.events.length])).toEqual([
      ['Today', 1],
      ['Tomorrow', 2],
      // Jun 12 2026 is a Friday.
      [new Date(Date.UTC(2026, 5, 12, 12)).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }), 1],
    ]);
  });

  it('labels Tomorrow correctly across a spring-forward DST boundary (calendar math, not +24h)', () => {
    // Mar 8 2026 is the US spring-forward. now = Mar 7, 11:30 PM PST; the old
    // Date.now()+24h trick lands on Mar 9 00:30 PDT and mislabels Mar 8.
    const now = new Date('2026-03-08T07:30:00Z'); // Mar 7, 11:30 PM in LA
    const groups = groupEventsByDay([ev('2026-03-08T20:00:00.000Z')], LA, now); // Mar 8, noon PDT
    expect(groups[0]?.dayKey).toBe('2026-03-08');
    expect(groups[0]?.day).toBe('Tomorrow');
  });

  it('rolls Tomorrow over month and year boundaries', () => {
    const eom = groupEventsByDay([ev('2026-07-01T18:00:00.000Z')], LA, new Date('2026-06-30T20:00:00Z'));
    expect(eom[0]?.day).toBe('Tomorrow');
    const eoy = groupEventsByDay([ev('2027-01-01T18:00:00.000Z')], LA, new Date('2026-12-31T20:00:00Z'));
    expect(eoy[0]?.day).toBe('Tomorrow');
  });
});
