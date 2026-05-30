import { NotImplementedError } from '@risezome/shared-types';
import { AudioSourceBase } from '../source.js';

export class RecallBotSource extends AudioSourceBase {
  protected onStart(): Promise<void> {
    throw new NotImplementedError(
      'RecallBotSource is deferred to follow-up work (bot-dial-in mode). ' +
        'See docs/plans/2026-05-28-001-feat-meeting-context-copilot-plan.md → Scope Boundaries → Deferred to Follow-Up Work.',
    );
  }

  protected onStop(): Promise<void> {
    return Promise.resolve();
  }
}
