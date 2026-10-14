import { describe, expect, it } from 'vitest';
import { heightDeltaAbove, messageOffset, messageWindow } from './messageWindow';

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

  it('shifts only for rows that sit fully above the viewport', () => {
    expect(heightDeltaAbove([160, 160, 160], [40, 160, 400], 160)).toBe(-120);
    expect(heightDeltaAbove([160, 160], [160, 400], 160)).toBe(0);
    expect(messageOffset([40, 80, 10], 2)).toBe(120);
  });
});
