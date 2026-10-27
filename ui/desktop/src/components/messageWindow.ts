export const ESTIMATED_MESSAGE_HEIGHT = 160;
export const MIN_ROW_HEIGHT = 72;
export const MAX_ESTIMATE_HEIGHT = 1200;
export const VIRTUAL_OVERSCAN_PX = 800;
export const SLOT_OVERSCAN_PX = 800;
export const HYDRATE_OVERSCAN_PX = 400;
export const STICKY_RELEASE_PX = 8000;
export const FALLBACK_VIEWPORT_HEIGHT = 720;
export const HISTORY_CHUNK = 20;
export const MAX_MOUNTED_ROWS = 80;
export const MAX_HYDRATED_ROWS = 28;
export const HISTORY_MEASURE_TIMEOUT_MS = 600;
export const HEIGHT_FLUSH_IDLE_MS = 400;

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

export function rowHeight(
  measured: number | undefined,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
) {
  return measured === undefined ? estimatedHeight : measured;
}

/**
 * Layout size before a row has been measured. Always a number so scrolling
 * never waits on markdown to mount.
 */
export function estimateRowHeight({
  textLength = 0,
  imageCount = 0,
  toolCount = 0,
  hasThinking = false,
}: {
  textLength?: number;
  imageCount?: number;
  toolCount?: number;
  hasThinking?: boolean;
} = {}): number {
  if (textLength === 0 && imageCount === 0 && toolCount === 0 && !hasThinking) {
    return ESTIMATED_MESSAGE_HEIGHT;
  }
  const lines = Math.max(1, Math.ceil(textLength / 68));
  let height = 56 + lines * 22;
  height += imageCount * 180;
  height += toolCount * 88;
  if (hasThinking) height += 48;
  return Math.min(MAX_ESTIMATE_HEIGHT, Math.max(MIN_ROW_HEIGHT, height));
}

/**
 * Place a row relative to a neighbor that already has a top, so measuring a
 * newly mounted row above the viewport grows it upward instead of pushing
 * every later row down.
 */
export function assignedRowTop(
  index: number,
  heights: readonly (number | undefined)[],
  assigned: Map<number, number>,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
): number {
  const next = assigned.get(index + 1);
  if (next !== undefined) {
    const top = next - rowHeight(heights[index], estimatedHeight);
    assigned.set(index, top);
    return top;
  }
  const existing = assigned.get(index);
  if (existing !== undefined) return existing;
  const prev = assigned.get(index - 1);
  if (prev !== undefined) {
    const top = prev + rowHeight(heights[index - 1], estimatedHeight);
    assigned.set(index, top);
    return top;
  }
  const top = messageOffset(heights, index, estimatedHeight);
  assigned.set(index, top);
  return top;
}

/**
 * Place every mounted row from a frozen seed so already-on-screen cards keep
 * their `top`. New rows above the seed grow upward; new rows below grow down.
 * When the window includes index 0, rebase so the transcript starts at 0.
 */
export function assignRowTops(
  start: number,
  end: number,
  heights: readonly (number | undefined)[],
  previous: ReadonlyMap<number, number>,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
): Map<number, number> {
  const assigned = new Map<number, number>();
  if (end <= start) return assigned;

  let seed = -1;
  for (let index = end - 1; index >= start; index--) {
    const top = previous.get(index);
    if (top !== undefined) {
      seed = index;
      assigned.set(seed, top);
      break;
    }
  }

  if (seed < 0) {
    for (let index = start; index < end; index++) {
      assigned.set(index, messageOffset(heights, index, estimatedHeight));
    }
  } else {
    for (let index = seed - 1; index >= start; index--) {
      assigned.set(
        index,
        assigned.get(index + 1)! - rowHeight(heights[index], estimatedHeight)
      );
    }
    for (let index = seed + 1; index < end; index++) {
      assigned.set(
        index,
        assigned.get(index - 1)! + rowHeight(heights[index - 1], estimatedHeight)
      );
    }
  }

  if (start === 0 && assigned.has(0)) {
    const origin = assigned.get(0)!;
    if (origin !== 0) {
      for (const [index, top] of assigned) {
        assigned.set(index, top - origin);
      }
    }
  }

  return assigned;
}

/**
 * Keep extra already-mounted rows until they are far from the viewport so
 * scrolling does not remount a row on every estimated-height step.
 */
