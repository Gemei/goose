const MIN_MS = 200;
const MAX_MS = 320;
const LINE_HEIGHT_PX = 40;
// Seconds to close ~63% of the remaining distance. A duration tween that
// restarted on every notch punched the motion; this keeps one glide going.
const WHEEL_TAU_S = 0.28;

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

const wheelControllers = new WeakMap<HTMLElement, () => void>();

export function prefersInstantScroll() {
  if (typeof window === 'undefined') return true;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return true;
  return false;
}

export function isDiscreteMouseWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) return false;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return false;
  if (event.deltaMode === 1 || event.deltaMode === 2) return true;
  const dy = Math.abs(event.deltaY);
  if (dy < 80) return false;
  return dy % 100 === 0 || dy % 120 === 0;
}

export function wheelDeltaPixels(event: WheelEvent, viewport: HTMLElement) {
  if (event.deltaMode === 1) return event.deltaY * LINE_HEIGHT_PX;
  if (event.deltaMode === 2) return event.deltaY * viewport.clientHeight;
  return event.deltaY;
}

export function smoothScrollTo(element: HTMLElement, top: number): () => void {
  const target = Math.max(0, top);
  const start = element.scrollTop;
  const distance = target - start;
  if (Math.abs(distance) < 2 || prefersInstantScroll()) {
    element.scrollTop = target;
    return () => undefined;
  }

  let frame = 0;
  let cancelled = false;
  const started = performance.now();
  const duration = Math.min(MAX_MS, Math.max(MIN_MS, Math.abs(distance) * 0.12));

  const step = (now: number) => {
    if (cancelled) return;
    const t = Math.min(1, (now - started) / duration);
    element.scrollTop = start + distance * easeOutQuart(t);
    if (t < 1) frame = window.requestAnimationFrame(step);
  };
  frame = window.requestAnimationFrame(step);

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
  };
}

export function cancelWheelSmoothing(element: HTMLElement) {
  wheelControllers.get(element)?.();
}

export function attachWheelSmoothing(element: HTMLElement): () => void {
  cancelWheelSmoothing(element);

  let frame = 0;
  let target = element.scrollTop;
  let lastTime = 0;
  let animating = false;

  const maxTop = () => Math.max(0, element.scrollHeight - element.clientHeight);

  const stop = () => {
    if (!animating) return;
    window.cancelAnimationFrame(frame);
    animating = false;
    target = element.scrollTop;
  };

  const step = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    const remaining = target - element.scrollTop;
    if (Math.abs(remaining) < 0.4) {
      element.scrollTop = target;
      animating = false;
      return;
    }
    const k = 1 - Math.exp(-dt / WHEEL_TAU_S);
    element.scrollTop += remaining * k;
    frame = window.requestAnimationFrame(step);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !event.cancelable) return;
    if (!isDiscreteMouseWheel(event)) {
      stop();
      return;
    }
    event.preventDefault();
    const delta = wheelDeltaPixels(event, element);
    if (!animating) target = element.scrollTop;
    target = Math.max(0, Math.min(maxTop(), target + delta));
    if (prefersInstantScroll() || Math.abs(target - element.scrollTop) < 2) {
      stop();
      element.scrollTop = target;
      return;
    }
    if (animating) return;
    animating = true;
    lastTime = performance.now();
    frame = window.requestAnimationFrame(step);
  };

  wheelControllers.set(element, stop);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('pointerdown', stop);

  return () => {
    stop();
    wheelControllers.delete(element);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('pointerdown', stop);
  };
}
