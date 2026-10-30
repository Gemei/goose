import { logScrollMark } from './scrollDiagnostics';

const MIN_MS = 200;
const MAX_MS = 320;
const LINE_HEIGHT_PX = 40;
// Seconds to close ~63% of the remaining distance. A duration tween that
// restarted on every notch punched the motion; this keeps one glide going.
const WHEEL_TAU_S = 0.1;
// A glide exists to carry a wheel gesture, not to chase layout. Content
// changes move scrollTop/scrollHeight every frame (scroll anchoring around
// content-visibility conversions, streaming growth), so the convergence test
// can stay above the epsilon forever and the animation would keep dragging the
// viewport with no input. Bound it by the last wheel event and a hard cap.
const GLIDE_INPUT_IDLE_MS = 250;
const GLIDE_MAX_MS = 600;
// An exponential ease never quite reaches its target. Once the wheel has gone
// idle, snap the last few pixels so a notch lands where the wheel asked instead
// of stopping ~8% short. Small enough to be imperceptible at the stop.
const GLIDE_SNAP_PX = 4;

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

// A user-driven upward move that stops parked above the exact bottom detaches
// follow after this quiet window (streaming flushes re-glue first while the
// turn is actively emitting; an idle read settles into detached mode).
export const READING_SETTLE_MS = 150;

interface WheelGlide {
  stop: () => void;
  isAnimating: () => boolean;
}

const wheelControllers = new WeakMap<HTMLElement, WheelGlide>();

// Timestamp of the last live glide frame. Lets render-side work (streaming
// text flushes) hold while a glide owns the frame budget. Starts at -Infinity
// so the "busy" window is false before the first real glide.
let lastGlideStepMs = -Infinity;
// Last real discrete-wheel input. Shared by all viewports: the chat has one
// scroller and a stale glide on another must not count as user movement here.
let lastWheelInputMs = -Infinity;

export function wheelGlideBusy(): boolean {
  return performance.now() - lastGlideStepMs < 250;
}

// Timestamped by pointer/touch input and by coalesced scroll reads that
// classify a real departure from the live edge (movedUp && !atLiveEdge).
// Follow pins move down, so their own programmatic scroll events never
// register here — a pin that counted as user scrolling would block the next
// pin, and active streaming growth would starve the follower itself.
let lastUserGestureMs = -Infinity;

export function noteUserGesture(): void {
  lastUserGestureMs = performance.now();
}

export function userGestureRecent(withinMs: number): boolean {
  return performance.now() - lastUserGestureMs < withinMs;
}

// Timestamped only by real input events (wheel/pointer/touch). A scrollTop
// delta alone cannot distinguish the user from scroll anchoring: a card above
// the viewport converting from its content-visibility estimate, or growing
// taller after async markdown, moves scrollTop with no user intent. Those
// corrections must not stamp the gesture clock or detach follow.
let lastUserInputMs = -Infinity;

export function noteUserInput(): void {
  lastUserInputMs = performance.now();
}

export function userInputRecent(withinMs: number): boolean {
  return performance.now() - lastUserInputMs < withinMs;
}

// Tests (and window blur) release the input clock so a stale gesture cannot
// classify unrelated scroll deltas.
export function endUserInput(): void {
  lastUserInputMs = -Infinity;
}

// Rejoining the live edge is a deliberate re-attach: release the post-gesture
// hold right away so the next streaming flush glues immediately instead of
// waiting out the window while the user is already parked at the bottom.
export function endUserGesture(): void {
  lastUserGestureMs = -Infinity;
}

// Product default: scroll animations are opt-in. The desktop setting is
// loaded before first paint and toggled from Settings -> App -> Appearance.
let scrollAnimationsEnabled = false;

export function configureScrollAnimations(enabled: boolean): void {
  scrollAnimationsEnabled = enabled;
}

export function prefersInstantScroll() {
  if (typeof window === 'undefined') return true;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return true;
  return false;
}

