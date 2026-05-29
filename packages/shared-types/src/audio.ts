export const AUDIO_SAMPLE_RATE_HZ = 16_000;
export const AUDIO_FRAME_DURATION_MS = 20;
export const AUDIO_FRAME_SAMPLE_COUNT = (AUDIO_SAMPLE_RATE_HZ * AUDIO_FRAME_DURATION_MS) / 1000;

export type StreamRole =
  | { readonly kind: 'local-system' }
  | { readonly kind: 'local-mic' }
  | { readonly kind: 'remote-participant'; readonly participantId: string }
  | { readonly kind: 'remote-mixed' };

export interface AudioFrame {
  readonly streamRole: StreamRole;
  readonly index: number;
  readonly samples: Int16Array;
  readonly capturedAt: number;
}

export type ControlMsg =
  | { readonly type: 'hello'; readonly sidecarVersion: string; readonly nonceEcho: string }
  | { readonly type: 'started'; readonly device: string; readonly sampleRate: number }
  | { readonly type: 'device-changed'; readonly device: string }
  | { readonly type: 'permission-denied'; readonly reason: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string }
  | { readonly type: 'stopped'; readonly reason?: string };

export type AudioSourceStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface AudioSourceEvents {
  frame: [AudioFrame];
  control: [ControlMsg];
  error: [Error];
  end: [];
}

export interface AudioSourceConfig {
  readonly id: string;
}
