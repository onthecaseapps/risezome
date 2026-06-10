// Heuristic structure-aware boundaries for code chunking.
//
// This is the no-dependency intermediate step toward AST-aware chunking:
// instead of cutting code on fixed line windows, we find the *seams*
// between top-level declarations (functions, classes, types) using
// per-language regexes plus a universal indentation/blank-line fallback,
// then let the caller bin-pack those units into budgeted chunks. It
// captures most of the benefit of tree-sitter (chunks aligned to whole
// declarations) without shipping WASM grammars.
//
// Guarantees the caller relies on:
//   - Returns sorted, unique start-line indices, always including 0.
//   - Never throws on adversarial input; an unknown dialect yields null
//     so the caller falls back to plain line windowing.
//   - Top-level only: nested methods inside a large class stay in one
//     unit and get line-split downstream if they bust the budget. That's
//     a deliberate v1 simplification — whole-class chunks are still a big
//     improvement over arbitrary 120-line windows.

/** A family of languages that share declaration syntax for our purposes. */
export type Dialect =
  | 'ts' // TypeScript / JavaScript
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'jvm' // Java / Kotlin / Scala
  | 'csharp'
  | 'cfamily' // C / C++ / Objective-C
  | 'php'
  | 'swift';

const EXT_TO_DIALECT: Record<string, Dialect> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm',
  cs: 'csharp',
  c: 'cfamily', cc: 'cfamily', cpp: 'cfamily', cxx: 'cfamily',
  h: 'cfamily', hh: 'cfamily', hpp: 'cfamily', m: 'cfamily', mm: 'cfamily',
  php: 'php',
  swift: 'swift',
};

/** Map a file extension (lowercase, no dot) to a dialect, or null if we
 * have no structural heuristics for it (caller uses line windowing). */
export function dialectForExt(ext: string): Dialect | null {
  return EXT_TO_DIALECT[ext] ?? null;
}

// Declaration-start patterns, matched against a column-0 line. These make
// boundary detection precise (so an ordinary statement isn't mistaken for
// a new declaration); anything they miss is still caught by the universal
// blank-line fallback below, so imperfect patterns degrade gracefully.
const DECL: Record<Dialect, RegExp> = {
  ts: /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\b|function\*|class\b|interface\b|enum\b|namespace\b|module\b|type\s+\w+\s*[=<]|const\b|let\b|var\b)|^@[A-Za-z_]/,
  python: /^(async\s+def|def|class)\b|^@[A-Za-z_]/,
  ruby: /^(def|class|module)\b/,
  go: /^(func|type|var|const)\b/,
  rust: /^(pub(\([^)]*\))?\s+)?(default\s+)?(unsafe\s+)?(async\s+)?(extern\s+)?(fn|struct|enum|trait|impl|mod|const|static|type|union|macro_rules!)\b|^#\[/,
  jvm: /^(public|private|protected|internal|open|final|sealed|abstract|static|override|tailrec|class|interface|enum|object|trait|fun|def|val|var|void|record)\b|^@[A-Za-z_]/,
  csharp: /^(public|private|protected|internal|static|abstract|sealed|partial|virtual|override|async|class|interface|enum|struct|namespace|record|delegate|void)\b|^\[[A-Za-z_]/,
  cfamily: /^(template|class|struct|enum|union|namespace|typedef|using|static|inline|extern|const|virtual|void|public:|private:|protected:|@interface|@implementation|@end)\b|^#\s*(define|include|pragma|ifdef|ifndef|if|endif)\b|^[A-Za-z_][\w:<>,\s*&]*\s+[*&]?[A-Za-z_]\w*\s*\(/,
  php: /^(<\?php|function|class|interface|trait|namespace|abstract|final|public|private|protected|static)\b/,
  swift: /^(public|private|internal|fileprivate|open|final|static|class|struct|enum|protocol|extension|func|var|let|init|deinit|subscript|typealias)\b|^@[A-Za-z_]/,
};

// Lines that can never *start* a declaration: pure closers / continuations.
// Used to reject false boundaries (a dangling `}` or `).then(` at col 0).
const CLOSER = /^[)\]}>;,.?:]|^(\}|\)|\]|end\b|else\b|catch\b|finally\b|elif\b|except\b|&&|\|\||\?\.|\.\w)/;

/** True if a column-0 line is a comment for this dialect. `#` is only a
 * comment in python/ruby (it's a preprocessor/attribute sigil elsewhere). */
function isComment(line: string, dialect: Dialect): boolean {
  if (
    line.startsWith('//') ||
    line.startsWith('/*') ||
    line.startsWith('*') ||
    line.startsWith('<!--')
  ) {
    return true;
  }
  if ((dialect === 'python' || dialect === 'ruby') && line.startsWith('#')) {
    return true;
  }
  return false;
}

/** Lines that document/annotate the declaration directly below them and
 * should be absorbed into that declaration's chunk: comments + attributes
 * (decorators `@`, rust `#[...]`, C# `[...]`). */
function isAttachDown(line: string, dialect: Dialect): boolean {
  if (isComment(line, dialect)) return true;
  if (line.startsWith('@')) return true; // decorators / annotations
  if (dialect === 'rust' && line.startsWith('#[')) return true;
  if (dialect === 'csharp' && /^\[[A-Za-z_]/.test(line)) return true;
  return false;
}

function leadingWhitespace(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  return i;
}

/**
 * Find the start-line indices of semantic units in `lines`. Always returns
 * a sorted, unique list beginning with 0. The caller forms half-open
 * ranges [b_k, b_{k+1}) and packs them into budgeted chunks.
 */
export function findUnitBoundaries(lines: readonly string[], dialect: Dialect): number[] {
  const decl = DECL[dialect];
  const anchors: number[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (leadingWhitespace(line) > 0) continue; // top-level only
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue; // blank
    if (CLOSER.test(trimmed)) continue; // dangling closer / continuation
    if (isComment(trimmed, dialect)) continue; // handled via walk-back

    const prevBlank = (lines[i - 1] ?? '').trim().length === 0;
    const isDecl = decl.test(trimmed);
    // A boundary is a recognized declaration, OR any other top-level line
    // that opens a fresh block (preceded by a blank line). The latter is
    // the language-agnostic safety net for syntax our regexes don't cover.
    if (!isDecl && !prevBlank) continue;

    anchors.push(i);
  }

  // Walk each anchor up over the contiguous run of comments/decorators
  // directly above it, so a doc-comment block attaches to the declaration
  // it documents instead of trailing the previous chunk.
  const boundaries = new Set<number>([0]);
  for (const a of anchors) {
    let start = a;
    while (start - 1 > 0) {
      const above = (lines[start - 1] ?? '').trimEnd();
      if (leadingWhitespace(lines[start - 1] ?? '') > 0) break;
      if (above.length === 0) break; // blank separates → stop
      if (!isAttachDown(above, dialect)) break;
      start -= 1;
    }
    boundaries.add(start);
  }

  return Array.from(boundaries).sort((x, y) => x - y);
}
