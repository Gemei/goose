import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachWheelSmoothing,
  configureScrollAnimations,
  isDiscreteMouseWheel,
  isWheelGlideActive,
  prefersInstantScroll,
  shouldAnimateScroll,
  smoothScrollTo,
  wheelDeltaPixels,
} from './smoothScroll';

describe('smoothScrollTo', () => {
  it('jumps immediately in jsdom', () => {
    expect(prefersInstantScroll()).toBe(true);
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: 0 });
    smoothScrollTo(element, 800);
    expect(element.scrollTop).toBe(800);
  });
});

describe('isDiscreteMouseWheel', () => {
  it('treats 100px and 120px Chromium notches as mouse wheel', () => {
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 100 }))).toBe(true);
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: -120 }))).toBe(true);
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 240 }))).toBe(true);
  });

  it('treats line and page deltas as mouse wheel', () => {
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }))).toBe(true);
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 1, deltaMode: 2 }))).toBe(true);
  });

  it('leaves trackpad pixel streams alone', () => {
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 18 }))).toBe(false);
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 7.5 }))).toBe(false);
    expect(isDiscreteMouseWheel(new WheelEvent('wheel', { deltaY: 40 }))).toBe(false);
  });
});

describe('attachWheelSmoothing', () => {
  const elements: HTMLElement[] = [];

  beforeEach(() => {
    // These tests exercise the animated path; the product default is off.
    configureScrollAnimations(true);
  });

  afterEach(() => {
    for (const element of elements) element.remove();
    elements.length = 0;
  });

  function viewport(scrollTop = 400) {
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      writable: true,
      value: scrollTop,
    });
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 4000 });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 });
    document.body.appendChild(element);
    elements.push(element);
    return element;
  }

  it('leaves discrete wheels to the browser when instant scrolling is preferred', () => {
    const element = viewport(400);
    const detach = attachWheelSmoothing(element);
    const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(element.scrollTop).toBe(400);
    detach();
  });

  it('leaves discrete wheels to the browser when scroll animations are disabled', () => {
    const element = viewport(400);
    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('test-browser');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    try {
      configureScrollAnimations(false);
      expect(shouldAnimateScroll()).toBe(false);

      const detach = attachWheelSmoothing(element);
      const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
      element.dispatchEvent(event);
      // Native scrolling handles the notch; the glide must not intercept it
      // or apply its own animated move.
      expect(event.defaultPrevented).toBe(false);
      expect(element.scrollTop).toBe(400);
      expect(isWheelGlideActive(element)).toBe(false);
      detach();
    } finally {
      window.matchMedia = originalMatchMedia;
      userAgentSpy.mockRestore();
    }
  });

  it('does not steal trackpad pixel deltas', () => {
    const element = viewport(400);
    const detach = attachWheelSmoothing(element);
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 18, cancelable: true }));
    expect(element.scrollTop).toBe(400);
    detach();
  });

  it('ends a glide once wheel input stops, even if the tween cannot converge', () => {
    const element = viewport(400);
    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('test-browser');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const originalRaf = window.requestAnimationFrame;
    const frames: Array<(time: number) => void> = [];
    window.requestAnimationFrame = ((cb: (time: number) => void) => {
      frames.push(cb);
      return frames.length;
    }) as typeof window.requestAnimationFrame;

    let now = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);

    try {
      const detach = attachWheelSmoothing(element);
      expect(prefersInstantScroll()).toBe(false);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
      expect(isWheelGlideActive(element)).toBe(true);

      now += 16;
      frames.shift()?.(now);
      expect(isWheelGlideActive(element)).toBe(true);

      // Scroll anchoring / content-visibility conversions keep moving scrollTop
      // so the remaining distance never settles. Without a wheel event the
      // glide must still give up instead of dragging the viewport forever.
      element.scrollTop = 300;
      now += 300;
      frames.shift()?.(now);
      expect(isWheelGlideActive(element)).toBe(false);
      expect(frames).toHaveLength(0);

      detach();
    } finally {
      nowSpy.mockRestore();
      window.requestAnimationFrame = originalRaf;
      window.matchMedia = originalMatchMedia;
      userAgentSpy.mockRestore();
    }
  });

  it('lands on the wheel target once input goes idle', () => {
    const element = viewport(400);
    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('test-browser');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const originalRaf = window.requestAnimationFrame;
    const frames: Array<(time: number) => void> = [];
    window.requestAnimationFrame = ((cb: (time: number) => void) => {
      frames.push(cb);
      return frames.length;
    }) as typeof window.requestAnimationFrame;

    let now = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);

    try {
      const detach = attachWheelSmoothing(element);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
      expect(element.scrollTop).toBe(400);

      for (let i = 0; i < 40 && frames.length > 0; i += 1) {
        now += 16;
        frames.shift()?.(now);
      }

      // The exponential tail is snapped to the requested target instead of
      // stopping short when the wheel goes idle.
      expect(element.scrollTop).toBe(520);
      expect(isWheelGlideActive(element)).toBe(false);
      detach();
    } finally {
      nowSpy.mockRestore();
      window.requestAnimationFrame = originalRaf;
      window.matchMedia = originalMatchMedia;
      userAgentSpy.mockRestore();
    }
  });

  it('stops instead of chasing its target when layout moves the viewport', () => {
    const element = viewport(400);
    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('test-browser');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const originalRaf = window.requestAnimationFrame;
    const frames: Array<(time: number) => void> = [];
    window.requestAnimationFrame = ((cb: (time: number) => void) => {
      frames.push(cb);
      return frames.length;
    }) as typeof window.requestAnimationFrame;

    let now = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);

    try {
      const detach = attachWheelSmoothing(element);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, cancelable: true }));

      now += 16;
      frames.shift()?.(now);
      expect(isWheelGlideActive(element)).toBe(true);
      const applied = element.scrollTop;

      // A content-visibility conversion / scroll anchoring moves the viewport
      // further up than the glide target. The remaining distance to the old
      // target points down; the glide must give up instead of easing back.
      element.scrollTop = applied - 200;
      now += 16;
      frames.shift()?.(now);

      expect(element.scrollTop).toBe(applied - 200);
      expect(isWheelGlideActive(element)).toBe(false);
      expect(frames).toHaveLength(0);
      detach();
    } finally {
      nowSpy.mockRestore();
      window.requestAnimationFrame = originalRaf;
      window.matchMedia = originalMatchMedia;
      userAgentSpy.mockRestore();
    }
  });

  it('stops at the scroll ceiling without reading scrollHeight each frame', () => {
    const element = viewport(900);
    let top = 900;
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (next: number) => {
        top = Math.min(1000, next);
      },
    });
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => {
        throw new Error('scrollHeight must not be read during a glide');
      },
    });

    const userAgentSpy = vi
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue('test-browser');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const originalRaf = window.requestAnimationFrame;
    const frames: Array<(time: number) => void> = [];
    window.requestAnimationFrame = ((cb: (time: number) => void) => {
      frames.push(cb);
      return frames.length;
    }) as typeof window.requestAnimationFrame;

    let now = 1000;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);

    try {
      const detach = attachWheelSmoothing(element);
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, cancelable: true }));
      expect(top).toBe(900);

      for (let i = 0; i < 20 && frames.length > 0; i += 1) {
        now += 16;
        frames.shift()?.(now);
      }

      expect(top).toBe(1000);
      expect(frames).toHaveLength(0);
      expect(isWheelGlideActive(element)).toBe(false);
      detach();
    } finally {
      nowSpy.mockRestore();
      window.requestAnimationFrame = originalRaf;
      window.matchMedia = originalMatchMedia;
      userAgentSpy.mockRestore();
    }
  });

  it('converts line-mode notches into pixels', () => {
    const element = viewport();
    expect(wheelDeltaPixels(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }), element)).toBe(
      120
    );
  });
});
