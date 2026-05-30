import { NotImplementedError } from '@risezome/shared-types';
import type { EmbedRequest, EmbedResult, Embedder } from './contract.js';
import { DEFAULT_VOYAGE_DIMENSION } from './voyage.js';

export class LocalBgeEmbedder implements Embedder {
  readonly dimension = DEFAULT_VOYAGE_DIMENSION;

  embed(_req: EmbedRequest): Promise<EmbedResult> {
    return Promise.reject(
      new NotImplementedError(
        'LocalBgeEmbedder is deferred to the local-only privacy mode follow-up. ' +
          'See docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md → Scope Boundaries → Deferred to Follow-Up Work.',
      ),
    );
  }
}
