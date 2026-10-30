/**
 * Splits a markdown document into top-level blocks so streaming renders can
 * re-parse only the growing tail instead of the whole document.
 *
 * Boundaries are blank lines, with two refinements that keep rendering
 * identical to a single-document parse:
 * - Fenced code (``` / ~~~) is never split, including unterminated fences.
 * - Blocks that belong to the same list / blockquote are merged back together,
 *   and indented continuation lines attach to the previous block, so ordered
 *   list numbering and nested structures survive the split.
 */
export function splitMarkdownBlocks(content: string): string[] {
  const lines = content.split('\n');

  const segments: string[][] = [];
  let current: string[] = [];
  let fence: false | true = false;

  for (const line of lines) {
    const isFenceLine = /^ {0,3}(```|~~~)/.test(line);
    if (fence) {
      current.push(line);
      if (isFenceLine) fence = false;
      continue;
    }
    if (isFenceLine) {
      if (current.length > 0) segments.push(current);
      current = [line];
      fence = true;
      continue;
    }
    if (line.trim() === '') {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) segments.push(current);

  const merged: string[] = [];
  for (const seg of segments) {
    const text = seg.join('\n');
    const prev = merged[merged.length - 1];
    if (prev !== undefined && continuesBlock(prev, text)) {
      merged[merged.length - 1] = `${prev}\n\n${text}`;
    } else {
      merged.push(text);
    }
  }
  return merged;
}

const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const QUOTE_MARKER = /^ {0,3}>\s?/;

function startsWithList(text: string): boolean {
  return LIST_MARKER.test(text);
}

function startsWithQuote(text: string): boolean {
  return QUOTE_MARKER.test(text);
}

function continuesBlock(prev: string, next: string): boolean {
  const first = next.split('\n', 1)[0] ?? '';
  if (/^ {4,}\S/.test(first)) return true;
  if (startsWithQuote(first) && startsWithQuote(prev)) return true;
  if (startsWithList(first) && startsWithList(prev)) return true;
  return false;
}
