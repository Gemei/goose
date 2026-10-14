import { describe, expect, it } from 'vitest';
import { paintTranscriptHighlights } from './transcriptHighlight';

describe('paintTranscriptHighlights', () => {
  it('marks the requested visible occurrence', () => {
    const row = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'agent-message-bubble';
    bubble.append('Alpha beta. Beta again.');
    const tool = document.createElement('div');
    tool.className = 'goose-message-tool';
    tool.append('beta from the tool');
    row.append(bubble, tool);
    document.body.append(row);

    const range = document.createRange();
    const rect = (top: number) =>
      ({
        top,
        left: 8,
        width: 24,
        height: 12,
        x: 8,
        y: top,
        bottom: top + 12,
        right: 32,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    let call = 0;
    range.getClientRects = () =>
      ({
        length: 1,
        item: () => rect(10 + call),
        [Symbol.iterator]: function* () {
          yield rect(10 + call++);
        },
      }) as unknown as DOMRectList;
    const original = document.createRange;
    document.createRange = () => range;

    const current = paintTranscriptHighlights(row, 'beta', false, 1);
    document.createRange = original;

    const boxes = row.querySelectorAll('.search-highlight');
    expect(boxes).toHaveLength(2);
    expect(boxes[1].classList.contains('current')).toBe(true);
    expect(current).toBe(boxes[1]);
    row.remove();
  });
});
