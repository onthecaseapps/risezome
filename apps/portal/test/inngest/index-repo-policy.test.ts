import { describe, expect, it } from 'vitest';
import { selectTargetsByPolicy, selectTargetsByVisibility } from '../../src/inngest/functions/index-repo';
import { resolveEffectivePolicy, makePathVisibility, type TeamView } from '../../src/inngest/lib/corpus-policy';

const blobs = (...paths: string[]) => paths.map((path) => ({ path, sha: 'x' }));

describe('selectTargetsByPolicy (U4)', () => {
  it('keeps real source, excludes policy-matched files, counts only policy drops', () => {
    const policy = resolveEffectivePolicy(null, null); // recommended
    const { targets, excludedByPolicy } = selectTargetsByPolicy(
      blobs(
        'src/a.ts',
        'test/a.test.ts',
        'apps/bot-worker/eval/reports/phase-3.json',
        'README.md',
        'pnpm-lock.yaml',
      ),
      policy,
    );
    expect(targets.map((t) => t.path).sort()).toEqual(['README.md', 'src/a.ts']);
    expect(excludedByPolicy).toBe(3);
  });

  it('index_everything excludes nothing', () => {
    const policy = resolveEffectivePolicy(null, { preset: 'index_everything' });
    const { targets, excludedByPolicy } = selectTargetsByPolicy(
      blobs('src/a.ts', 'test/a.test.ts', 'pnpm-lock.yaml'),
      policy,
    );
    expect(targets).toHaveLength(3);
    expect(excludedByPolicy).toBe(0);
  });

  it('a now-excluded path is absent from targets (so reconcile prunes it — R5)', () => {
    const policy = resolveEffectivePolicy(null, null);
    const { targets } = selectTargetsByPolicy(blobs('apps/x/test/old.test.ts'), policy);
    expect(targets.find((t) => t.path === 'apps/x/test/old.test.ts')).toBeUndefined();
  });
});

describe('selectTargetsByVisibility (query-time union, U3)', () => {
  // Team A = code-only (drops prose), Team B = everything.
  const views: TeamView[] = [
    { teamId: 'A', policy: resolveEffectivePolicy(null, { preset: 'code_only' }) },
    { teamId: 'B', policy: resolveEffectivePolicy(null, { preset: 'index_everything' }) },
  ];
  const pathVis = makePathVisibility(views);

  it('keeps a file admitted by ANY team (union); drops files no team wants', () => {
    const { targets, excludedByPolicy } = selectTargetsByVisibility(
      blobs('src/index.ts', 'docs/readme.md', 'app/foo.test.ts'),
      pathVis,
    );
    // code → both; prose → B keeps it (everything); test → B keeps it too.
    expect(targets.map((t) => t.path).sort()).toEqual(['app/foo.test.ts', 'docs/readme.md', 'src/index.ts']);
    expect(excludedByPolicy).toBe(0);

    // code-only (drops prose) + recommended (keeps prose, drops tests): the
    // union keeps prose (recommended wants it); only the test file — excluded
    // by BOTH — drops.
    const mixed = makePathVisibility([
      { teamId: 'A', policy: resolveEffectivePolicy(null, { preset: 'code_only' }) },
      { teamId: 'C', policy: resolveEffectivePolicy(null, { preset: 'recommended' }) },
    ]);
    const r2 = selectTargetsByVisibility(blobs('src/index.ts', 'docs/readme.md', 'app/foo.test.ts'), mixed);
    expect(r2.targets.map((t) => t.path).sort()).toEqual(['docs/readme.md', 'src/index.ts']);
    expect(r2.excludedByPolicy).toBe(1); // only the test file (dropped by both)
  });
});
