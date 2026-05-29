import Prism from 'prismjs';

// Component imports must respect Prism's dependency chain. each module
// registers a grammar into the shared Prism.languages object, so children
// must come after parents.
import 'prismjs/components/prism-markup.js';
import 'prismjs/components/prism-clike.js';
import 'prismjs/components/prism-javascript.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-css.js';
import 'prismjs/components/prism-sql.js';

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
  ['json', 'json'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['css', 'css'],
  ['scss', 'css'],
  ['sql', 'sql'],
  ['html', 'markup'],
  ['xml', 'markup'],
  ['svg', 'markup'],
]);

const FILENAME_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
  ['Dockerfile', 'bash'],
  ['Makefile', 'bash'],
  ['Rakefile', 'ruby'],
  ['Gemfile', 'ruby'],
]);

export function detectLanguage(path: string): string {
  const trimmed = path.split(/[?#]/)[0] ?? path;
  const basename = trimmed.split('/').pop() ?? trimmed;
  const exact = FILENAME_TO_LANGUAGE.get(basename);
  if (exact !== undefined) return exact;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex === -1) return 'plain';
  const ext = basename.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_TO_LANGUAGE.get(ext) ?? 'plain';
}

export function highlightCode(code: string, language: string): string {
  if (language === 'plain') return escapeHtml(code);
  const grammar = Prism.languages[language];
  if (grammar === undefined) return escapeHtml(code);
  return Prism.highlight(code, grammar, language);
}

// Parses the snippet format the indexer emits for code chunks:
//   // path/to/file.ext:start-end
//   <code body>
// Returns the location header and remaining body. For non-code snippets
// (no leading `// path:lines` marker) returns body=input, location=null.
export interface ParsedSnippet {
  readonly location: string | null;
  readonly body: string;
}

const LOCATION_REGEX = /^\/\/\s+(\S+:\d+-\d+)\s*\r?\n/;

export function parseSnippet(snippet: string): ParsedSnippet {
  const match = LOCATION_REGEX.exec(snippet);
  if (match === null) return { location: null, body: snippet };
  return {
    location: match[1] ?? null,
    body: snippet.slice(match[0].length),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
