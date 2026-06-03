import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { VoyageEmbedder } from '@risezome/engine/embed';
import {
  assembleKnowledgeGaps,
  buildGroups,
  resolveAskers,
  toVectorLiteral,
  parseVector,
  makeSectionNamer,
  type MissRow,
} from '../../src/inngest/lib/knowledge-gaps';

function vecAt(theta: number): number[] {
  return [Math.cos(theta), Math.sin(theta), 0, 0];
}

describe('resolveAskers', () => {
  it('maps utteranceId → speaker from transcript payloads, skipping blanks', () => {
    const map = resolveAskers([
      { payload: { utteranceId: 'u1', speaker: 'Nathan Case' } },
      { payload: { utteranceId: 'u2', speaker: '' } },
      { payload: { utteranceId: 'u3' } },
      { payload: null },
    ]);
    expect(map.get('u1')).toBe('Nathan Case');
    expect(map.has('u2')).toBe(false);
    expect(map.has('u3')).toBe(false);
  });
});

describe('buildGroups — AE1 intra-batch merge + asker resolution', () => {
  const askers = new Map([
    ['u1', 'Nathan Case'],
    ['u2', 'Marco Reyes'],
    ['u3', 'Dev Okafor'],
  ]);
  const misses: MissRow[] = [
    { miss_id: 1, utterance_id: 'u1', verbatim_question: 'is the oauth2 cutover done?', reason: 'no_hits' },
    { miss_id: 2, utterance_id: 'u2', verbatim_question: 'where are we on auth migration?', reason: 'refusal' },
    { miss_id: 3, utterance_id: 'u3', verbatim_question: 'how is hybrid search ranked?', reason: 'no_hits' },
  ];

  it('collapses two near-equivalent misses into one group, keeps the distinct one separate', () => {
    const embeddings = [vecAt(0), vecAt(0.1), vecAt(Math.PI / 2)];
    const groups = buildGroups(misses, embeddings, askers);
    expect(groups).toHaveLength(2);
    const merged = groups.find((g) => g.occurrences.length === 2)!;
    expect(merged.occurrences.map((o) => o.asker_name).sort()).toEqual(['Marco Reyes', 'Nathan Case']);
    expect(merged.title).toBe('is the oauth2 cutover done?'); // first phrasing
  });

  it('falls back to Unknown when an asker is unresolved', () => {
    const groups = buildGroups(
      [{ miss_id: 9, utterance_id: 'ux', verbatim_question: 'q', reason: 'no_hits' }],
      [vecAt(0)],
      askers,
    );
    expect(groups[0]!.occurrences[0]!.asker_name).toBe('Unknown');
  });
});

