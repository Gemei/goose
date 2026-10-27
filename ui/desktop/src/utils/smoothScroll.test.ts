import { afterEach, describe, expect, it } from 'vitest';
import {
  attachWheelSmoothing,
  isDiscreteMouseWheel,
  prefersInstantScroll,
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

  it('applies a discrete notch immediately in jsdom', () => {
    const element = viewport(400);
    const detach = attachWheelSmoothing(element);
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, cancelable: true }));
    expect(element.scrollTop).toBe(520);
    detach();
  });

  it('does not steal trackpad pixel deltas', () => {
    const element = viewport(400);
    const detach = attachWheelSmoothing(element);
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 18, cancelable: true }));
    expect(element.scrollTop).toBe(400);
    detach();
  });

  it('converts line-mode notches into pixels', () => {
    const element = viewport();
    expect(wheelDeltaPixels(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1 }), element)).toBe(
      120
    );
  });
});
