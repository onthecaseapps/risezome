// Corpus filtering policy (U1).
//
// Controls what each source contributes to the knowledge corpus, so indexing
// captures source + docs and excludes noise (tests, fixtures, eval reports,
// lockfiles, build config; closed/stale connector items). The indexer captured
// everything by extension+size before this — ~25% of a real repo was test/eval
// files that diluted retrieval and produced citation-verified hallucinations.
//
// Two filter kinds:
//   - Repo files: gitignore-style path globs via the `ignore` package.
//   - Connector entities (Jira/Trello/Confluence): structured attribute rules
//     over already-fetched fields (status, list, updated-at).
//
// Pure module: types + the preset library + the resolver + the two matchers.
// Storage lives in org_corpus_policy + sources.corpus_policy; loading/resolving
// for the indexer is corpus-policy-store.ts.

import ignore from 'ignore';

export type PresetKey = 'recommended' | 'index_everything' | 'code_only';
export type ConnectorKind = 'jira' | 'trello' | 'confluence';

/** A connector attribute rule. A rule EXCLUDES an entity when it matches. */
export interface ConnectorRule {
  readonly source: ConnectorKind;
  readonly field: 'status' | 'issueType' | 'list' | 'updatedBefore';
  readonly op: 'in' | 'olderThanDays';
  /** string[] for `in`, a day count (number) for `olderThanDays`. */
  readonly value: readonly string[] | number;
}

/** Fetch-time connector options that aren't post-fetch filters. Today: whether
 *  the Trello indexer fetches completed/archived cards at all. */
export interface ConnectorOptions {
  readonly trello?: { readonly includeArchived?: boolean };
}

/** The stored policy shape (org_corpus_policy row, or sources.corpus_policy). */
export interface CorpusPolicy {
  readonly preset: PresetKey;
  readonly customExcludes?: readonly string[];
  /** Re-include patterns (gitignore negations); `!` prefix optional. */
  readonly customIncludes?: readonly string[];
  readonly connectorRules?: readonly ConnectorRule[];
  readonly connectorOptions?: ConnectorOptions;
  /** Allowlist (GitHub): when set, ONLY paths matching one of these globs are
   *  indexed (then path excludes still apply within them). Empty/absent = no
   *  allowlist (denylist behavior). */
  readonly customIncludeOnly?: readonly string[];
}

/** The resolved, ready-to-apply policy. */
export interface EffectiveCorpusPolicy {
  readonly pathExcludes: readonly string[];
  readonly pathIncludes: readonly string[];
  /** Allowlist globs; when non-empty a path must match one to be kept. */
  readonly pathIncludeOnly: readonly string[];
  readonly connectorRules: readonly ConnectorRule[];
  readonly connectorOptions: ConnectorOptions;
}

/** Normalized connector attributes the matchers read; each indexer maps its
 *  own entity shape into this. */
export interface EntityAttrs {
  readonly status?: string | null;
  readonly issueType?: string | null;
  readonly list?: string | null;
  readonly updatedAt?: string | null;
}

// ── Preset library ──────────────────────────────────────────────────────────

// Recommended default: an allowlist-of-intent — index source + docs, exclude
// the standard noise classes. package.json is intentionally KEPT (it answers
// real questions: dependencies, scripts); tool config and lockfiles are not.
const RECOMMENDED_PATH_EXCLUDES: readonly string[] = [
  // Tests + snapshots
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**', '**/specs/**',
  '**/*.test.*', '**/*.spec.*', '**/__snapshots__/**', '**/*.snap',
  // Fixtures + eval artifacts (the SQLite-hallucination source)
  '**/fixtures/**', '**/*.fixture.*', '**/eval/reports/**',
  // Lockfiles
  '**/*.lock', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock',
  '**/Cargo.lock', '**/poetry.lock', '**/Gemfile.lock', '**/composer.lock',
  // Generated / build output
  '**/dist/**', '**/build/**', '**/.next/**', '**/out/**', '**/coverage/**', '**/node_modules/**',
  // Tool config (keep package.json)
  '**/tsconfig*.json', '**/*.config.js', '**/*.config.ts', '**/*.config.mjs', '**/*.config.cjs',
  '**/.eslintrc*', '**/.prettierrc*', '**/vitest.config.*', '**/jest.config.*',
];

// Prose/doc extensions, for code_only.
const DOC_PATH_EXCLUDES: readonly string[] = [
  '**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', '**/*.adoc',
];

// Recommended connector rules: drop resolved/closed Jira issues (the clearest
// connector noise). Trello archived cards are already dropped at fetch, and
// Confluence exposes no archived flag today, so neither gets a default rule.
const RECOMMENDED_CONNECTOR_RULES: readonly ConnectorRule[] = [
  { source: 'jira', field: 'status', op: 'in', value: ['Done', 'Closed', 'Resolved', 'Cancelled', "Won't Do"] },
];

const PRESETS: Record<PresetKey, EffectiveCorpusPolicy> = {
  recommended: {
    pathExcludes: RECOMMENDED_PATH_EXCLUDES,
    pathIncludes: [],
    pathIncludeOnly: [],
    connectorRules: RECOMMENDED_CONNECTOR_RULES,
    connectorOptions: {},
  },
  index_everything: {
    pathExcludes: [],
    pathIncludes: [],
    pathIncludeOnly: [],
    connectorRules: [],
    connectorOptions: { trello: { includeArchived: true } },
  },
  code_only: {
    pathExcludes: [...RECOMMENDED_PATH_EXCLUDES, ...DOC_PATH_EXCLUDES],
    pathIncludes: [],
    pathIncludeOnly: [],
    connectorRules: RECOMMENDED_CONNECTOR_RULES,
    connectorOptions: {},
  },
};

