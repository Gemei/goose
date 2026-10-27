import { describe, expect, it } from 'vitest';
import {
  assignedRowTop,
  assignRowTops,
  estimateRowHeight,
  expandHistoryChunk,
  firstUnmeasuredIndex,
  heightDeltaAbove,
  HISTORY_CHUNK,
  limitMountedWindow,
  messageOffset,
  messageWindow,
  rowAtScrollOffset,
  stabilizeWindow,
} from './messageWindow';

describe('messageWindow', () => {
  it('keeps the full transcript height while mounting only the visible tail', () => {
    const windowRange = messageWindow({
      count: 80,
      scrollTop: 0,
      viewportHeight: 0,
      heights: [],
      pinToBottom: true,
    });

    expect(windowRange.totalHeight).toBe(80 * 160);
    expect(windowRange.end).toBe(80);
    expect(windowRange.start).toBeGreaterThan(0);
    expect(windowRange.paddingTop).toBeGreaterThan(0);
    expect(windowRange.end - windowRange.start).toBeLessThan(40);
  });

  it('mounts the scrolled-to portion without dropping the rows above or below it', () => {
    const windowRange = messageWindow({
      count: 80,
      scrollTop: 1600,
      viewportHeight: 400,
      heights: [],
      pinToBottom: false,
    });

    expect(windowRange.totalHeight).toBe(80 * 160);
    expect(windowRange.start).toBeLessThan(10);
    expect(windowRange.end).toBeGreaterThan(10);
    expect(windowRange.end).toBeLessThan(80);
    expect(windowRange.paddingTop + windowRange.paddingBottom).toBeGreaterThan(0);
  });

  it('clamps a stale scroll offset so the tail stays mounted', () => {
    const windowRange = messageWindow({
      count: 80,
      scrollTop: 50000,
      viewportHeight: 400,
      heights: [],
      pinToBottom: false,
    });

    expect(windowRange.end).toBe(80);
    expect(windowRange.start).toBeLessThan(80);
    expect(windowRange.end - windowRange.start).toBeGreaterThan(0);
  });

  it('uses a measured height instead of the estimate', () => {
    const estimated = messageWindow({
      count: 2,
      scrollTop: 0,
      viewportHeight: 500,
      heights: [],
      pinToBottom: false,
    });
    const measured = messageWindow({
      count: 2,
      scrollTop: 0,
      viewportHeight: 500,
      heights: [40, 40],
      pinToBottom: false,
    });

    expect(estimated.totalHeight).toBe(320);
    expect(measured.totalHeight).toBe(80);
    expect(measured.start).toBe(0);
    expect(measured.end).toBe(2);
  });

  it('keeps extra mounted rows until they are far from the viewport', () => {
    const needed = messageWindow({
      count: 80,
      scrollTop: 1600,
      viewportHeight: 400,
      heights: [],
      pinToBottom: false,
    });
    const sticky = stabilizeWindow(needed, 0, 40, []);
    expect(sticky.start).toBe(0);
    expect(sticky.end).toBe(Math.max(needed.end, 40));

    const jumped = messageWindow({
      count: 80,
      scrollTop: 0,
      viewportHeight: 400,
      heights: [],
      pinToBottom: false,
    });
    const released = stabilizeWindow(jumped, 50, 80, [], 160, 4000);
    expect(released.start).toBe(jumped.start);
    expect(released.end).toBe(jumped.end);
  });

  it('shifts only for rows that sit fully above the viewport', () => {
    expect(heightDeltaAbove([160, 160, 160], [40, 160, 400], 160)).toBe(-120);
    expect(heightDeltaAbove([160, 160], [160, 400], 160)).toBe(0);
    expect(heightDeltaAbove([160, 160, 160], [400, 160, 160], 100)).toBe(0);
    expect(messageOffset([40, 80, 10], 2)).toBe(120);
  });

  it('loads a short window as a full history chunk toward older rows', () => {
    const needed = messageWindow({
      count: 80,
      scrollTop: 8000,
      viewportHeight: 400,
      heights: [],
      pinToBottom: false,
    });
    const short = { ...needed, start: 50, end: 55 };
    const expanded = expandHistoryChunk(short, 80, []);
    expect(expanded.end - expanded.start).toBe(HISTORY_CHUNK);
    expect(expanded.start).toBe(35);
    expect(expanded.end).toBe(55);
    expect(expanded.paddingTop).toBe(35 * 160);
  });

  it('finds the first unmeasured row and skips the streaming tail', () => {
    expect(firstUnmeasuredIndex(0, 3, [40, undefined, undefined])).toBe(1);
    expect(firstUnmeasuredIndex(0, 3, [undefined, 40, undefined], true, 3)).toBe(0);
    expect(firstUnmeasuredIndex(0, 3, [40, 40, undefined], true, 3)).toBe(-1);
  });

  it('caps mounted rows around the viewport without dropping what is on screen', () => {
    const needed = messageWindow({
      count: 80,
      scrollTop: 1600,
      viewportHeight: 400,
      heights: [],
      pinToBottom: false,
    });
    const sticky = stabilizeWindow(needed, 0, 80, [], 160, 20000);
    expect(sticky.end - sticky.start).toBe(80);
    const limited = limitMountedWindow(sticky, needed, 40, []);
    expect(limited.start).toBeLessThanOrEqual(needed.start);
    expect(limited.end).toBeGreaterThanOrEqual(needed.end);
    expect(limited.end - limited.start).toBeLessThanOrEqual(
      Math.max(40, needed.end - needed.start)
    );
  });

  it('maps a scroll offset back to the row that contains it', () => {
    expect(rowAtScrollOffset([100, 100, 100], 150, 3)).toEqual({ index: 1, inner: 50 });
    expect(rowAtScrollOffset([], 80, 0)).toEqual({ index: 0, inner: 80 });
  });

  it('grows a newly mounted row upward without moving the next row', () => {
    const assigned = new Map<number, number>([[2, 320]]);
    expect(assignedRowTop(1, [160, 160, 160], assigned)).toBe(160);
    expect(assigned.get(2)).toBe(320);
    expect(assignedRowTop(1, [160, 400, 160], assigned)).toBe(-80);
    expect(assigned.get(2)).toBe(320);
    expect(assignedRowTop(3, [160, 400, 160, 160], assigned)).toBe(480);
    expect(assigned.get(2)).toBe(320);
  });

  it('keeps already placed rows still while a new row above grows upward', () => {
    const previous = new Map([
      [2, 320],
      [3, 480],
    ]);
    const next = assignRowTops(1, 4, [160, 400, 160, 160], previous);
    expect(next.get(1)).toBe(-80);
    expect(next.get(2)).toBe(320);
    expect(next.get(3)).toBe(480);
  });

  it('estimates a numeric height from text, images, and tools', () => {
    expect(estimateRowHeight()).toBe(160);
    expect(estimateRowHeight({ textLength: 20 })).toBeGreaterThanOrEqual(72);
    expect(estimateRowHeight({ textLength: 20 })).toBeLessThan(
      estimateRowHeight({ textLength: 2000 })
    );
    expect(estimateRowHeight({ toolCount: 3 })).toBeGreaterThan(
      estimateRowHeight({ textLength: 20 })
    );
    expect(estimateRowHeight({ textLength: 100000, imageCount: 8, toolCount: 20 })).toBe(1200);
  });

  it('pins the first row at 0 when the window includes the start', () => {
    const previous = new Map([
      [1, 160],
      [2, 320],
    ]);
    const next = assignRowTops(0, 3, [400, 160, 160], previous);
    expect(next.get(0)).toBe(0);
    expect(next.get(1)).toBe(400);
    expect(next.get(2)).toBe(560);
  });
});
