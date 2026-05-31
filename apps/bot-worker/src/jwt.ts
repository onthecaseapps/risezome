import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * JWT issued at bot-launch time by the portal (U8) and verified by the
 * bot-worker when Recall.ai connects back. HS256 with a shared secret;
 * payload binds the connection to a specific meeting + org.
 *
 * The token travels as a URL path segment:
 *   wss://<bot-worker>/recall/<meetingId>/<jwt>
 *
 * Verification steps (in the WS upgrade handler):
 *   1. jwtVerify(token, secret) — signature + expiration
 *   2. payload.meetingId === url-segment.meetingId  (cross-meeting replay)
 *
 * `botId` is intentionally NOT in the JWT. Recall.ai's bot id is
 * returned by Create Bot, but the realtime_endpoints URL must be
 * supplied AT Create Bot time — we don't yet know botId when we sign.
 * Recall also doesn't include bot_id in WS upgrade headers, so we
 * can't validate it at connect time anyway. The signature + meeting
 * binding is sufficient: forging requires the bot-worker secret, and
 * a stolen JWT is scoped to one meeting and the launcher's token TTL.
 */
export interface BotWsJwtPayload extends JWTPayload {
  meetingId: string;
  orgId: string;
}

const ISSUER = 'risezome-portal';
const AUDIENCE = 'risezome-bot-worker';
const ALG = 'HS256';

export async function signBotWsJwt(
  payload: { meetingId: string; orgId: string },
  secret: string,
  /** Token lifetime — defaults to 4h, plenty of margin past the bot's
   *  in-call cap. The cap is the real safety guard; this is belt-and-
   *  suspenders so a leaked token can't replay indefinitely. */
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
    .sign(encodeSecret(secret));
}

export async function verifyBotWsJwt(
  token: string,
  secret: string,
): Promise<BotWsJwtPayload> {
  const { payload } = await jwtVerify(token, encodeSecret(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [ALG],
  });
  if (typeof payload['meetingId'] !== 'string' || typeof payload['orgId'] !== 'string') {
    throw new Error('jwt missing required claims (meetingId, orgId)');
  }
  return payload as BotWsJwtPayload;
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
