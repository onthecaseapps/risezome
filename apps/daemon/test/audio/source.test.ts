import { describe, expect, it } from 'vitest';
import {
  AUDIO_FRAME_SAMPLE_COUNT,
  IllegalStateError,
  NotImplementedError,
  type AudioFrame,
  type StreamRole,
} from '@risezome/shared-types';
import { AudioSourceBase } from '../../src/audio/source.js';
import { RecallBotSource } from '../../src/audio/sources/recall.stub.js';
import { ZoomRTMSSource } from '../../src/audio/sources/zoom-rtms.stub.js';

class FakeAudioSource extends AudioSourceBase {
  readonly #frameCount: number;
  readonly #role: StreamRole;

  constructor(frameCount: number, role: StreamRole) {
    super();
    this.#frameCount = frameCount;
    this.#role = role;
  }

  protected onStart(): Promise<void> {
    queueMicrotask(() => {
      for (let i = 0; i < this.#frameCount; i++) {
        const frame: AudioFrame = {
          streamRole: this.#role,
          index: i,
          samples: new Int16Array(AUDIO_FRAME_SAMPLE_COUNT),
          capturedAt: Date.now(),
        };
        this.emitFrame(frame);
      }
    });
    return Promise.resolve();
  }

  protected onStop(): Promise<void> {
    return Promise.resolve();
  }
}

async function collectFrames(source: AudioSourceBase, target: number): Promise<AudioFrame[]> {
  const frames: AudioFrame[] = [];
  return await new Promise<AudioFrame[]>((resolve, reject) => {
    source.on('frame', (frame) => {
      frames.push(frame);
      if (frames.length === target) {
        resolve(frames);
      }
    });
    source.on('error', reject);
    source.start().catch(reject);
  });
}

describe('AudioSource', () => {
  describe('happy paths', () => {
    it('FakeAudioSource emits N frames with correct shape, sequence indices, and streamRole', async () => {
      const source = new FakeAudioSource(100, { kind: 'local-system' });
      const frames = await collectFrames(source, 100);

      expect(frames).toHaveLength(100);
      frames.forEach((frame, i) => {
        expect(frame.index).toBe(i);
        expect(frame.samples).toBeInstanceOf(Int16Array);
        expect(frame.samples.length).toBe(AUDIO_FRAME_SAMPLE_COUNT);
        expect(frame.streamRole).toEqual({ kind: 'local-system' });
        expect(frame.capturedAt).toBeGreaterThan(0);
      });

      await source.stop();
    });

    it('FakeRemoteParticipantSource emits frames with participantId routed through streamRole', async () => {
      const source = new FakeAudioSource(10, {
        kind: 'remote-participant',
        participantId: 'p-42',
      });
      const frames = await collectFrames(source, 10);

      expect(frames).toHaveLength(10);
      frames.forEach((frame) => {
        expect(frame.streamRole.kind).toBe('remote-participant');
        if (frame.streamRole.kind === 'remote-participant') {
          expect(frame.streamRole.participantId).toBe('p-42');
        }
      });

      await source.stop();
    });
  });

  describe('lifecycle edge cases', () => {
    it('calling stop() while not started is a no-op', async () => {
      const source = new FakeAudioSource(1, { kind: 'local-system' });
      expect(source.status()).toBe('idle');
      await expect(source.stop()).resolves.toBeUndefined();
      expect(source.status()).toBe('idle');
    });

    it('calling start() after stop() raises IllegalStateError', async () => {
      const source = new FakeAudioSource(1, { kind: 'local-system' });
      await source.start();
      await source.stop();
      expect(source.status()).toBe('stopped');

      await expect(source.start()).rejects.toBeInstanceOf(IllegalStateError);
      await expect(source.start()).rejects.toThrow(/once stopped/i);
    });

    it('stop() emits end event', async () => {
      const source = new FakeAudioSource(1, { kind: 'local-system' });
      const endPromise = new Promise<void>((resolve) => source.once('end', resolve));
      await source.start();
      await source.stop();
      await expect(endPromise).resolves.toBeUndefined();
    });
  });

  describe('stubs for deferred bot-mode sources', () => {
    it('RecallBotSource throws NotImplementedError from start() with a clear message', async () => {
      const source = new RecallBotSource();
      let caught: unknown;
      try {
        await source.start();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotImplementedError);
      expect((caught as Error).message).toMatch(/recall/i);
      expect(source.status()).toBe('failed');
    });

    it('ZoomRTMSSource throws NotImplementedError from start() with a clear message', async () => {
      const source = new ZoomRTMSSource();
      let caught: unknown;
      try {
        await source.start();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotImplementedError);
      expect((caught as Error).message).toMatch(/zoom rtms/i);
      expect(source.status()).toBe('failed');
    });
  });
});
