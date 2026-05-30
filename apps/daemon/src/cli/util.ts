export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    log('error', `Missing required env var ${name}.`);
    process.exit(1);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  return value;
}

export function envInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    log('warn', `Env var ${name}=${value} is not an integer; using fallback ${String(fallback)}.`);
    return fallback;
  }
  return parsed;
}

// envFloat mirrors envInt for non-integer thresholds (e.g.,
// RISEZOME_SYNTHESIS_MIN_SCORE=0.025). Critical detail: a bare
// Number('0,025') (European decimal) returns NaN; without
// Number.isFinite gate that would silently disable a gate based on
// `value >= NaN` always being false. The fallback warns and keeps the
// gate working.
export function envFloat(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    log('warn', `Env var ${name}=${value} is not a finite number; using fallback ${String(fallback)}.`);
    return fallback;
  }
  return parsed;
}

export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const meta_str = meta !== undefined ? ` ${JSON.stringify(meta)}` : '';
  const line = `${ts} [${level}] ${message}${meta_str}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
