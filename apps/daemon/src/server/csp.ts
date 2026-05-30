export function buildCspHeader(
  port: number,
  scriptNonce?: string,
  scriptHashes?: readonly string[],
): string {
  const parts: string[] = ["'self'"];
  if (scriptNonce !== undefined && scriptNonce.length > 0) {
    parts.push(`'nonce-${scriptNonce}'`);
  }
  if (scriptHashes !== undefined) {
    for (const h of scriptHashes) {
      // Each entry is expected to be `sha256-<base64>` (no quotes). Wrap
      // in single quotes here so the CSP token is well-formed.
      parts.push(`'${h}'`);
    }
  }
  const scriptSrc = `script-src ${parts.join(' ')}`;
  return [
    "default-src 'self'",
    `connect-src ws://127.0.0.1:${String(port)} http://127.0.0.1:${String(port)}`,
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; ');
}
