import { describe, it, expect } from 'vitest';
import { computeSchedule, scheduleDurationMs, DEFAULT_CADENCE } from '../../app/(authed)/debug/live-mic/_replay-driver';
import type { ReplayUtterance } from '../../app/(authed)/debug/live-mic/_replay-source';

function u(startMs: number, id = `u${String(startMs)}`): ReplayUtterance {
  return { utteranceId: id, text: `t${String(startMs)}`, speaker: null, startMs };
}

describe('computeSchedule (U3 cadence)', () => {
  it('first utterance fires at 0; short gaps are preserved exactly at speed 1', () => {
    const s = computeSchedule([u(1000), u(3000), u(8000)], { maxGapMs: 60_000, speed: 1 });
    expect(s.map((x) => x.offsetMs)).toEqual([0, 2000, 7000]); // gaps 2000, 5000
  });

  it('clamps long idle gaps to maxGapMs', () => {
    const s = computeSchedule([u(0), u(240_000)], { maxGapMs: 5000, speed: 1 });
    expect(s.map((x) => x.offsetMs)).toEqual([0, 5000]); // 4-min gap capped to 5s
  });

  it('divides every gap by the speed multiplier', () => {
    const s = computeSchedule([u(0), u(2000), u(6000)], { maxGapMs: 60_000, speed: 2 });
    expect(s.map((x) => x.offsetMs)).toEqual([0, 1000, 3000]); // (2000/2)=1000, +(4000/2)=2000
  });

  it('combines cap + speed', () => {
    const s = computeSchedule([u(0), u(100_000), u(101_000)], DEFAULT_CADENCE); // cap 5000, speed 4
    expect(s.map((x) => x.offsetMs)).toEqual([0, 1250, 1500]); // min(100k,5k)/4=1250; min(1k,5k)/4=250
  });

  it('clamps negative gaps to 0 (unordered defensive)', () => {
    const s = computeSchedule([u(5000), u(1000)], { maxGapMs: 60_000, speed: 1 });
    expect(s.map((x) => x.offsetMs)).toEqual([0, 0]);
  });

  it('treats non-positive speed as a tiny floor (no divide-by-zero / no negative)', () => {
    const s = computeSchedule([u(0), u(1000)], { maxGapMs: 60_000, speed: 0 });
    expect(s[1]!.offsetMs).toBeGreaterThan(0);
    expect(Number.isFinite(s[1]!.offsetMs)).toBe(true);
  });

  it('single + empty inputs', () => {
    expect(computeSchedule([u(1234)], DEFAULT_CADENCE)).toEqual([{ utterance: u(1234), offsetMs: 0 }]);
    expect(computeSchedule([], DEFAULT_CADENCE)).toEqual([]);
  });

  it('scheduleDurationMs returns the last offset (0 for empty)', () => {
    expect(scheduleDurationMs(computeSchedule([u(0), u(2000)], { maxGapMs: 60_000, speed: 1 }))).toBe(2000);
    expect(scheduleDurationMs([])).toBe(0);
  });
});
