import { join } from 'node:path';
import type { CanonicalChunk, CanonicalDoc } from '../../corpus/types.js';
import type { AuthResult, ScopeDescriptor } from '../contract.js';
import { ensureClone, type CloneResult } from './clone.js';
import { walkRepoFiles, type WalkOptions } from './walk.js';
import { chunkMarkdown } from './chunk-md.js';
import { chunkCode } from './chunk-code.js';
import { chunkIsMeaningful, languageForPath } from './chunk-shared.js';

export interface PullRepoFilesOptions {
  readonly cacheDir: string;
  readonly walkOptions?: WalkOptions;
  readonly clonePath?: string;
}

export interface RepoFilesResult {
  readonly docs: CanonicalDoc[];
  readonly chunks: CanonicalChunk[];
  readonly cloned: boolean;
  readonly clonePath: string;
}

export async function pullRepoFiles(
  auth: AuthResult,
  scope: ScopeDescriptor,
  options: PullRepoFilesOptions,
): Promise<RepoFilesResult> {
  const ownerRepo = scope.id;

  let clone: CloneResult;
  if (options.clonePath !== undefined) {
    clone = { path: options.clonePath, cached: true };
  } else {
    clone = await ensureClone({
      ownerRepo,
      auth,
      cacheDir: options.cacheDir,
    });
  }

  const repoUrl = scope.metadata?.url;
  const docs: CanonicalDoc[] = [];
  const chunks: CanonicalChunk[] = [];

  for await (const file of walkRepoFiles(clone.path, options.walkOptions ?? {})) {
    const docId = `gh:${ownerRepo}#file:${file.relPath}`;
    const url = typeof repoUrl === 'string' ? `${repoUrl}/blob/HEAD/${file.relPath}` : undefined;

    docs.push({
      id: docId,
      source: 'github',
      type: file.kind === 'doc' ? 'doc' : 'code-file',
      title: file.relPath,
      bodySummary: file.content.slice(0, 240),
      entities: [file.relPath],
      authors: [],
      updatedAt: Date.now(),
      provenance: 'untrusted',
      ...(url !== undefined && { url }),
    });

    if (file.kind === 'doc') {
      const mdChunks = chunkMarkdown(file.content);
      mdChunks.forEach((c) => {
        const text = c.heading !== null ? `## ${c.heading}\n\n${c.text}` : c.text;
        if (!chunkIsMeaningful(text)) return;
        chunks.push({
          chunkId: `${docId}#md:${String(c.index)}`,
          docId,
          domain: 'text',
          text,
          position: c.index,
        });
      });
    } else {
      const language = languageForPath(file.relPath);
      const codeChunks = chunkCode(file.content);
      codeChunks.forEach((c) => {
        // Header carries path:lines AND a `lang:` hint so the embedded
        // text gives the model a semantic anchor beyond the file path
        // extension alone. Helps queries like "show me a python example"
        // resolve to the right language even when path is something
        // generic like `scripts/migrate.py`.
        const header = `${file.relPath}:${String(c.startLine)}-${String(c.endLine)} (lang: ${language})`;
        const text = `// ${header}\n${c.text}`;
        if (!chunkIsMeaningful(text)) return;
        chunks.push({
          chunkId: `${docId}#code:${String(c.index)}`,
          docId,
          domain: 'code',
          text,
          position: c.index,
        });
      });
    }
  }

  return { docs, chunks, cloned: !clone.cached, clonePath: clone.path };
}

export function makeCacheDir(dataDir: string): string {
  return join(dataDir, 'cache', 'github');
}
