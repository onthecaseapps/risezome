import { EventEmitter } from 'node:events';
import {
  IllegalStateError,
  type AudioSourceEvents,
  type AudioSourceStatus,
  type ControlMsg,
  type AudioFrame,
} from '@upwell/shared-types';

export interface AudioSource extends EventEmitter<AudioSourceEvents> {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): AudioSourceStatus;
}

export abstract class AudioSourceBase
  extends EventEmitter<AudioSourceEvents>
  implements AudioSource
{
  #status: AudioSourceStatus = 'idle';

  status(): AudioSourceStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#status === 'running' || this.#status === 'starting') {
      return;
    }
    if (this.#status === 'stopping' || this.#status === 'stopped' || this.#status === 'failed') {
      throw new IllegalStateError(
        `Cannot start AudioSource in status '${this.#status}'. Once stopped, sources are terminal — create a new instance.`,
      );
    }
    this.#status = 'starting';
    try {
      await this.onStart();
      this.#status = 'running';
    } catch (err) {
      this.#status = 'failed';
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.#status === 'idle' || this.#status === 'stopped' || this.#status === 'stopping') {
      return;
    }
    if (this.#status === 'failed') {
      this.#status = 'stopped';
      return;
    }
    this.#status = 'stopping';
    try {
      await this.onStop();
    } finally {
      this.#status = 'stopped';
      this.emit('end');
    }
  }

  protected emitFrame(frame: AudioFrame): void {
    this.emit('frame', frame);
  }

  protected emitControl(msg: ControlMsg): void {
    this.emit('control', msg);
  }

  protected emitErrorEvent(err: Error): void {
    this.emit('error', err);
  }

  protected abstract onStart(): Promise<void>;
  protected abstract onStop(): Promise<void>;
}
