import { describe, expect, it } from 'vitest';
import { signBotWsJwt, verifyBotWsJwt } from '../src/jwt';

const SECRET = 'test-secret-' + 'x'.repeat(40); // long enough for HS256

const PAYLOAD = {
  meetingId: '11111111-1111-1111-1111-111111111111',
  orgId: '22222222-2222-2222-2222-222222222222',
};

describe('signBotWsJwt + verifyBotWsJwt', () => {
  it('round-trips a valid token', async () => {
    const token = await signBotWsJwt(PAYLOAD, SECRET);
    const payload = await verifyBotWsJwt(token, SECRET);
    expect(payload.meetingId).toBe(PAYLOAD.meetingId);
    expect(payload.orgId).toBe(PAYLOAD.orgId);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signBotWsJwt(PAYLOAD, SECRET);
    await expect(verifyBotWsJwt(token, 'wrong-secret-padding-padding-padding')).rejects.toThrow();
  });

  it('rejects a tampered token', async () => {
    const token = await signBotWsJwt(PAYLOAD, SECRET);
    // Mangle one byte of the body segment.
    const parts = token.split('.');
    const body = parts[1] ?? '';
    parts[1] = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    const tampered = parts.join('.');
    await expect(verifyBotWsJwt(tampered, SECRET)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const token = await signBotWsJwt(PAYLOAD, SECRET, -10); // already expired
    await expect(verifyBotWsJwt(token, SECRET)).rejects.toThrow();
  });

  it('rejects a signature-valid token missing required claims', async () => {
    // Forge a body missing meetingId. Signature verification passes
    // but the claim assertion in verifyBotWsJwt should fail.
    const { SignJWT } = await import('jose');
    const reSigned = await new SignJWT({ orgId: 'o' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('risezome-portal')
      .setAudience('risezome-bot-worker')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyBotWsJwt(reSigned, SECRET)).rejects.toThrow(/missing required claims/);
  });
});
