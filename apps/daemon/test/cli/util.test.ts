import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envFloat } from '../../src/cli/util.js';

const TEST_KEY = 'UPWELL_TEST_ENV_FLOAT';

describe('envFloat', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env[TEST_KEY];
    warnSpy.mockRestore();
  });

  it('returns the parsed float when the env var is set to a valid number', () => {
    process.env[TEST_KEY] = '0.025';
    expect(envFloat(TEST_KEY, 0.5)).toBeCloseTo(0.025, 6);
  });

  it('returns the fallback when the env var is unset', () => {
    expect(envFloat(TEST_KEY, 0.5)).toBe(0.5);
  });

  it('returns the fallback when the env var is empty string', () => {
    process.env[TEST_KEY] = '';
    expect(envFloat(TEST_KEY, 0.5)).toBe(0.5);
  });

  it('returns the fallback AND warns on non-finite input (European decimal "0,025")', () => {
    process.env[TEST_KEY] = '0,025';
    expect(envFloat(TEST_KEY, 0.5)).toBe(0.5);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns the fallback on NaN', () => {
    process.env[TEST_KEY] = 'not-a-number';
    expect(envFloat(TEST_KEY, 0.123)).toBe(0.123);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns the fallback on Infinity', () => {
    process.env[TEST_KEY] = 'Infinity';
    expect(envFloat(TEST_KEY, 0.5)).toBe(0.5);
  });

  it('accepts negative values (caller decides if they make sense)', () => {
    process.env[TEST_KEY] = '-1.5';
    expect(envFloat(TEST_KEY, 0)).toBe(-1.5);
  });

  it('accepts integers as floats', () => {
    process.env[TEST_KEY] = '3';
    expect(envFloat(TEST_KEY, 0.5)).toBe(3);
  });
});