export const PRESET_KEYS: readonly PresetKey[] = ['recommended', 'index_everything', 'code_only'];

function presetBase(key: string | undefined): EffectiveCorpusPolicy {
  return (key !== undefined && key in PRESETS ? PRESETS[key as PresetKey] : PRESETS.recommended);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the effective policy as an ordered merge: org default → per-source
 * override. The base preset is the override's preset if set, else the org
 * default's, else `recommended` (so an org with no row is safe by default).
 * Custom rules from org then override layer on top; includes (negations) are
 * appended last so they can re-open anything the excludes closed.
 */
export function resolveEffectivePolicy(
  orgDefault: CorpusPolicy | null | undefined,
  override: CorpusPolicy | null | undefined,
): EffectiveCorpusPolicy {
  const base = presetBase(override?.preset ?? orgDefault?.preset);
  return {
    pathExcludes: [
      ...base.pathExcludes,
      ...(orgDefault?.customExcludes ?? []),
      ...(override?.customExcludes ?? []),
    ],
    pathIncludes: [
      ...base.pathIncludes,
      ...(orgDefault?.customIncludes ?? []),
      ...(override?.customIncludes ?? []),
    ],
    pathIncludeOnly: [
      ...base.pathIncludeOnly,
      ...(orgDefault?.customIncludeOnly ?? []),
      ...(override?.customIncludeOnly ?? []),
    ],
    connectorRules: [
      ...base.connectorRules,
      ...(orgDefault?.connectorRules ?? []),
      ...(override?.connectorRules ?? []),
    ],
    // Options merge by key with override winning, then org, then preset base.
    connectorOptions: mergeConnectorOptions(
      base.connectorOptions,
      orgDefault?.connectorOptions,
      override?.connectorOptions,
    ),
  };
}

function mergeConnectorOptions(...layers: Array<ConnectorOptions | undefined>): ConnectorOptions {
  const out: { trello?: { includeArchived?: boolean } } = {};
  for (const layer of layers) {
    if (layer?.trello?.includeArchived !== undefined) {
      out.trello = { includeArchived: layer.trello.includeArchived };
    }
  }
  return out;
}

/** Whether the Trello indexer should fetch completed/archived cards. */
export function trelloIncludeArchived(policy: EffectiveCorpusPolicy): boolean {
  return policy.connectorOptions.trello?.includeArchived === true;
}

// ── Matchers ────────────────────────────────────────────────────────────────

/**
 * Build a keep-predicate for repo file paths. A path is kept iff (1) when an
 * allowlist (`pathIncludeOnly`) is set, the path matches it, AND (2) it is not
 * excluded (gitignore semantics: an exclude pattern matches and no later `!`
 * include re-opens it). The allowlist is a clean "only index these" set — it
 * does NOT use `!`-negation (which can't re-include under a broadly-excluded
 * parent), so monorepo scoping is reliable. Paths are repo-relative; empty
 * paths are never kept.
 */
export function makePathFilter(policy: EffectiveCorpusPolicy): (path: string) => boolean {
  const ig = ignore();
  ig.add([...policy.pathExcludes]);
  ig.add(policy.pathIncludes.map((p) => (p.startsWith('!') ? p : `!${p}`)));
  const allow = policy.pathIncludeOnly.length > 0 ? ignore().add([...policy.pathIncludeOnly]) : null;
  return (path: string): boolean => {
    if (path.length === 0) return false;
    if (allow !== null && !allow.ignores(path)) return false; // not in the allowlist
    return !ig.ignores(path);
  };
}

/**
 * Build a keep-predicate for connector entities of one kind. An entity is kept
 * unless some rule for that kind matches it. `now` is injectable for testing
 * age rules.
 */
export function makeEntityFilter(
  policy: EffectiveCorpusPolicy,
  kind: ConnectorKind,
  now: number = Date.now(),
): (attrs: EntityAttrs) => boolean {
  const rules = policy.connectorRules.filter((r) => r.source === kind);
  return (attrs: EntityAttrs): boolean => !rules.some((r) => ruleExcludes(r, attrs, now));
}

function ruleExcludes(rule: ConnectorRule, attrs: EntityAttrs, now: number): boolean {
  switch (rule.field) {
    case 'status':
      return attrs.status != null && asStrings(rule.value).includes(attrs.status);
    case 'issueType':
      return attrs.issueType != null && asStrings(rule.value).includes(attrs.issueType);
    case 'list':
      return attrs.list != null && asStrings(rule.value).includes(attrs.list);
    case 'updatedBefore': {
      if (attrs.updatedAt == null || typeof rule.value !== 'number') return false;
      const ts = Date.parse(attrs.updatedAt);
      if (Number.isNaN(ts)) return false;
      const ageDays = (now - ts) / (24 * 60 * 60 * 1000);
      return ageDays > rule.value;
    }
    default:
      return false;
  }
}

function asStrings(value: readonly string[] | number): readonly string[] {
  return Array.isArray(value) ? value : [];
}
