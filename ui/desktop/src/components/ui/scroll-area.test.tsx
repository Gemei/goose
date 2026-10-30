import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ScrollArea } from './scroll-area';
import { endUserGesture, endUserInput } from '../../utils/smoothScroll';

// Radix ScrollArea internals observe thumb sizes; jsdom ships no
// ResizeObserver and the pinned-content check bails without one.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = NoopResizeObserver;

interface Fixture {
  followCalls: boolean[];
  viewport: HTMLElement;
  unmount: () => void;
}

function renderScrollArea(): Fixture {
  const followCalls: boolean[] = [];

  function Harness() {
    return (
      <ScrollArea
        className="w-10 h-10"
        type="always"
        onScrollChange={(atBottom) => followCalls.push(atBottom)}
      >
        <div style={{ height: 1000 }} />
      </ScrollArea>
    );
  }

  const { container, unmount } = render(<Harness />);
  const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
  if (!viewport) throw new Error('viewport missing');
  Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
  return { followCalls, viewport, unmount };
}

const scroll = (viewport: HTMLElement, top: number) => {
  viewport.scrollTop = top;
  viewport.dispatchEvent(new Event('scroll'));
};

// A real upward gesture: wheel input stamps the gesture clock, then the
// browser moves scrollTop. A scrollTop delta alone is indistinguishable from
// scroll anchoring and must not count as user intent.
const wheelUp = (viewport: HTMLElement, deltaY = -40) => {
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
};

