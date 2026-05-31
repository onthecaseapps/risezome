import { SignJWT } from 'jose';

/**
 * Sign-only mirror of apps/bot-worker/src/jwt.ts. The contract
 * (ISSUER, AUDIENCE, ALG, required claims) MUST stay in sync with the
 * verifier. If you change either side, mirror it in the other and run
 * both packages' test suites.
 *
 * Token travels as a URL path segment in the Recall.ai realtime
 * endpoint URL we hand to Create Bot:
 *   wss://<bot-worker-host>/recall/<meetingId>/<jwt>
 */

const ISSUER = 'risezome-portal';
const AUDIENCE = 'risezome-bot-worker';
const ALG = 'HS256';

export async function signBotWsJwt(
  payload: { meetingId: string; orgId: string },
  secret: string,
  expiresInSeconds = 60 * 60 * 4,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    meetingId: payload.meetingId,
    orgId: payload.orgId,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(new TextEncoder().encode(secret));
}
