// Shared chunking constants + helpers used by chunk-md, chunk-code, and the
// issue/PR ingestion in pull-delta. Centralised so the "what counts as a
// meaningful chunk" threshold lives in one place — changing it touches
// every embedder consumer at once.

// A chunk shorter than this is dropped before it ever reaches the embedder.
// Tiny chunks waste embedding budget, produce noisy near-duplicate vectors,
// and surface as empty "##" or two-line cards in the HUD. The threshold is
// generous enough to admit a real one-liner issue body but cuts template
// stubs (a heading alone, a single label name, etc.).
export const MIN_CHUNK_CHARS = 80;

export function chunkIsMeaningful(text: string): boolean {
  return text.trim().length >= MIN_CHUNK_CHARS;
}

// Map a file extension to a Prism-style language name. Used to tag code
// chunks with `lang: typescript` etc. so BM25 queries on language keywords
// hit, and so the embedded prefix gives the vector model a semantic anchor
// beyond the file path.
const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'tsx'],
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'jsx'],
  ['c', 'c'],
  ['h', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['hxx', 'cpp'],
  ['py', 'python'],
  ['pyi', 'python'],
  ['rb', 'ruby'],
  ['gemspec', 'ruby'],
  ['rake', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['fish', 'fish'],
  ['ps1', 'powershell'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['swift', 'swift'],
  ['cs', 'csharp'],
  ['scala', 'scala'],
  ['ex', 'elixir'],
  ['exs', 'elixir'],
  ['erl', 'erlang'],
  ['clj', 'clojure'],
  ['cljs', 'clojure'],
  ['lua', 'lua'],
  ['r', 'r'],
  ['dart', 'dart'],
  ['zig', 'zig'],
  ['nim', 'nim'],
  ['php', 'php'],
]);

export function languageForPath(path: string): string {
  const basename = path.split('/').pop() ?? path;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex === -1) return 'plain';
  const ext = basename.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(ext) ?? 'plain';
}
