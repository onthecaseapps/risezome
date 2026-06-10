import { describe, expect, it } from 'vitest';
import { selectTargetsByPolicy } from '../../src/inngest/functions/index-repo';
import { resolveEffectivePolicy } from '../../src/inngest/lib/corpus-policy';

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
