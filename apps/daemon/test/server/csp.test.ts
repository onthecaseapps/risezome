import { describe, expect, it } from 'vitest';
import { buildCspHeader } from '../../src/server/csp.js';

describe('buildCspHeader', () => {
  it('emits script-src self with no nonce or hashes by default', () => {
    expect(buildCspHeader(4337)).toContain("script-src 'self'");
  });

  it('includes the per-request nonce in script-src', () => {
    const csp = buildCspHeader(4337, 'abc123');
    expect(csp).toContain(`'nonce-abc123'`);
    expect(csp).toContain(`'self'`);
  });

  it('includes inline-script hashes in script-src alongside nonce', () => {
    const csp = buildCspHeader(4337, 'abc123', ['sha256-AAA', 'sha256-BBB']);
    expect(csp).toContain(`'sha256-AAA'`);
    expect(csp).toContain(`'sha256-BBB'`);
    expect(csp).toContain(`'nonce-abc123'`);
  });

  it('includes hashes without a nonce when nonce is omitted', () => {
    const csp = buildCspHeader(4337, undefined, ['sha256-XXX']);
    expect(csp).toContain(`'sha256-XXX'`);
    expect(csp).toContain(`'self'`);
    expect(csp).not.toContain('nonce-');
  });

  it('does not include unsafe-inline in script-src', () => {
    const csp = buildCspHeader(4337, 'n', ['sha256-AAA']);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('keeps the existing default-src and connect-src clauses intact', () => {
    const csp = buildCspHeader(4337);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('connect-src ws://127.0.0.1:4337 http://127.0.0.1:4337');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
