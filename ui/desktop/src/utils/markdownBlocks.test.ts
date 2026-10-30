import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from './markdownBlocks';

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(splitMarkdownBlocks('first\n\nsecond\n\nthird')).toEqual(['first', 'second', 'third']);
  });

  it('never splits inside a fenced code block', () => {
    const doc = 'intro\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\noutro';
    expect(splitMarkdownBlocks(doc)).toEqual([
      'intro',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```',
      'outro',
    ]);
  });

  it('keeps an unterminated trailing fence as one block (open during streaming)', () => {
    const doc = 'intro\n\n```py\npartial code\nmore code';
    expect(splitMarkdownBlocks(doc)).toEqual(['intro', '```py\npartial code\nmore code']);
  });

  it('merges a loose ordered list so numbering is preserved', () => {
    const doc = '1. first\n\n2. second\n\ntext after';
    expect(splitMarkdownBlocks(doc)).toEqual(['1. first\n\n2. second', 'text after']);
  });

  it('merges consecutive ordered list blocks across paragraphs', () => {
    const doc = '1. one\n2. two\n\n3. three\n\n4. four';
    expect(splitMarkdownBlocks(doc)).toHaveLength(1);
  });

  it('does not merge a paragraph into an adjacent ordered list', () => {
    const doc = 'para\n\n1. one\n\n2. two';
    expect(splitMarkdownBlocks(doc)).toEqual(['para', '1. one\n\n2. two']);
  });

  it('merges indented continuations onto the previous block', () => {
    const doc = '- item\n    indented tail\n\nnext';
    expect(splitMarkdownBlocks(doc)).toEqual(['- item\n    indented tail', 'next']);
  });

  it('merges consecutive blockquote blocks', () => {
    const doc = 'para\n\n> quoted\n\n> more quote';
    expect(splitMarkdownBlocks(doc)).toEqual(['para', '> quoted\n\n> more quote']);
  });

  it('merges consecutive bullet list blocks', () => {
    const doc = '- a\n\n- b';
    expect(splitMarkdownBlocks(doc)).toEqual(['- a\n\n- b']);
  });

  it('handles empty and single-line input', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('just one line')).toEqual(['just one line']);
  });
});
