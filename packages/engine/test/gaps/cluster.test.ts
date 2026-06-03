import { describe, expect, it } from 'vitest';
import {
  assignSections,
  proposeSections,
  SECTION_ASSIGN_MAX_DISTANCE,
  type GapToPlace,
  type SectionRef,
} from '../../src/gaps/cluster.js';

function vecAt(theta: number): number[] {
  return [Math.cos(theta), Math.sin(theta), 0, 0];
}
function gap(gapId: string, theta: number, title = gapId): GapToPlace {
  return { gapId, vector: vecAt(theta), title };
}

describe('assignSections — R9 placement', () => {
  const sections: SectionRef[] = [
    { sectionId: 'auth', centroid: vecAt(0) },
    { sectionId: 'rag', centroid: vecAt(Math.PI / 2) },
  ];

  it('places a gap into the nearest section within threshold', () => {
    const placements = assignSections([gap('g1', 0.2)], sections);
    expect(placements[0]).toEqual({ gapId: 'g1', sectionId: 'auth' });
  });

  it('leaves a gap that fits no section in Uncategorized (sectionId null)', () => {
    // halfway between the two sections (45°): distance to each is 1-cos(45°)=0.29
    // which is < 0.45, so it WOULD join the nearer. Use a 3rd-axis vector instead.
    const placements = assignSections([{ gapId: 'lonely', vector: [0, 0, 1, 0], title: 'x' }], sections);
    expect(placements[0]).toEqual({ gapId: 'lonely', sectionId: null });
  });

  it('does not mutate or rename sections (returns placements only)', () => {
    const before = JSON.stringify(sections);
    assignSections([gap('g1', 0.1)], sections);
    expect(JSON.stringify(sections)).toBe(before);
  });
});

describe('proposeSections — R7 auto-grouping (AE3-safe)', () => {
  it('proposes one named section per cluster of 2+, naming via the injected namer', async () => {
    const namer = async (qs: readonly string[]): Promise<string> =>
      `Section of ${String(qs.length)}`;
    const proposed = await proposeSections(
      [gap('a', 0, 'oauth status'), gap('b', 0.1, 'auth migration'), gap('z', Math.PI / 2, 'rag ranking')],
      namer,
    );
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.gapIds).toEqual(['a', 'b']);
    expect(proposed[0]!.name).toBe('Section of 2');
  });

  it('a lone uncategorized gap does not spawn a section', async () => {
    const namer = async (): Promise<string> => 'Nope';
    const proposed = await proposeSections([gap('solo', 0)], namer);
    expect(proposed).toHaveLength(0);
  });

  it('exposes a sane default section threshold', () => {
    expect(SECTION_ASSIGN_MAX_DISTANCE).toBeGreaterThan(0.22);
    expect(SECTION_ASSIGN_MAX_DISTANCE).toBeLessThanOrEqual(0.5);
  });
});
