export const ESTIMATED_MESSAGE_HEIGHT = 160;
export const VIRTUAL_OVERSCAN_PX = 2000;
export const FALLBACK_VIEWPORT_HEIGHT = 720;

export interface MessageWindow {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
  totalHeight: number;
}

/**
 * Which transcript rows to mount for the current scroll position.
 * Unmounted rows stay in the conversation: their estimated height is still
 * part of totalHeight, so the scrollbar covers the whole session.
 */
export function messageWindow({
  count,
  scrollTop,
  viewportHeight,
  heights,
  pinToBottom,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT,
  overscanPx = VIRTUAL_OVERSCAN_PX,
  fallbackViewportHeight = FALLBACK_VIEWPORT_HEIGHT,
}: {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  heights: readonly (number | undefined)[];
  pinToBottom: boolean;
  estimatedHeight?: number;
  overscanPx?: number;
  fallbackViewportHeight?: number;
}): MessageWindow {
  if (count <= 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0, totalHeight: 0 };
  }

  const offsets = new Array<number>(count);
  let totalHeight = 0;
  for (let index = 0; index < count; index++) {
    offsets[index] = totalHeight;
    const measured = heights[index];
    totalHeight += measured === undefined ? estimatedHeight : measured;
  }

  const viewport = viewportHeight > 0 ? viewportHeight : fallbackViewportHeight;
  const maxScroll = Math.max(0, totalHeight - viewport);
  // A stale scroll offset past the shrunken transcript used to produce an empty
  // window. Clamp it so the tail stays mounted instead of flashing out.
  const top = pinToBottom ? maxScroll : Math.min(Math.max(0, scrollTop), maxScroll);
  const viewStart = Math.max(0, top - overscanPx);
  const viewEnd = top + viewport + overscanPx;

  let start = 0;
  while (
    start < count &&
    offsets[start] + rowHeight(heights[start], estimatedHeight) <= viewStart
  ) {
    start++;
  }

  let end = start;
  while (end < count && offsets[end] < viewEnd) {
    end++;
  }

  return {
    start,
    end,
    paddingTop: offsets[start] ?? 0,
    paddingBottom: end >= count ? 0 : totalHeight - offsets[end],
    totalHeight,
  };
}

function rowHeight(measured: number | undefined, estimatedHeight: number) {
  return measured === undefined ? estimatedHeight : measured;
}

/** Scroll offset of a row from the top of the transcript. */
export function messageOffset(
  heights: readonly (number | undefined)[],
  index: number,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
) {
  let offset = 0;
  const last = Math.min(index, heights.length);
  for (let cursor = 0; cursor < last; cursor++) {
    offset += rowHeight(heights[cursor], estimatedHeight);
  }
  return offset;
}

/**
 * How much content strictly above `anchor` grew or shrank.
 * Rows that intersect the anchor are left out so the viewport does not jump
 * while the user is looking at them.
 */
export function heightDeltaAbove(
  previous: readonly (number | undefined)[],
  next: readonly (number | undefined)[],
  anchor: number,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
) {
  let offset = 0;
  let delta = 0;
  const count = Math.max(previous.length, next.length);
  for (let index = 0; index < count; index++) {
    const before = rowHeight(previous[index], estimatedHeight);
    const after = rowHeight(next[index], estimatedHeight);
    if (offset + before > anchor) break;
    delta += after - before;
    offset += before;
  }
  return delta;
}
