import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { type AudioFrame, type ControlMsg } from '@upwell/shared-types';
import {
  ControlLineSplitter,
  FrameDecoder,
  encodeStdinCommand,
  parseControlLine,
  toAudioFrame,
} from './sidecar-protocol.js';
import {
  PermissionError,
  SidecarExitError,
  SidecarHandshakeError,
  SidecarIntegrityError,
  SidecarLaunchError,
  SidecarProtocolError,
} from './errors.js';
import { getSidecarManifest, type SidecarManifest } from './manifest.js';

export interface SidecarRunnerOptions {
  readonly sidecarPath: string;
  readonly args?: readonly string[];
  readonly manifest?: SidecarManifest;
  readonly handshakeTimeoutMs?: number;
  readonly maxQueuedFrames?: number;
  readonly stderrTailLines?: number;
}

export interface SidecarRunnerEvents {
  frame: [AudioFrame];
  control: [ControlMsg];
  error: [Error];
  stopped: [];
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 500;
const DEFAULT_MAX_QUEUED_FRAMES = 200;
const DEFAULT_STDERR_TAIL_LINES = 20;

export class SidecarRunner extends EventEmitter<SidecarRunnerEvents> {
  readonly #options: SidecarRunnerOptions;
  readonly #handshakeTimeoutMs: number;
  readonly #maxQueuedFrames: number;
  readonly #stderrTailLines: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #frameIndex = 0;
  readonly #stderrTail: string[] = [];
  #droppedFrames = 0;

  constructor(options: SidecarRunnerOptions) {
    super();
    this.#options = options;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    this.#stderrTailLines = options.stderrTailLines ?? DEFAULT_STDERR_TAIL_LINES;
  }

  async start(): Promise<void> {
    const path = this.#options.sidecarPath;
    if (!isAbsolute(path)) {
      throw new SidecarLaunchError(`Sidecar path must be absolute, got: ${path}`);
    }

    let fileStat;
    try {
      fileStat = await stat(path);
    } catch (err) {
      throw new SidecarLaunchError(`Sidecar binary not found at ${path}`, { cause: err });
    }
    if (!fileStat.isFile()) {
      throw new SidecarLaunchError(`Sidecar path is not a regular file: ${path}`);
    }

    await this.#verifyIntegrity(path);
    const nonce = randomBytes(16).toString('hex');
    const child = this.#spawnChild(path);
    this.#child = child;
    this.#wireStdoutDecoder(child);
    this.#wireStderrControl(child);
    this.#wireLifecycle(child);

    child.stdin.write(encodeStdinCommand({ type: 'nonce', nonce }));
    await this.#awaitHandshake(nonce);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        resolve();
      };
      child.once('close', done);
      try {
        child.stdin.write(encodeStdinCommand({ type: 'stop' }));
        child.stdin.end();
      } catch {
        // child may already be dead; close handler still fires.
      }
      setTimeout(() => {
        if (this.#child !== null && !this.#child.killed) {
          this.#child.kill('SIGTERM');
        }
      }, 250).unref();
    });
  }

  droppedFrameCount(): number {
    return this.#droppedFrames;
  }

  async #verifyIntegrity(path: string): Promise<void> {
    const manifest = getSidecarManifest(this.#options.manifest);
    const entry = manifest[path];
    if (entry === undefined) {
      throw new SidecarIntegrityError(
        `Sidecar path ${path} not present in integrity manifest. Refusing to launch.`,
      );
    }
    const actual = await this.#hashFile(path);
    if (actual !== entry.sha256) {
      throw new SidecarIntegrityError(
        `Sidecar binary at ${path} failed integrity check. Expected sha256=${entry.sha256}, got ${actual}.`,
      );
    }
  }

  #hashFile(path: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  #spawnChild(path: string): ChildProcessWithoutNullStreams {
    try {
      return spawn(path, this.#options.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new SidecarLaunchError(`Failed to spawn sidecar at ${path}`, { cause: err });
    }
  }

  #wireStdoutDecoder(child: ChildProcessWithoutNullStreams): void {
    const decoder = new FrameDecoder();
    let queuedFrames = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        const protocolErr =
          err instanceof SidecarProtocolError
            ? err
            : new SidecarProtocolError(String(err), { cause: err });
        this.emit('error', protocolErr);
        child.kill('SIGTERM');
        return;
      }
      for (const decoded of frames) {
        if (queuedFrames >= this.#maxQueuedFrames) {
          this.#droppedFrames += 1;
          if (this.#droppedFrames % 50 === 1) {
            console.warn(
              `[sidecar-runner] backpressure: dropped ${this.#droppedFrames} frames so far`,
            );
          }
          continue;
        }
        queuedFrames += 1;
        const frame = toAudioFrame(decoded, this.#frameIndex++, Date.now());
        queueMicrotask(() => {
          queuedFrames -= 1;
          this.emit('frame', frame);
        });
      }
    });
  }

  #wireStderrControl(child: ChildProcessWithoutNullStreams): void {
    const splitter = new ControlLineSplitter();
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = splitter.push(text);
      for (const line of lines) {
        if (this.#stderrTail.length >= this.#stderrTailLines) this.#stderrTail.shift();
        this.#stderrTail.push(line);
        try {
          const msg = parseControlLine(line);
          this.emit('control', msg);
          if (msg.type === 'permission-denied') {
            this.emit('error', new PermissionError(msg.reason));
          }
        } catch (err) {
          // Tolerate non-JSON stderr lines (e.g., panic messages).
          if (err instanceof SidecarProtocolError) {
            // Only emit protocol errors when the line looked like JSON.
            if (line.startsWith('{')) this.emit('error', err);
          }
        }
      }
    });
  }

  #wireLifecycle(child: ChildProcessWithoutNullStreams): void {
    child.on('close', (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      if (code !== 0 && code !== null) {
        this.emit('error', new SidecarExitError(code, this.#stderrTail.join('\n')));
      }
      this.emit('stopped');
    });
    child.on('error', (err) => {
      this.emit(
        'error',
        new SidecarLaunchError(`Sidecar process error: ${err.message}`, { cause: err }),
      );
    });
  }

  async #awaitHandshake(expectedNonce: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        const child = this.#child;
        if (child !== null) child.kill('SIGTERM');
        reject(
          new SidecarHandshakeError(
            `Sidecar did not echo nonce within ${this.#handshakeTimeoutMs}ms`,
          ),
        );
      }, this.#handshakeTimeoutMs);

      const onControl = (msg: ControlMsg): void => {
        if (msg.type !== 'hello') return;
        if (msg.nonceEcho === expectedNonce) {
          cleanup();
          resolve();
          return;
        }
        cleanup();
        const child = this.#child;
        if (child !== null) child.kill('SIGTERM');
        reject(
          new SidecarHandshakeError(
            `Sidecar hello nonceEcho did not match. Expected ${expectedNonce}, got ${msg.nonceEcho}.`,
          ),
        );
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('control', onControl);
        this.off('error', onError);
      };

      this.on('control', onControl);
      this.on('error', onError);
    });
  }
}
