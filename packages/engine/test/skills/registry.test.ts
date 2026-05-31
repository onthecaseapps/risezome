import { describe, expect, it } from 'vitest';
import { SkillRegistry } from '../../src/skills/registry.js';
import type { Skill, SkillResult } from '../../src/skills/contract.js';

function makeSkill(name: string, overrides: Partial<Skill> = {}): Skill {
  const baseSchema = {
    type: 'object' as const,
    properties: {},
  };
  return {
    source: 'test',
    name,
    description: `Test skill ${name}.`,
    inputSchema: baseSchema,
    handler: async (): Promise<SkillResult> => ({ kind: 'count', summary: 'ok' }),
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  it('registers and looks up skills by name', () => {
    const r = new SkillRegistry();
    const a = makeSkill('a');
    r.register(a);
    expect(r.lookup('a')).toBe(a);
    expect(r.lookup('b')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const r = new SkillRegistry();
    r.register(makeSkill('a'));
    expect(() => r.register(makeSkill('a'))).toThrow(/duplicate skill name 'a'/);
  });

  it('preserves insertion order in list()', () => {
    const r = new SkillRegistry();
    r.register(makeSkill('z'));
    r.register(makeSkill('a'));
    r.register(makeSkill('m'));
    expect(r.list().map((s) => s.name)).toEqual(['z', 'a', 'm']);
  });

  it('toToolDefinitions emits only {name, description, input_schema}', () => {
    const r = new SkillRegistry();
    r.register(
      makeSkill('a', {
        description: 'A description.',
        inputSchema: {
          type: 'object',
          properties: { state: { type: 'string', description: 'open/closed' } },
        },
      }),
    );
    const defs = r.toToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({
      name: 'a',
      description: 'A description.',
      input_schema: {
        type: 'object',
        properties: { state: { type: 'string', description: 'open/closed' } },
      },
    });
    // No leak of source/handler.
    const obj = defs[0] as unknown as Record<string, unknown>;
    expect(obj['source']).toBeUndefined();
    expect(obj['handler']).toBeUndefined();
  });

  it('size() reflects the number of registered skills', () => {
    const r = new SkillRegistry();
    expect(r.size()).toBe(0);
    r.register(makeSkill('a'));
    expect(r.size()).toBe(1);
    r.register(makeSkill('b'));
    expect(r.size()).toBe(2);
  });
});
