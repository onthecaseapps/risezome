import { describe, expect, it } from 'vitest';
import { ansiToHtml, escapeHtml, levelOf, renderLine } from '../../scripts/dev-console/ansi';

const ESC = '\u001b';

describe('ansiToHtml', () => {
  it('wraps SGR color codes in spans and closes on reset', () => {
    const html = ansiToHtml(`${ESC}[31mred${ESC}[0m plain`);
    expect(html).toContain('<span');
    expect(html).toContain('color:');
    expect(html).toContain('red</span>');
    expect(html).toContain(' plain');
  });

  it('leaves plain text untouched (no spans)', () => {
    expect(ansiToHtml('hello world')).toBe('hello world');
  });

  it('HTML-escapes text so log content cannot inject markup', () => {
    expect(ansiToHtml('<script>alert(1)</script> & more')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; more',
    );
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });

  it('handles an unterminated escape without throwing', () => {
    expect(() => ansiToHtml(`${ESC}[3`)).not.toThrow();
    expect(() => ansiToHtml(`partial ${ESC}[`)).not.toThrow();
  });

  it('does not leave a span open across the end of input', () => {
    const html = ansiToHtml(`${ESC}[32mgreen`);
    expect((html.match(/<span/g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length);
  });
});

describe('levelOf', () => {
  it('classifies error / warn / info', () => {
    expect(levelOf('Error: boom')).toBe('error');
    expect(levelOf('ENOENT: no such file')).toBe('error');
    expect(levelOf('WARN deprecation')).toBe('warn');
    expect(levelOf('listening on :3000')).toBe('info');
  });
});

describe('renderLine', () => {
  it('returns html + level together', () => {
    expect(renderLine('plain info')).toEqual({ html: 'plain info', level: 'info' });
    expect(renderLine('Error happened').level).toBe('error');
  });
});
