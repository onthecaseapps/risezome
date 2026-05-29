import { type AudioFrame, type ControlMsg, type StreamRole } from '@upwell/shared-types';
import { SidecarProtocolError } from './errors.js';

export const ROLE_LOCAL_SYSTEM = 0x00;
export const ROLE_LOCAL_MIC = 0x01;
export const ROLE_REMOTE_PARTICIPANT = 0x02;
export const ROLE_REMOTE_MIXED = 0x03;

const MAX_PAYLOAD_BYTES = 1 << 20;
const MAX_PARTICIPANT_ID_BYTES = 256;

export function encodeRole(role: StreamRole): Buffer {
  switch (role.kind) {
    case 'local-system':
      return Buffer.from([ROLE_LOCAL_SYSTEM]);
    case 'local-mic':
      return Buffer.from([ROLE_LOCAL_MIC]);
    case 'remote-mixed':
      return Buffer.from([ROLE_REMOTE_MIXED]);
    case 'remote-participant': {
      const idBytes = Buffer.from(role.participantId, 'utf8');
      if (idBytes.length > MAX_PARTICIPANT_ID_BYTES) {
        throw new SidecarProtocolError(
          `participantId too long: ${idBytes.length} bytes (max ${MAX_PARTICIPANT_ID_BYTES})`,
        );
      }
      const header = Buffer.alloc(3);
      header.writeUInt8(ROLE_REMOTE_PARTICIPANT, 0);
      header.writeUInt16BE(idBytes.length, 1);
      return Buffer.concat([header, idBytes]);
    }
  }
}

export function encodeFrame(role: StreamRole, samples: Int16Array): Buffer {
  const roleBytes = encodeRole(role);
  const payload = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const lenHeader = Buffer.alloc(4);
  lenHeader.writeUInt32BE(payload.length, 0);
  return Buffer.concat([roleBytes, lenHeader, payload]);
}

interface DecodedRole {
  role: StreamRole;
  consumed: number;
}

function decodeRole(buf: Buffer): DecodedRole | null {
  if (buf.length === 0) return null;
  const tag = buf.readUInt8(0);
  switch (tag) {
    case ROLE_LOCAL_SYSTEM:
      return { role: { kind: 'local-system' }, consumed: 1 };
    case ROLE_LOCAL_MIC:
      return { role: { kind: 'local-mic' }, consumed: 1 };
    case ROLE_REMOTE_MIXED:
      return { role: { kind: 'remote-mixed' }, consumed: 1 };
    case ROLE_REMOTE_PARTICIPANT: {
      if (buf.length < 3) return null;
      const idLen = buf.readUInt16BE(1);
      if (idLen > MAX_PARTICIPANT_ID_BYTES) {
        throw new SidecarProtocolError(
          `participantId length ${idLen} exceeds max ${MAX_PARTICIPANT_ID_BYTES}`,
        );
      }
      if (buf.length < 3 + idLen) return null;
      const participantId = buf.subarray(3, 3 + idLen).toString('utf8');
      return {
        role: { kind: 'remote-participant', participantId },
        consumed: 3 + idLen,
      };
    }
    default:
      throw new SidecarProtocolError(`Unknown role tag 0x${tag.toString(16).padStart(2, '0')}`);
  }
}

export interface DecodedFrame {
  role: StreamRole;
  samples: Int16Array;
}

export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: DecodedFrame[] = [];
    while (true) {
      const next = this.#tryDecodeOne();
      if (next === null) break;
      frames.push(next);
    }
    return frames;
  }

  #tryDecodeOne(): DecodedFrame | null {
    const decodedRole = decodeRole(this.#buffer);
    if (decodedRole === null) return null;
    const offsetAfterRole = decodedRole.consumed;

    if (this.#buffer.length < offsetAfterRole + 4) return null;
    const payloadLen = this.#buffer.readUInt32BE(offsetAfterRole);
    if (payloadLen > MAX_PAYLOAD_BYTES) {
      throw new SidecarProtocolError(
        `Frame payload length ${payloadLen} exceeds max ${MAX_PAYLOAD_BYTES}`,
      );
    }
    if (payloadLen % 2 !== 0) {
      throw new SidecarProtocolError(
        `Frame payload length ${payloadLen} is not a multiple of 2 (Int16)`,
      );
    }

    const payloadStart = offsetAfterRole + 4;
    const payloadEnd = payloadStart + payloadLen;
    if (this.#buffer.length < payloadEnd) return null;

    const samplesBuffer = this.#buffer.subarray(payloadStart, payloadEnd);
    const samplesCopy = new ArrayBuffer(samplesBuffer.byteLength);
    Buffer.from(samplesCopy).set(samplesBuffer);
    const samples = new Int16Array(samplesCopy);

    this.#buffer = this.#buffer.subarray(payloadEnd);
    return { role: decodedRole.role, samples };
  }
}

const KNOWN_CONTROL_TYPES = new Set([
  'hello',
  'started',
  'device-changed',
  'permission-denied',
  'error',
  'stopped',
]);

export function parseControlLine(line: string): ControlMsg {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new SidecarProtocolError(`Invalid control message JSON: ${line}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SidecarProtocolError(`Control message must be an object, got: ${typeof parsed}`);
  }
  const candidate = parsed as Record<string, unknown>;
  const type = candidate.type;
  if (typeof type !== 'string' || !KNOWN_CONTROL_TYPES.has(type)) {
    throw new SidecarProtocolError(`Unknown control message type: ${String(type)}`);
  }
  return candidate as unknown as ControlMsg;
}

export class ControlLineSplitter {
  #buffer = '';

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines: string[] = [];
    let newlineIdx = this.#buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.#buffer.slice(0, newlineIdx).trim();
      if (line.length > 0) lines.push(line);
      this.#buffer = this.#buffer.slice(newlineIdx + 1);
      newlineIdx = this.#buffer.indexOf('\n');
    }
    return lines;
  }
}

export interface StdinCommand {
  readonly type: 'nonce' | 'stop';
  readonly nonce?: string;
}

export function encodeStdinCommand(cmd: StdinCommand): string {
  return JSON.stringify(cmd) + '\n';
}

export function toAudioFrame(decoded: DecodedFrame, index: number, capturedAt: number): AudioFrame {
  return {
    streamRole: decoded.role,
    index,
    samples: decoded.samples,
    capturedAt,
  };
}