// Animation paths only. Hydration/pre-warm heuristics keep using
// `prefersInstantScroll()` so disabling animations does not also disable the
// virtualization pipeline.
export function shouldAnimateScroll(): boolean {
  return scrollAnimationsEnabled && !prefersInstantScroll();
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

export function smoothScrollTo(element: HTMLElement, top: number, onDone?: () => void): () => void {
  const target = Math.max(0, top);
  const start = element.scrollTop;
  const distance = target - start;
  if (Math.abs(distance) < 2 || !shouldAnimateScroll()) {
    element.scrollTop = target;
    onDone?.();
    return () => undefined;
  }

  let frame = 0;
  let cancelled = false;
  const started = performance.now();
  const duration = Math.min(MAX_MS, Math.max(MIN_MS, Math.abs(distance) * 0.12));

  const step = (now: number) => {
    if (cancelled) return;
    if (!shouldAnimateScroll()) {
      element.scrollTop = target;
      onDone?.();
      return;
    }
    const t = Math.min(1, (now - started) / duration);
    element.scrollTop = start + distance * easeOutQuart(t);
    if (t < 1) {
      frame = window.requestAnimationFrame(step);
    } else {
      onDone?.();
    }
  };
  frame = window.requestAnimationFrame(step);

  return () => {
    // Interruptions cancel without onDone: the interrupting path clears the
    // tween state itself (this returned stop is only called by the owner).
    cancelled = true;
    window.cancelAnimationFrame(frame);
  };
}

export function cancelWheelSmoothing(element: HTMLElement) {
  wheelControllers.get(element)?.stop();
}

export function isWheelGlideActive(element: HTMLElement): boolean {
  if (typeof performance === 'undefined') return false;
  // Even if a glide is still stepping, it stops counting as user movement once
  // no wheel event has arrived for a while.
  if (performance.now() - lastWheelInputMs >= GLIDE_INPUT_IDLE_MS) return false;
  return wheelControllers.get(element)?.isAnimating() ?? false;
}

export function attachWheelSmoothing(element: HTMLElement): () => void {
  cancelWheelSmoothing(element);

  let frame = 0;
  let target = element.scrollTop;
  let lastTime = 0;
  let animating = false;
  let gestureStartedMs = 0;
  // Last scrollTop this glide wrote. If the viewport is somewhere else on the
  // next frame, something external moved it (scroll anchoring around
  // content-visibility conversions, a follow pin, a tween) and the remaining
  // distance to the old target points back against that movement.
  let lastAppliedTop = element.scrollTop;

  const stop = () => {
    if (!animating) return;
    window.cancelAnimationFrame(frame);
    animating = false;
    target = element.scrollTop;
    logScrollMark('glide.end', { reason: 'stopped' });
  };

  const step = (now: number) => {
    const nowMs = performance.now();
    if (!scrollAnimationsEnabled) {
      element.scrollTop = target;
      lastAppliedTop = target;
      animating = false;
      logScrollMark('glide.end', { reason: 'disabled', duration: nowMs - gestureStartedMs });
      return;
    }
    const sinceInput = nowMs - lastWheelInputMs;
    const currentTop = element.scrollTop;
    if (Math.abs(currentTop - lastAppliedTop) > 1.5) {
      // The viewport was moved out from under the glide. Chasing the old
      // target would scroll back against that movement (the visible "scroll
      // up, then nudge down" when rows above re-measure mid-gesture). Adopt
      // the new position and stop; the next wheel notch starts a fresh glide.
      animating = false;
      target = currentTop;
      logScrollMark('glide.end', {
        reason: 'rebase',
        delta: currentTop - lastAppliedTop,
        duration: nowMs - gestureStartedMs,
      });
      return;
    }
    const remaining = target - currentTop;
    const idle = sinceInput > GLIDE_INPUT_IDLE_MS;
    const overMax = sinceInput > GLIDE_MAX_MS;
    if (Math.abs(remaining) < 0.4 || overMax || (idle && Math.abs(remaining) <= GLIDE_SNAP_PX)) {
      // Finish the distance the wheel asked for instead of leaving the
      // exponential's tail unscrolled. If layout moved us past the cap, hand
      // control back where we are; otherwise land exactly on the target.
      if (Math.abs(remaining) <= GLIDE_SNAP_PX) {
        element.scrollTop = target;
        lastAppliedTop = target;
      } else {
        target = currentTop;
        lastAppliedTop = currentTop;
      }
      animating = false;
      logScrollMark('glide.end', {
        reason: Math.abs(remaining) < 0.4 ? 'converged' : overMax ? 'max' : 'idle',
        age: sinceInput,
        duration: nowMs - gestureStartedMs,
        remaining,
      });
      return;
    }
    const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    lastGlideStepMs = now;
    const k = 1 - Math.exp(-dt / WHEEL_TAU_S);
    const nextTop = currentTop + remaining * k;
    element.scrollTop = nextTop;
    // Store the predicted position instead of reading scrollTop back: a
    // post-write read is a second forced layout per glide frame. If the
    // browser clamped the write at the ceiling (or scroll anchoring moved
    // the viewport), the next frame's start read differs from this value
    // and the rebase path stops the glide.
    lastAppliedTop = nextTop;
    frame = window.requestAnimationFrame(step);
  };

  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !event.cancelable) return;
    if (!isDiscreteMouseWheel(event)) {
      stop();
      return;
    }
    if (!shouldAnimateScroll()) {
      // Animations are off (setting or OS reduced motion): leave the wheel
      // to the browser so it behaves exactly like native instant scrolling.
      stop();
      return;
    }
    event.preventDefault();
    lastWheelInputMs = performance.now();
    const delta = wheelDeltaPixels(event, element);
    if (animating) {
      target = Math.max(0, target + delta);
      lastGlideStepMs = lastWheelInputMs;
      return;
    }
    const currentTop = element.scrollTop;
    target = Math.max(0, currentTop + delta);
    // |target - scrollTop| here is just |delta|; keep the tiny-nudge write,
    // but never read geometry on the wheel path: when rows are queued for
    // content-visibility layout, a scrollHeight read forces it synchronously.
    if (Math.abs(delta) < 2) {
      element.scrollTop = target;
      lastAppliedTop = target;
      return;
    }
    animating = true;
    gestureStartedMs = lastWheelInputMs;
    lastTime = lastWheelInputMs;
    lastGlideStepMs = lastTime;
    lastAppliedTop = currentTop;
    logScrollMark('glide.start', { delta, top: currentTop, target });
    frame = window.requestAnimationFrame(step);
  };

  wheelControllers.set(element, { stop, isAnimating: () => animating });
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('pointerdown', stop);

  return () => {
    stop();
    wheelControllers.delete(element);
    element.removeEventListener('wheel', onWheel);
    element.removeEventListener('pointerdown', stop);
  };
}
