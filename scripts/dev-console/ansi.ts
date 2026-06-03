/**
 * Server-side log line rendering for the dev console (plan U5). The console
 * renders each log line to HTML here (ANSI SGR colors → spans, HTML-escaped) and
 * classifies its level, then ships `{ html, level }` over SSE so the browser is
 * a dumb renderer. Single source of truth, unit-testable.
 */

export type LogLevel = 'error' | 'warn' | 'info';

const FG: Record<number, string> = {
  30: '#3b4048',
  31: '#e06c75',
  32: '#98c379',
  33: '#e5c07b',
  34: '#61afef',
  35: '#c678dd',
  36: '#56b6c2',
  37: '#abb2bf',
  90: '#5c6370',
  91: '#e06c75',
  92: '#98c379',
  93: '#e5c07b',
  94: '#61afef',
  95: '#c678dd',
  96: '#56b6c2',
  97: '#ffffff',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// SGR escape: ESC [ <codes> m
// eslint-disable-next-line no-control-regex -- matching the literal ANSI ESC byte is the point
const SGR = /\u001b\[([0-9;]*)m/g;

export function ansiToHtml(input: string): string {
  let out = '';
  let open = false;
  let last = 0;
  let m: RegExpExecArray | null;
  SGR.lastIndex = 0;
  while ((m = SGR.exec(input)) !== null) {
    out += escapeHtml(input.slice(last, m.index));
    last = SGR.lastIndex;
    const codes = (m[1] ?? '')
      .split(';')
      .filter((c) => c.length > 0)
      .map(Number);
    let color: string | null = null;
    let bold = false;
    let reset = codes.length === 0; // bare ESC[m == reset
    for (const c of codes) {
      if (c === 0) reset = true;
      else if (c === 1) bold = true;
      else if (FG[c] !== undefined) color = FG[c];
    }
    if (open) {
      out += '</span>';
      open = false;
    }
    if (!reset && (color !== null || bold)) {
      const style = `${color !== null ? `color:${color};` : ''}${bold ? 'font-weight:600;' : ''}`;
      out += `<span style="${style}">`;
      open = true;
    }
  }
  out += escapeHtml(input.slice(last));
  if (open) out += '</span>';
  return out;
}

export function levelOf(line: string): LogLevel {
  const l = line.toLowerCase();
  if (/\b(error|fatal|fail|exception|enoent)\b/.test(l)) return 'error';
  if (/\bwarn/.test(l)) return 'warn';
  return 'info';
}

export function renderLine(line: string): { html: string; level: LogLevel } {
  return { html: ansiToHtml(line), level: levelOf(line) };
}