describe('ScrollArea follow state', () => {
  beforeEach(() => {
    // The gesture/input clocks are module state shared by every test in this
    // file; a wheel in one test must not classify a delta in the next.
    endUserGesture();
    endUserInput();
  });

  it('does not pin content growth over a fresh wheel tick', async () => {
    let contentHeight = 1000;
    const followCalls: boolean[] = [];

    function Harness({ height }: { height: number }) {
      return (
        <ScrollArea
          className="w-10 h-10"
          type="always"
          autoScroll
          onScrollChange={(atBottom) => followCalls.push(atBottom)}
        >
          <div style={{ height }} />
        </ScrollArea>
      );
    }

    const { container, rerender } = render(<Harness height={1000} />);
    const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) throw new Error('viewport missing');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });
    viewport.scrollTo = (({ top }: { top?: number }) => {
      viewport.scrollTop = top ?? 0;
    }) as typeof viewport.scrollTo;

    await act(async () => {
      viewport.scrollTop = contentHeight - viewport.clientHeight;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const bottomBefore = viewport.scrollTop;

    // The wheel lands, then async content growth resizes the transcript
    // before the coalesced handler runs. The growth pin must yield, or it
    // resets scrollTop and the handler never sees the user's move.
    await act(async () => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -40, bubbles: true, cancelable: true })
      );
      contentHeight = 1600;
      rerender(<Harness height={1600} />);
    });
    expect(viewport.scrollTop).toBe(bottomBefore);
  });

  it('does not follow content growth while hydration suspends follow', async () => {
    const followCalls: boolean[] = [];
    let contentHeight = 1000;

    function Harness({ height, suspend }: { height: number; suspend: boolean }) {
      return (
        <ScrollArea
          className="w-10 h-10"
          type="always"
          autoScroll
          suspendFollow={suspend}
          onScrollChange={(atBottom) => followCalls.push(atBottom)}
        >
          <div style={{ height }} />
        </ScrollArea>
      );
    }

    const { container, rerender } = render(<Harness height={1000} suspend />);
    const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
    if (!viewport) throw new Error('viewport missing');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });
    viewport.scrollTo = (({ top }: { top?: number }) => {
      viewport.scrollTop = top ?? 0;
    }) as typeof viewport.scrollTo;

    // Hydration mounts earlier batches: the transcript grows while the user
    // is somewhere in the middle. That must not pin the viewport down.
    contentHeight = 2600;
    await act(async () => {
      rerender(<Harness height={2600} suspend />);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(viewport.scrollTop).toBe(0);
  });

  it('keeps following a fresh in-band nudge and detaches once settled', async () => {
    const { followCalls, viewport, unmount } = renderScrollArea();
    const bottom = () => viewport.scrollHeight - viewport.clientHeight;

    await act(async () => {
      scroll(viewport, bottom());
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    // Attaching at the bottom is not a user-departure callback.
    expect(followCalls).toEqual([]);

    await act(async () => {
      wheelUp(viewport);
      scroll(viewport, bottom() - 20);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    // Within the resume band the attach state does not flip right away; the
    // settle decides once the gesture goes quiet.
    expect(followCalls).toEqual([]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(followCalls).toEqual([false]);

    // Returning to the exact bottom re-attaches.
    await act(async () => {
      scroll(viewport, bottom());
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(followCalls).toEqual([false, true]);
    unmount();
  });

  it('detaches immediately when the nudge leaves the resume band', async () => {
    const { followCalls, viewport, unmount } = renderScrollArea();
    const bottom = () => viewport.scrollHeight - viewport.clientHeight;

    await act(async () => {
      scroll(viewport, bottom());
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      wheelUp(viewport);
      scroll(viewport, bottom() - 120);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(followCalls).toEqual([false]);
    unmount();
  });

  it('ignores upward deltas that come from scroll anchoring, not the user', async () => {
    const { followCalls, viewport, unmount } = renderScrollArea();
    const bottom = () => viewport.scrollHeight - viewport.clientHeight;

    await act(async () => {
      scroll(viewport, bottom());
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    // A row above the viewport converting from its content-visibility
    // estimate moves scrollTop up with no input event. Follow must survive so
    // the next streaming growth tick keeps the viewport pinned.
    await act(async () => {
      scroll(viewport, bottom() - 120);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(followCalls).toEqual([]);
    unmount();
  });

  it('does not replay a user scroll as an anchor correction', async () => {
    const observers: Array<() => void> = [];
    const Original = (globalThis as Record<string, unknown>).ResizeObserver;
    class CapturingResizeObserver {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as Record<string, unknown>).ResizeObserver = CapturingResizeObserver;

    const originalFromPoint = document.elementsFromPoint;
    try {
      const followCalls: boolean[] = [];
      const { container, unmount } = render(
        <ScrollArea
          className="w-10 h-10"
          type="always"
          onScrollChange={(atBottom) => followCalls.push(atBottom)}
        >
          <div data-message-index="0">row</div>
        </ScrollArea>
      );
      const viewport = container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]');
      const row = container.querySelector<HTMLElement>('[data-message-index]');
      if (!viewport || !row) throw new Error('fixture missing');
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
      let rowTop = 10;
      viewport.getBoundingClientRect = () =>
        ({ top: 0, bottom: 400, left: 0, right: 100, width: 100, height: 400 }) as DOMRect;
      row.getBoundingClientRect = () =>
        ({
          top: rowTop,
          bottom: rowTop + 100,
          left: 0,
          right: 100,
          width: 100,
          height: 100,
        }) as DOMRect;
      document.elementsFromPoint = () => [row];

      // Settle at the bottom so the anchor is captured at scrollTop 600.
      await act(async () => {
        viewport.scrollTop = 600;
        viewport.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 80));
      });

      // The user scrolls up 300px. The row's viewport position moves down by
      // the same amount, so an anchor correction computed from the old
      // capture would add 300 back — undoing the gesture.
      await act(async () => {
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 18, bubbles: true }));
        viewport.scrollTop = 300;
        rowTop = 310;
        viewport.dispatchEvent(new Event('scroll'));
      });
      await act(async () => {
        for (const fire of observers) fire();
        await new Promise((resolve) => setTimeout(resolve, 40));
      });

      expect(viewport.scrollTop).toBe(300);
      unmount();
    } finally {
      document.elementsFromPoint = originalFromPoint;
      (globalThis as Record<string, unknown>).ResizeObserver = Original;
    }
  });

  it('a settle that lands at the exact bottom keeps following', async () => {
    const { followCalls, viewport, unmount } = renderScrollArea();
    const bottom = () => viewport.scrollHeight - viewport.clientHeight;

    await act(async () => {
      scroll(viewport, bottom());
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      wheelUp(viewport);
      scroll(viewport, bottom() - 20);
      await new Promise((resolve) => setTimeout(resolve, 20));
      scroll(viewport, bottom());
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    // The nudge never settled above the bottom, so follow never detached.
    expect(followCalls).toEqual([]);
    unmount();
  });
});