export function stabilizeWindow(
  needed: MessageWindow,
  stickyStart: number,
  stickyEnd: number,
  heights: readonly (number | undefined)[],
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT,
  releasePx = STICKY_RELEASE_PX
): MessageWindow {
  if (stickyEnd <= stickyStart) return needed;
  let start = Math.min(needed.start, stickyStart);
  let end = Math.max(needed.end, stickyEnd);
  const extraTop =
    messageOffset(heights, needed.start, estimatedHeight) -
    messageOffset(heights, start, estimatedHeight);
  const extraBottom =
    messageOffset(heights, end, estimatedHeight) -
    messageOffset(heights, needed.end, estimatedHeight);
  if (extraTop > releasePx) start = needed.start;
  if (extraBottom > releasePx) end = needed.end;
  if (start === needed.start && end === needed.end) return needed;
  return {
    ...needed,
    start,
    end,
    paddingTop: messageOffset(heights, start, estimatedHeight),
    paddingBottom: Math.max(0, needed.totalHeight - messageOffset(heights, end, estimatedHeight)),
  };
}

/** Scroll offset of a row from the top of the transcript. */
export function messageOffset(
  heights: readonly (number | undefined)[],
  index: number,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
) {
  let offset = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    offset += rowHeight(heights[cursor], estimatedHeight);
  }
  return offset;
}

/**
 * How much content fully above the viewport grew or shrank.
 * A row that straddles `anchor` is skipped: treating it as "above" adds its
 * growth to scrollTop and shoves the card the user is looking at downward.
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
    if (offset + before <= anchor) {
      delta += after - before;
    }
    offset += before;
    if (offset >= anchor) break;
  }
  return delta;
}

/** First unmeasured row in [start, end). Skips the live streaming tail. */
export function firstUnmeasuredIndex(
  start: number,
  end: number,
  heights: readonly (number | undefined)[],
  skipLast = false,
  count = heights.length
) {
  const lastIndex = count - 1;
  const until = Math.min(end, count);
  for (let index = Math.max(0, start); index < until; index++) {
    if (skipLast && index === lastIndex) continue;
    if (heights[index] === undefined) return index;
  }
  return -1;
}

/**
 * Grow a short window to a full history chunk, expanding toward older rows
 * so scrolling up loads a batch instead of one card at a time.
 */
export function expandHistoryChunk(
  range: MessageWindow,
  count: number,
  heights: readonly (number | undefined)[],
  chunk = HISTORY_CHUNK,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
): MessageWindow {
  const span = range.end - range.start;
  let start = range.start;
  let end = range.end;
  if (span < chunk) {
    start = Math.max(0, start - (chunk - span));
    end = Math.min(count, Math.max(end, start + chunk));
  }
  if (start === range.start && end === range.end) return range;
  return retargetWindow(range, start, end, heights, estimatedHeight);
}

function retargetWindow(
  range: MessageWindow,
  start: number,
  end: number,
  heights: readonly (number | undefined)[],
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
): MessageWindow {
  return {
    ...range,
    start,
    end,
    paddingTop: messageOffset(heights, start, estimatedHeight),
    paddingBottom: Math.max(0, range.totalHeight - messageOffset(heights, end, estimatedHeight)),
  };
}

/**
 * Cap sticky extras, but never shrink below the needed window. A tight cap
 * that recenters on the viewport unmounts cards still on screen.
 */
export function limitMountedWindow(
  range: MessageWindow,
  needed: MessageWindow,
  maxRows: number,
  heights: readonly (number | undefined)[],
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
): MessageWindow {
  const neededSpan = Math.max(0, needed.end - needed.start);
  const budget = Math.max(maxRows, neededSpan);
  if (range.end - range.start <= budget) return range;

  let start = range.start;
  let end = range.end;
  let overflow = end - start - budget;
  const trimTopBudget = Math.max(0, needed.start - start);
  const trimBottomBudget = Math.max(0, end - needed.end);
  const trimTotal = Math.max(1, trimTopBudget + trimBottomBudget);
  const trimTop = Math.min(trimTopBudget, Math.round((overflow * trimTopBudget) / trimTotal));
  start += trimTop;
  overflow -= trimTop;
  end -= Math.min(trimBottomBudget, overflow);
  start = Math.min(start, needed.start);
  end = Math.max(end, needed.end);
  if (start === range.start && end === range.end) return range;
  return retargetWindow(range, start, end, heights, estimatedHeight);
}

/** Row that contains a scroll offset, plus how far into that row the offset is. */
export function rowAtScrollOffset(
  heights: readonly (number | undefined)[],
  offset: number,
  count: number,
  estimatedHeight = ESTIMATED_MESSAGE_HEIGHT
): { index: number; inner: number } {
  if (count <= 0) return { index: 0, inner: Math.max(0, offset) };
  let y = 0;
  for (let index = 0; index < count; index++) {
    const height = rowHeight(heights[index], estimatedHeight);
    if (y + height > offset || index === count - 1) {
      return { index, inner: offset - y };
    }
    y += height;
  }
  return { index: 0, inner: Math.max(0, offset) };
}
