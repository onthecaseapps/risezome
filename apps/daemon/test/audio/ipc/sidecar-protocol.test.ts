import { describe, expect, it } from 'vitest';
import { AUDIO_FRAME_SAMPLE_COUNT, type StreamRole } from '@upwell/shared-types';
import {
  ControlLineSplitter,
  FrameDecoder,
  ROLE_LOCAL_SYSTEM,
  encodeFrame,
  encodeStdinCommand,
  parseControlLine,
} from '../../../src/audio/ipc/sidecar-protocol.js';
import { SidecarProtocolError } from '../../../src/audio/ipc/errors.js';

function syntheticSamples(seed: number): Int16Array {
  const out = new Int16Array(AUDIO_FRAME_SAMPLE_COUNT);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((seed + i) % 32_768) - 16_384;
  }
  return out;
}

describe('FrameDecoder', () => {
  describe('happy paths', () => {
    it('round-trips 50 local-system frames', () => {
      const decoder = new FrameDecoder();
      const role: StreamRole = { kind: 'local-system' };
      const encoded: Buffer[] = [];
      for (let i = 0; i < 50; i++) {
        encoded.push(encodeFrame(role, syntheticSamples(i)));
      }
      const decoded = decoder.push(Buffer.concat(encoded));

      expect(decoded).toHaveLength(50);
      decoded.forEach((d, i) => {
        expect(d.role).toEqual({ kind: 'local-system' });
        expect(d.samples).toBeInstanceOf(Int16Array);
        expect(d.samples.length).toBe(AUDIO_FRAME_SAMPLE_COUNT);
        expect(d.samples[0]).toBe(syntheticSamples(i)[0]);
        expect(d.samples[d.samples.length - 1]).toBe(
          syntheticSamples(i)[AUDIO_FRAME_SAMPLE_COUNT - 1],
        );
      });
    });

    it('round-trips two-role interleaved frames with correct role tags', () => {
      const decoder = new FrameDecoder();
      const buf = Buffer.concat([
        encodeFrame({ kind: 'local-system' }, syntheticSamples(0)),
        encodeFrame({ kind: 'local-mic' }, syntheticSamples(1)),
        encodeFrame({ kind: 'local-system' }, syntheticSamples(2)),
        encodeFrame({ kind: 'local-mic' }, syntheticSamples(3)),
      ]);
      const decoded = decoder.push(buf);

      expect(decoded.map((d) => d.role.kind)).toEqual([
        'local-system',
        'local-mic',
        'local-system',
        'local-mic',
      ]);
    });

    it('round-trips remote-participant frames with utf-8 participant id', () => {
      const decoder = new FrameDecoder();
      const role: StreamRole = { kind: 'remote-participant', participantId: 'alice@example.com' };
      const decoded = decoder.push(encodeFrame(role, syntheticSamples(7)));

      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.role).toEqual(role);
    });

    it('reassembles a frame split across chunk boundaries', () => {
      const decoder = new FrameDecoder();
      const full = encodeFrame({ kind: 'local-system' }, syntheticSamples(42));

      const first = full.subarray(0, 3);
      const second = full.subarray(3, 5);
      const third = full.subarray(5);

      expect(decoder.push(first)).toEqual([]);
      expect(decoder.push(second)).toEqual([]);
      const decoded = decoder.push(third);
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.role.kind).toBe('local-system');
      expect(decoded[0]?.samples.length).toBe(AUDIO_FRAME_SAMPLE_COUNT);
    });

    it('decodes back-to-back frames split mid-frame', () => {
      const decoder = new FrameDecoder();
      const buf = Buffer.concat([
        encodeFrame({ kind: 'local-system' }, syntheticSamples(1)),
        encodeFrame({ kind: 'local-mic' }, syntheticSamples(2)),
      ]);
      const decodedA = decoder.push(buf.subarray(0, 100));
      const decodedB = decoder.push(buf.subarray(100));
      expect([...decodedA, ...decodedB]).toHaveLength(2);
    });
  });

  describe('protocol errors', () => {
    it('rejects a frame with payload length not a multiple of 2', () => {
      const decoder = new FrameDecoder();
      const bad = Buffer.alloc(1 + 4 + 3);
      bad.writeUInt8(ROLE_LOCAL_SYSTEM, 0);
      bad.writeUInt32BE(3, 1);
      expect(() => decoder.push(bad)).toThrow(SidecarProtocolError);
      expect(() => decoder.push(bad)).toThrow(/multiple of 2/i);
    });

    it('rejects a frame with payload length over the sanity limit', () => {
      const decoder = new FrameDecoder();
      const bad = Buffer.alloc(5);
      bad.writeUInt8(ROLE_LOCAL_SYSTEM, 0);
      bad.writeUInt32BE(0xff_ff_ff_ff, 1);
      expect(() => decoder.push(bad)).toThrow(SidecarProtocolError);
      expect(() => decoder.push(bad)).toThrow(/exceeds max/i);
    });

    it('rejects an unknown role tag', () => {
      const decoder = new FrameDecoder();
      const bad = Buffer.from([0xff]);
      expect(() => decoder.push(bad)).toThrow(SidecarProtocolError);
      expect(() => decoder.push(bad)).toThrow(/unknown role tag/i);
    });

    it('rejects a participant-id length over the cap', () => {
      const decoder = new FrameDecoder();
      const bad = Buffer.alloc(3);
      bad.writeUInt8(0x02, 0);
      bad.writeUInt16BE(0xffff, 1);
      expect(() => decoder.push(bad)).toThrow(SidecarProtocolError);
      expect(() => decoder.push(bad)).toThrow(/exceeds max/i);
    });
  });
});

describe('ControlLineSplitter', () => {
  it('splits multi-line input into trimmed non-empty lines', () => {
    const splitter = new ControlLineSplitter();
    const out = splitter.push('{"type":"hello"}\n{"type":"started"}\n');
    expect(out).toEqual(['{"type":"hello"}', '{"type":"started"}']);
  });

  it('buffers partial lines across pushes', () => {
    const splitter = new ControlLineSplitter();
    expect(splitter.push('{"type":"hel')).toEqual([]);
    const out = splitter.push('lo"}\n');
    expect(out).toEqual(['{"type":"hello"}']);
  });

  it('ignores blank lines', () => {
    const splitter = new ControlLineSplitter();
    const out = splitter.push('\n  \n{"type":"hello"}\n');
    expect(out).toEqual(['{"type":"hello"}']);
  });
});

describe('parseControlLine', () => {
  it('accepts every documented control type', () => {
    expect(parseControlLine('{"type":"hello","sidecarVersion":"0.1","nonceEcho":"abc"}').type).toBe(
      'hello',
    );
    expect(
      parseControlLine('{"type":"started","device":"alsa.monitor","sampleRate":16000}').type,
    ).toBe('started');
    expect(parseControlLine('{"type":"permission-denied","reason":"no access"}').type).toBe(
      'permission-denied',
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => parseControlLine('{not-json')).toThrow(SidecarProtocolError);
  });

  it('rejects an unknown type', () => {
    expect(() => parseControlLine('{"type":"banana"}')).toThrow(/unknown control message type/i);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseControlLine('"hello"')).toThrow(/must be an object/i);
  });
});

describe('encodeStdinCommand', () => {
  it('serializes a nonce command with trailing newline', () => {
    const out = encodeStdinCommand({ type: 'nonce', nonce: 'abc' });
    expect(out).toBe('{"type":"nonce","nonce":"abc"}\n');
  });
});
