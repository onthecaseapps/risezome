const ENGLISH_STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'should',
  'some',
  'so',
  'such',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yeah',
  'ok',
  'okay',
  'um',
  'uh',
  'gonna',
  'wanna',
  'thing',
  'stuff',
  'something',
]);

export function tokenize(text: string): string[] {
  return text
    .split(/[\s,.;:!?()/\\[\]{}"']+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function stripStopwords(text: string): string[] {
  return tokenize(text).filter((t) => !ENGLISH_STOPWORDS.has(t.toLowerCase()));
}

export function hasEntityLikeToken(text: string): boolean {
  const tokens = stripStopwords(text);
  for (const t of tokens) {
    if (/[A-Z]/.test(t) && t.length >= 2) return true;
    if (/\d/.test(t)) return true;
    if (t.includes('-') || t.includes('_')) return true;
  }
  return false;
}

const FTS5_RESERVED_RE = /["()*+:^]/g;

export function escapeFtsTerm(term: string): string {
  return term.replace(FTS5_RESERVED_RE, ' ');
}

export function buildFtsQuery(text: string): string {
  const terms = stripStopwords(text)
    .map(escapeFtsTerm)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return terms.join(' OR ');
}
