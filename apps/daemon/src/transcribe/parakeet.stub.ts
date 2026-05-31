import { EventEmitter } from 'node:events';
import { NotImplementedError } from '@risezome/shared-types';
import type { TranscriptionEngine, TranscriptionEngineEvents } from '@risezome/engine/transcribe';

export class ParakeetTranscriptionEngine
  extends EventEmitter<TranscriptionEngineEvents>
  implements TranscriptionEngine
{
  start(): Promise<void> {
    return Promise.reject(
      new NotImplementedError(
        'ParakeetTranscriptionEngine is deferred to the local-only privacy mode follow-up. ' +
          'See docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md → Scope Boundaries → Deferred to Follow-Up Work.',
      ),
    );
  }

  sendFrame(_samples: Int16Array): void {
    // No-op: start() throws first.
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
