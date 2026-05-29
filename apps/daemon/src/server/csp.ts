export function buildCspHeader(port: number): string {
  return [
    "default-src 'self'",
    `connect-src ws://127.0.0.1:${String(port)} http://127.0.0.1:${String(port)}`,
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
  ].join('; ');
}
