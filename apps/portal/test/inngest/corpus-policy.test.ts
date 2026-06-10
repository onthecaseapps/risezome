import { describe, expect, it } from 'vitest';
import {
  resolveEffectivePolicy,
  makePathFilter,
  makeEntityFilter,
  PRESET_KEYS,
  type CorpusPolicy,
  type EntityAttrs,
} from '../../src/inngest/lib/corpus-policy';

describe('resolveEffectivePolicy', () => {
  it('defaults to recommended when there is no org row and no override', () => {
    const eff = resolveEffectivePolicy(null, null);
    expect(eff.pathExcludes.length).toBeGreaterThan(0);
    expect(eff.connectorRules.some((r) => r.source === 'jira')).toBe(true);
  });

  it('override preset replaces the base (index_everything neutralizes excludes)', () => {
    const org: CorpusPolicy = { preset: 'recommended' };
    const override: CorpusPolicy = { preset: 'index_everything' };
    const eff = resolveEffectivePolicy(org, override);
    expect(eff.pathExcludes).toEqual([]);
    expect(eff.connectorRules).toEqual([]);
  });

  it('layers org and override custom rules on top of the preset base', () => {
    const org: CorpusPolicy = { preset: 'recommended', customExcludes: ['docs/private/**'] };
    const override: CorpusPolicy = { preset: 'recommended', customExcludes: ['vendor/**'] };
    const eff = resolveEffectivePolicy(org, override);
    expect(eff.pathExcludes).toContain('docs/private/**');
    expect(eff.pathExcludes).toContain('vendor/**');
    expect(eff.pathExcludes).toContain('**/test/**'); // preset base preserved
  });

  it('unknown preset key falls back to recommended (defensive)', () => {
    const eff = resolveEffectivePolicy({ preset: 'bogus' as never }, null);
    expect(eff.pathExcludes).toContain('**/eval/reports/**');
  });
});

describe('makePathFilter (recommended)', () => {
  const keep = makePathFilter(resolveEffectivePolicy(null, null));

  it('excludes test files, fixtures, eval reports, lockfiles, tool config', () => {
    expect(keep('apps/x/test/foo.test.ts')).toBe(false);
    expect(keep('apps/x/foo.spec.ts')).toBe(false);
    expect(keep('apps/bot-worker/eval/reports/phase-3.json')).toBe(false);
    expect(keep('pnpm-lock.yaml')).toBe(false);
    expect(keep('apps/portal/tsconfig.json')).toBe(false);
    expect(keep('next.config.js')).toBe(false);
    expect(keep('packages/x/__snapshots__/a.snap')).toBe(false);
  });

  it('keeps real source and docs, including package.json', () => {
    expect(keep('packages/engine/src/embed/voyage.ts')).toBe(true);
    expect(keep('README.md')).toBe(true);
    expect(keep('apps/portal/package.json')).toBe(true);
    expect(keep('docs/architecture.md')).toBe(true);
  });

  it('never keeps an empty path', () => {
    expect(keep('')).toBe(false);
  });

  it('include override (!) re-opens a path the preset excluded', () => {
    const policy = resolveEffectivePolicy(null, {
      preset: 'recommended',
      customIncludes: ['eval/reports/keep-me.json'],
    });
    const keepWith = makePathFilter(policy);
    expect(keepWith('eval/reports/keep-me.json')).toBe(true);
    expect(keepWith('eval/reports/other.json')).toBe(false);
  });
});

describe('makePathFilter (code_only / index_everything)', () => {
  it('code_only excludes docs in addition to noise', () => {
    const keep = makePathFilter(resolveEffectivePolicy(null, { preset: 'code_only' }));
    expect(keep('README.md')).toBe(false);
    expect(keep('src/main.ts')).toBe(true);
  });

  it('index_everything keeps everything', () => {
    const keep = makePathFilter(resolveEffectivePolicy(null, { preset: 'index_everything' }));
    expect(keep('apps/x/test/foo.test.ts')).toBe(true);
    expect(keep('pnpm-lock.yaml')).toBe(true);
  });
});

describe('makeEntityFilter', () => {
  const NOW = Date.parse('2026-06-10T00:00:00Z');
  const eff = resolveEffectivePolicy(null, null); // recommended

  it('jira: drops Done/Closed, keeps active', () => {
    const keep = makeEntityFilter(eff, 'jira', NOW);
    expect(keep({ status: 'Done' })).toBe(false);
    expect(keep({ status: 'Closed' })).toBe(false);
    expect(keep({ status: 'In Progress' })).toBe(true);
    expect(keep({ status: null })).toBe(true);
  });

  it('trello/confluence have no default recommended rule (all kept)', () => {
    const keepT = makeEntityFilter(eff, 'trello', NOW);
    const keepC = makeEntityFilter(eff, 'confluence', NOW);
    expect(keepT({ list: 'Done' })).toBe(true);
    expect(keepC({ updatedAt: '2020-01-01T00:00:00Z' })).toBe(true);
  });

  it('applies a custom list rule (trello) and age rule (confluence)', () => {
    const policy = resolveEffectivePolicy(null, {
      preset: 'recommended',
      connectorRules: [
        { source: 'trello', field: 'list', op: 'in', value: ['Archive', 'Done'] },
        { source: 'confluence', field: 'updatedBefore', op: 'olderThanDays', value: 365 },
      ],
    });
    const keepT = makeEntityFilter(policy, 'trello', NOW);
    expect(keepT({ list: 'Archive' })).toBe(false);
    expect(keepT({ list: 'Backlog' })).toBe(true);

    const keepC = makeEntityFilter(policy, 'confluence', NOW);
    expect(keepC({ updatedAt: '2020-01-01T00:00:00Z' })).toBe(false); // >365d old
    expect(keepC({ updatedAt: '2026-06-01T00:00:00Z' })).toBe(true); // recent
    expect(keepC({ updatedAt: null })).toBe(true); // unknown age → keep
  });
});

describe('PRESET_KEYS', () => {
  it('matches the resolvable presets (kept in sync with the migration CHECK)', () => {
    for (const k of PRESET_KEYS) {
      const eff = resolveEffectivePolicy(null, { preset: k });
      expect(eff).toBeDefined();
    }
    expect([...PRESET_KEYS].sort()).toEqual(['code_only', 'index_everything', 'recommended']);
  });
});

// Type-only guard so EntityAttrs stays exported/used.
const _attrs: EntityAttrs = { status: 'x' };
void _attrs;
