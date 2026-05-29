import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

export const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
  'Pods',
  '.gradle',
  '.idea',
  '.vscode',
  'coverage',
  '.nyc_output',
]);

export const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.kt',
  '.swift',
  '.cs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.hh',
  '.php',
  '.scala',
  '.ex',
  '.exs',
  '.erl',
  '.clj',
  '.cljs',
  '.lua',
  '.r',
  '.dart',
  '.zig',
  '.nim',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
]);

export const DOC_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.rst',
  '.txt',
  '.adoc',
  '.org',
]);

export const NOTABLE_FILENAMES = new Set([
  'README',
  'README.md',
  'README.markdown',
  'README.rst',
  'README.txt',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'LICENSE',
  'CHANGELOG.md',
  'CLAUDE.md',
  'AGENTS.md',
  'GUIDELINES.md',
  'STYLE.md',
  'ARCHITECTURE.md',
  'TODO.md',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
]);

const GENERATED_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/,
  /\.bundle\.js$/,
  /\.map$/,
  /\.d\.ts$/,
  /\.tsbuildinfo$/,
];

export type WalkedFileKind = 'code' | 'doc';

export interface WalkedFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly kind: WalkedFileKind;
  readonly bytes: number;
  readonly content: string;
}

export interface WalkOptions {
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 5_000;

export async function* walkRepoFiles(
  rootDir: string,
  options: WalkOptions = {},
): AsyncGenerator<WalkedFile> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  let emitted = 0;

  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        stack.push(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (LOCKFILE_NAMES.has(entry.name)) continue;
      if (GENERATED_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
      const kind = classifyFile(entry.name);
      if (kind === null) continue;

      const s = await stat(absPath);
      if (s.size > maxFileBytes) continue;

      let content: string;
      try {
        content = await readFile(absPath, 'utf8');
      } catch {
        continue;
      }
      if (containsBinaryNoise(content)) continue;

      yield {
        relPath: relative(rootDir, absPath).split(sep).join('/'),
        absPath,
        kind,
        bytes: s.size,
        content,
      };
      emitted += 1;
      if (emitted >= maxFiles) return;
    }
  }
}

export function classifyFile(name: string): WalkedFileKind | null {
  if (NOTABLE_FILENAMES.has(name)) return 'doc';
  const ext = extname(name).toLowerCase();
  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return null;
}

function containsBinaryNoise(s: string): boolean {
  let nullBytes = 0;
  const sample = s.length > 4096 ? s.slice(0, 4096) : s;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0) {
      nullBytes += 1;
      if (nullBytes > 2) return true;
    }
  }
  return false;
}
