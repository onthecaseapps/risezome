import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../src/skills/registry.js';
import {
  type Skill,
  formatAsSource,
  type SkillResult,
} from '../../src/skills/contract.js';

function makeSkill(name: string, description = 'desc'): Skill {
  return {
    source: 'github',
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { state: { type: 'string' } },
    },
    handler: () => Promise.resolve({ kind: 'count', summary: 'ok' }),
  };
}

describe('SkillRegistry', () => {
  it('registers two skills and lists them in insertion order', () => {
    const r = new SkillRegistry();
    r.register(makeSkill('github_count'));
    r.register(makeSkill('github_list'));
    expect(r.size()).toBe(2);
    expect(r.list().map((s) => s.name)).toEqual(['github_count', 'github_list']);
  });

  it('looks up a registered skill by name', () => {
    const r = new SkillRegistry();
    r.register(makeSkill('github_count'));
    expect(r.lookup('github_count')?.name).toBe('github_count');
  });

  it('returns undefined for unknown lookup', () => {
    const r = new SkillRegistry();
    expect(r.lookup('github.unknown')).toBeUndefined();
  });

  it('throws on duplicate skill name', () => {
    const r = new SkillRegistry();
    r.register(makeSkill('github_count'));
    expect(() => r.register(makeSkill('github_count'))).toThrow(/duplicate/);
  });

  it('toToolDefinitions emits exactly {name, description, input_schema} per skill', () => {
    const r = new SkillRegistry();
    r.register(makeSkill('github_count', 'count things'));
    const tools = r.toToolDefinitions();
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(Object.keys(tool).sort()).toEqual(['description', 'input_schema', 'name']);
    expect(tool.name).toBe('github_count');
    expect(tool.description).toBe('count things');
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: { state: { type: 'string' } },
    });
  });
});

describe('formatAsSource', () => {
  it('produces a SynthesisSource with rank:0 for a count result', () => {
    const result: SkillResult = { kind: 'count', summary: '7 open issues' };
    const src = formatAsSource(result, 'github_count', { state: 'open', type: 'issue' });
    expect(src.rank).toBe(0);
    expect(src.title).toBe('Tool: github_count({"state":"open","type":"issue"})');
    expect(src.text).toBe('7 open issues');
  });

  it('renders numbered items beneath the summary for a list result', () => {
    const result: SkillResult = {
      kind: 'list',
      summary: 'Top 3 open issues',
      items: [
        { title: 'U20: Per-meeting summary view', url: 'https://example/6' },
        { title: 'U16: Question detection', subtitle: 'Phase 2' },
        { title: 'U24: Surfacing telemetry' },
      ],
    };
    const src = formatAsSource(result, 'github_list', { state: 'open', limit: 3 });
    expect(src.rank).toBe(0);
    expect(src.text).toBe(
      [
        'Top 3 open issues',
        '',
        '#1: U20: Per-meeting summary view (https://example/6)',
        '#2: U16: Question detection — Phase 2',
        '#3: U24: Surfacing telemetry',
      ].join('\n'),
    );
  });

  it('omits the items block when items is empty or undefined', () => {
    const a = formatAsSource(
      { kind: 'count', summary: '0 matches' },
      'github_count',
      { state: 'open' },
    );
    expect(a.text).toBe('0 matches');
    const b = formatAsSource(
      { kind: 'list', summary: 'No matches', items: [] },
      'github_list',
      {},
    );
    expect(b.text).toBe('No matches');
  });
});
