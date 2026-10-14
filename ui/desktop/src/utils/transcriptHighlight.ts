const HIGHLIGHT_CONTAINER = 'search-highlight-container';
const CHAT_BUBBLE = '.user-message-bubble, .agent-message-bubble';

export function clearTranscriptHighlights(root: ParentNode) {
  root.querySelectorAll(`.${HIGHLIGHT_CONTAINER}`).forEach((node) => node.remove());
}

/**
 * Paint yellow boxes on chat bubbles in one mounted message.
 * Tool calls, command output, and thinking are skipped.
 * Returns the box for `occurrence` so the caller can scroll it into view.
 */
export function paintTranscriptHighlights(
  row: HTMLElement,
  term: string,
  caseSensitive: boolean,
  occurrence: number
): HTMLElement | null {
  clearTranscriptHighlights(row);
  const needle = term.trim();
  if (!needle) return null;

  const regex = new RegExp(escapeRegExp(needle), caseSensitive ? 'g' : 'gi');
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent?.closest(CHAT_BUBBLE)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`.${HIGHLIGHT_CONTAINER}, .search-bar`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const range = document.createRange();
  const rowRect = row.getBoundingClientRect();
  const boxes: HTMLElement[][] = [];
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const text = node.textContent ?? '';
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      if (match[0].length === 0) break;
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0
      );
      if (rects.length > 0) {
        boxes.push(rects.map((rect) => boxFor(rect, rowRect)));
      }
      if (match.index === regex.lastIndex) regex.lastIndex++;
    }
  }

  if (boxes.length === 0) return null;

  const currentIndex = Math.min(Math.max(occurrence, 0), boxes.length - 1);
  boxes[currentIndex].forEach((box) => box.classList.add('current'));

  const overlay = document.createElement('div');
  overlay.className = HIGHLIGHT_CONTAINER;
  overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
  for (const group of boxes) {
    for (const box of group) overlay.appendChild(box);
  }
  row.appendChild(overlay);
  return boxes[currentIndex][0] ?? null;
}

function boxFor(rect: DOMRect, rowRect: DOMRect) {
  const box = document.createElement('div');
  box.className = 'search-highlight';
  box.style.cssText = `
    position: absolute;
    pointer-events: none;
    top: ${rect.top - rowRect.top}px;
    left: ${rect.left - rowRect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
  `;
  return box;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
