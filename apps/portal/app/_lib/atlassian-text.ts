/**
 * Convert Atlassian content shapes to plain indexable text.
 *
 *  - Jira issue descriptions + comments are Atlassian Document Format (ADF) JSON.
 *  - Confluence page bodies (body-format=storage) are XHTML-like storage format.
 *
 * Both are reduced to readable plain text for chunking/embedding. A minimal
 * in-repo walker avoids pulling the heavy Atlaskit dependency tree.
 */

interface AdfNode {
  readonly type?: string;
  readonly text?: string;
  readonly content?: readonly AdfNode[];
}

// ADF block nodes that should end with a line break so text doesn't run together.
const ADF_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
  'listItem',
  'tableCell',
  'tableHeader',
  'panel',
]);

/**
 * Extract plain text from an ADF document. Null/undefined (a common shape for
 * issues with no description) yields an empty string. Traversing the content
 * tree in order and concatenating `text` nodes preserves reading order.
 */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined || typeof doc !== 'object') return '';
  const out: string[] = [];

  const walk = (node: AdfNode): void => {
    if (node === null || typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(node.text);
      return;
    }
    if (node.type === 'hardBreak') {
      out.push('\n');
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) walk(child);
    }
    if (typeof node.type === 'string' && ADF_BLOCK_TYPES.has(node.type)) {
      out.push('\n');
    }
  };

  walk(doc as AdfNode);
  return normalize(out.join(''));
}

/** Extract plain text from Confluence storage-format (XHTML-like) body. */
export function storageToText(storage: unknown): string {
  if (typeof storage !== 'string') return '';
  return normalize(
    storage
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|td|th|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** Collapse whitespace, trim each line, cap consecutive blank lines. */
function normalize(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