describe('vector literal round-trip', () => {
  it('serializes and parses pgvector literals', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    expect(parseVector('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
    expect(parseVector([1, 2])).toEqual([1, 2]);
    expect(parseVector('garbage')).toEqual([]);
  });
});

// ── Orchestration with a compact mock ────────────────────────────────────────

interface MockConfig {
  misses: MissRow[];
  events?: { payload: Record<string, unknown> | null }[];
  participants?: { user_id: string }[];
  gaps?: Array<{ gap_id: string; section_id: string | null; embedding: unknown; title: string; section_pinned: boolean }>;
  rpcResult?: { gap_id: string; created: boolean; resurfaced: boolean; assignee_id: string | null };
}

function makeMock(cfg: MockConfig) {
  const calls = {
    rpc: [] as unknown[],
    processedMarked: false,
    notifications: [] as unknown[],
    sectionInserts: [] as unknown[],
    gapSectionUpdates: [] as { gapId: string; payload: unknown }[],
  };
  const dataByTable: Record<string, unknown[]> = {
    meeting_gap_misses: cfg.misses,
    meeting_events: cfg.events ?? [],
    meeting_participants: cfg.participants ?? [],
    knowledge_gaps: cfg.gaps ?? [],
    knowledge_gap_sections: [],
    notifications: [],
  };

  function builder(table: string) {
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let payload: unknown = null;
    const eqs: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.update = (p: unknown) => {
      op = 'update';
      payload = p;
      return b;
    };
    b.insert = (p: unknown) => {
      op = 'insert';
      payload = p;
      if (table === 'notifications') calls.notifications.push(p);
      if (table === 'knowledge_gap_sections') calls.sectionInserts.push(p);
      return b;
    };
    b.delete = () => {
      op = 'delete';
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      eqs[col] = val;
      return b;
    };
    b.is = () => b;
    b.in = () => b;
    b.then = (resolve: (v: unknown) => unknown) => {
      if (op === 'select') return resolve({ data: dataByTable[table] ?? [], error: null });
      if (op === 'update' && table === 'meeting_gap_misses') calls.processedMarked = true;
      if (op === 'update' && table === 'knowledge_gaps' && 'gap_id' in eqs) {
        calls.gapSectionUpdates.push({ gapId: eqs['gap_id'] as string, payload });
      }
      return resolve({ error: null });
    };
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, params: unknown) => {
      calls.rpc.push({ name, params });
      return { data: [cfg.rpcResult ?? { gap_id: 'gap_x', created: true, resurfaced: false, assignee_id: null }], error: null };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

/** Pad a low-dim test vector to the production 1024 dims (zeros preserve cosine). */
function pad1024(v: number[]): number[] {
  const out = new Array<number>(1024).fill(0);
  for (let i = 0; i < v.length && i < 1024; i++) out[i] = v[i]!;
  return out;
}

function fakeEmbedder(vectors: number[][]): VoyageEmbedder {
  return {
    embed: async () => ({ vectors: vectors.map((v) => ({ vector: Float32Array.from(pad1024(v)) })) }),
  } as unknown as VoyageEmbedder;
}

const namer = async (): Promise<string> => 'Auth & Identity';

describe('assembleKnowledgeGaps — orchestration', () => {
  it('empty meeting: no misses → no RPC, no processed marker', async () => {
    const { client, calls } = makeMock({ misses: [] });
    const result = await assembleKnowledgeGaps({
      service: client,
      embedder: fakeEmbedder([]),
      sectionNamer: namer,
      meetingId: 'm1',
      orgId: 'o1',
    });
    expect(result).toEqual({ misses: 0, groups: 0, created: 0, resurfaced: 0 });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.processedMarked).toBe(false);
  });

  it('AE1: two similar misses → one RPC group call; misses marked processed last', async () => {
    const misses: MissRow[] = [
      { miss_id: 1, utterance_id: 'u1', verbatim_question: 'oauth cutover done?', reason: 'no_hits' },
      { miss_id: 2, utterance_id: 'u2', verbatim_question: 'auth migration status?', reason: 'refusal' },
    ];
    const { client, calls } = makeMock({
      misses,
      events: [
        { payload: { utteranceId: 'u1', speaker: 'Nathan' } },
        { payload: { utteranceId: 'u2', speaker: 'Marco' } },
      ],
      participants: [{ user_id: 'user-a' }],
      rpcResult: { gap_id: 'gap_1', created: true, resurfaced: false, assignee_id: null },
    });
    const result = await assembleKnowledgeGaps({
      service: client,
      embedder: fakeEmbedder([vecAt(0), vecAt(0.1)]),
      sectionNamer: namer,
      meetingId: 'm1',
      orgId: 'o1',
    });
    expect(result.misses).toBe(2);
    expect(result.groups).toBe(1);
    expect(calls.rpc).toHaveLength(1);
    const params = (calls.rpc[0] as { params: { p_occurrences: unknown[]; p_viewer_ids: string[] } }).params;
    expect(params.p_occurrences).toHaveLength(2);
    expect(params.p_viewer_ids).toEqual(['user-a']);
    expect(calls.processedMarked).toBe(true);
  });

  it('resurfaced gap with an assignee creates a notification (R16/AE4)', async () => {
    const { client, calls } = makeMock({
      misses: [{ miss_id: 1, utterance_id: 'u1', verbatim_question: 'sso support?', reason: 'no_hits' }],
      events: [{ payload: { utteranceId: 'u1', speaker: 'Priya' } }],
      rpcResult: { gap_id: 'gap_1', created: false, resurfaced: true, assignee_id: 'owner-1' },
    });
    const result = await assembleKnowledgeGaps({
      service: client,
      embedder: fakeEmbedder([vecAt(0)]),
      sectionNamer: namer,
      meetingId: 'm1',
      orgId: 'o1',
    });
    expect(result.resurfaced).toBe(1);
    expect(calls.notifications).toHaveLength(1);
    expect((calls.notifications[0] as { type: string; user_id: string }).type).toBe('gap_resurfaced');
    expect((calls.notifications[0] as { user_id: string }).user_id).toBe('owner-1');
  });

  it('AE3: re-clustering never re-places a section_pinned gap', async () => {
    // The run touches g-pinned (rpcResult.gap_id), which is pinned + uncategorized.
    // reclusterSections must skip it → no section_id update is issued.
    const { client, calls } = makeMock({
      misses: [{ miss_id: 1, utterance_id: 'u1', verbatim_question: 'q', reason: 'no_hits' }],
      events: [{ payload: { utteranceId: 'u1', speaker: 'X' } }],
      rpcResult: { gap_id: 'g-pinned', created: false, resurfaced: false, assignee_id: null },
      gaps: [
        // an existing categorized gap gives section 'sec-auth' a centroid
        { gap_id: 'g-existing', section_id: 'sec-auth', embedding: '[1,0,0,0]', title: 't', section_pinned: false },
        // the touched gap is pinned → must NOT be re-placed despite matching sec-auth
        { gap_id: 'g-pinned', section_id: null, embedding: '[0.99,0.01,0,0]', title: 't2', section_pinned: true },
      ],
    });
    await assembleKnowledgeGaps({
      service: client,
      embedder: fakeEmbedder([vecAt(0)]),
      sectionNamer: namer,
      meetingId: 'm1',
      orgId: 'o1',
    });
    expect(calls.gapSectionUpdates.find((u) => u.gapId === 'g-pinned')).toBeUndefined();
  });

  it('places a touched, unpinned, uncategorized gap into the nearest existing section', async () => {
    const { client, calls } = makeMock({
      misses: [{ miss_id: 1, utterance_id: 'u1', verbatim_question: 'q', reason: 'no_hits' }],
      events: [{ payload: { utteranceId: 'u1', speaker: 'X' } }],
      rpcResult: { gap_id: 'g-new', created: true, resurfaced: false, assignee_id: null },
      gaps: [
        { gap_id: 'g-existing', section_id: 'sec-auth', embedding: '[1,0,0,0]', title: 't', section_pinned: false },
        { gap_id: 'g-new', section_id: null, embedding: '[0.99,0.01,0,0]', title: 't2', section_pinned: false },
      ],
    });
    await assembleKnowledgeGaps({
      service: client,
      embedder: fakeEmbedder([vecAt(0)]),
      sectionNamer: namer,
      meetingId: 'm1',
      orgId: 'o1',
    });
    const placed = calls.gapSectionUpdates.find((u) => u.gapId === 'g-new');
    expect(placed).toBeDefined();
    expect((placed!.payload as { section_id: string }).section_id).toBe('sec-auth');
  });
});

describe('makeSectionNamer', () => {
  const ok = (text: string): typeof fetch =>
    (async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) })) as unknown as typeof fetch;

  it('returns the trimmed model name on success', async () => {
    const name = await makeSectionNamer('k', ok('  Auth & Identity  '))(['q1', 'q2']);
    expect(name).toBe('Auth & Identity');
  });

  it('falls back to "New section" on a non-ok response', async () => {
    const fetchImpl = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await makeSectionNamer('k', fetchImpl)(['q'])).toBe('New section');
  });

  it('falls back to "New section" when the request throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    expect(await makeSectionNamer('k', fetchImpl)(['q'])).toBe('New section');
  });

  it('falls back to "New section" on empty model text', async () => {
    expect(await makeSectionNamer('k', ok('   '))(['q'])).toBe('New section');
  });
});
