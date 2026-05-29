export function buildCspHeader(port: number, scriptNonce?: string): string {
  const scriptSrc =
    scriptNonce !== undefined && scriptNonce.length > 0
      ? `script-src 'self' 'nonce-${scriptNonce}'`
      : "script-src 'self'";
  return [
    "default-src 'self'",
    `connect-src ws://127.0.0.1:${String(port)} http://127.0.0.1:${String(port)}`,
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; ');
}
