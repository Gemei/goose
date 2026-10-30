import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

type ScrollBehavior = 'auto' | 'smooth';

import { cn } from '../../utils';
import {
  attachWheelSmoothing,
  cancelWheelSmoothing,
  endUserGesture,
  isWheelGlideActive,
  noteUserGesture,
  noteUserInput,
  READING_SETTLE_MS,
  shouldAnimateScroll,
  smoothScrollTo,
  userGestureRecent,
  userInputRecent,
} from '../../utils/smoothScroll';
import { logScroll, logScrollMark, logScrollThrottled } from '../../utils/scrollDiagnostics';

export interface ScrollAreaHandle {
  scrollToBottom: () => void;
  scrollToPosition: (options: { top: number; behavior?: ScrollBehavior }) => void;
  isAtBottom: () => boolean;
  isFollowing: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  rootRef: React.RefObject<HTMLDivElement | null>;
}

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  autoScroll?: boolean;
  /* History is still hydrating: the transcript grows as earlier batches
     mount, and a follow pin here would fight a reader scrolling up. */
  suspendFollow?: boolean;
  onScrollChange?: (isAtBottom: boolean) => void;
  scrollbarClassName?: string;
  /* padding needs to be passed into the container inside ScrollArea to avoid pushing the scrollbar out */
  paddingX?: number;
  paddingY?: number;
  handleScroll?: (viewport: HTMLDivElement) => void;
}

const ScrollArea = React.forwardRef<ScrollAreaHandle, ScrollAreaProps>(
  (
    {
      className,
      children,
      autoScroll = false,
      suspendFollow = false,
      onScrollChange,
      scrollbarClassName,
      paddingX,
      paddingY,
      handleScroll: handleScrollProp,
      ...props
    },
    ref
  ) => {
    const rootRef = React.useRef<React.ElementRef<typeof ScrollAreaPrimitive.Root>>(null);
    const viewportRef = React.useRef<HTMLDivElement>(null);
    const viewportEndRef = React.useRef<HTMLDivElement>(null);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const [isFollowing, setIsFollowing] = React.useState(true);
    const [isScrolled, setIsScrolled] = React.useState(false);
    const isFollowingRef = React.useRef(true);
    const userScrolledUpRef = React.useRef(false);
    const lastScrollHeightRef = React.useRef(0);
    // Cached `scrollHeight - clientHeight`, refreshed on resize. The scroll
    // handler runs every frame; reading scrollHeight there forces pending
    // content-visibility layout synchronously on the input path.
    const maxScrollTopRef = React.useRef(0);
    const suspendFollowRef = React.useRef(false);
    suspendFollowRef.current = suspendFollow;
    const onScrollChangeRef = React.useRef(onScrollChange);
    onScrollChangeRef.current = onScrollChange;
    const smoothingRef = React.useRef(false);
    const cancelSmoothRef = React.useRef<(() => void) | null>(null);

    isFollowingRef.current = isFollowing;

    React.useEffect(() => {
      logScrollMark('sa.config', { autoScroll, suspendFollow });
    }, [autoScroll, suspendFollow]);

    const BOTTOM_SCROLL_THRESHOLD = 48;

    // Seed the cached scroll maximum once the viewport exists. Subsequent
    // changes arrive through the ResizeObserver below.
    React.useLayoutEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      maxScrollTopRef.current = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }, []);

    // True within 100ms of the last real user input (wheel/pointer/touch).
    // Programmatic follow pins never stamp it, so streaming growth keeps
    // them alive instead of starving behind their own scroll events.
    const userScrollingRecently = () => userGestureRecent(100);

    const readingSettleRef = React.useRef(0);

    const cancelReadingSettle = React.useCallback(() => {
      if (readingSettleRef.current) {
        window.clearTimeout(readingSettleRef.current);
        readingSettleRef.current = 0;
      }
    }, []);

    // Any user-driven upward move (even one that stays inside the resume
    // band) arms a settle check: if the gesture stops parked above the exact
    // bottom, the user is reading and follow detaches. Without this, a few
    // px of up-scroll left "following" on and content-visibility conversions
    // (our own pre-warm work, or streaming growth) yanked the viewport back
    // to the tail mid-read.
    const armReadingSettle = React.useCallback(() => {
      cancelReadingSettle();
      readingSettleRef.current = window.setTimeout(() => {
        readingSettleRef.current = 0;
        const viewport = viewportRef.current;
        if (!viewport) return;
        if (userGestureRecent(80) || isWheelGlideActive(viewport)) return;
        if (smoothingRef.current) return;
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (distance <= 2) return;
        userScrolledUpRef.current = true;
        if (isFollowingRef.current) {
          setIsFollowing(false);
          onScrollChange?.(false);
        }
      }, READING_SETTLE_MS);
    }, [cancelReadingSettle, onScrollChange]);

    const isAtBottom = React.useCallback(() => {
      if (!viewportRef.current) return false;

      const viewport = viewportRef.current;
      const { scrollHeight, scrollTop, clientHeight } = viewport;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

      return distanceFromBottom <= BOTTOM_SCROLL_THRESHOLD;
    }, []);

    const scrollToBottom = React.useCallback(() => {
      if (!viewportRef.current) return;
      const viewport = viewportRef.current;
      const target = viewport.scrollHeight - viewport.clientHeight;
      cancelWheelSmoothing(viewport);
      cancelSmoothRef.current?.();
      smoothingRef.current = shouldAnimateScroll();
      logScroll('sa.scrollToBottom', viewport, {
        target,
        smooth: smoothingRef.current,
        userScrolledUp: userScrolledUpRef.current,
      });
      cancelSmoothRef.current = smoothScrollTo(viewport, Math.max(0, target), () => {
        // The tween aims at the bottom as of click time; streaming content
        // keeps growing underneath and only the next growth tick can re-pin,
        // which requires smoothingRef cleared once the tween ends.
        smoothingRef.current = false;
      });
      setIsFollowing(true);
      userScrolledUpRef.current = false;
      cancelReadingSettle();
      onScrollChange?.(true);
    }, [onScrollChange, cancelReadingSettle]);

    const scrollToPosition = React.useCallback(
      ({ top, behavior = 'smooth' }: { top: number; behavior?: ScrollBehavior }) => {
        if (viewportRef.current) {
          viewportRef.current.scrollTo({
            top,
            behavior,
          });
        }
      },
      []
    );

    // Expose the scroll methods to parent components
    React.useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        scrollToPosition,
        isAtBottom,
        isFollowing,
        viewportRef,
        rootRef,
      }),
      [scrollToBottom, scrollToPosition, isAtBottom, isFollowing]
    );

    // track last scroll position to detect user-initiated scrolling
    const lastScrollTopRef = React.useRef(0);

    // Handle scroll events to update isFollowing state
    const handleScroll = React.useCallback(() => {
      if (!viewportRef.current) return;

      const viewport = viewportRef.current;
      const { scrollTop } = viewport;
      // A zero maximum means the content still fits (or the observer has not
      // reported yet), so fall back to a direct measurement. The cached path
      // keeps the common scrollable case free of layout reads.
      const maxScrollTop =
        maxScrollTopRef.current > 0
          ? maxScrollTopRef.current
          : viewport.scrollHeight - viewport.clientHeight;
      const currentIsAtBottom = maxScrollTop - scrollTop <= BOTTOM_SCROLL_THRESHOLD;

      const movedUp = scrollTop < lastScrollTopRef.current - 1;
      lastScrollTopRef.current = scrollTop;

      logScrollThrottled('sa.scroll', viewport, {
        follow: isFollowing,
        atBottom: currentIsAtBottom,
        movedUp,
        gesture: userGestureRecent(350),
        input: userInputRecent(350),
        smoothing: smoothingRef.current,
        scrolledUp: userScrolledUpRef.current,
      });

      if (smoothingRef.current) {
        if (currentIsAtBottom) smoothingRef.current = false;
        setIsScrolled(scrollTop > 0);
        if (handleScrollProp) handleScrollProp(viewport);
        return;
      }

      // Leave follow only after the viewport has left the live edge. A tiny
      // upward move while still at the bottom hid the jump-to-bottom control
      // and left auto-scroll off, so the user could not reach new tokens.
      // Deltas without real input are scroll anchoring, not the user: they
      // must not stamp the gesture clock or detach the streaming follower.
      if (movedUp && userInputRecent(350)) {
        // Direction-aware gesture stamp: every real upward move is user input
        // for the shared clock. Follow pins move down and never stamp, so
        // streaming growth cannot starve behind its own scroll events.
        noteUserGesture();
        armReadingSettle();
        if (!currentIsAtBottom) {
          userScrolledUpRef.current = true;
          if (isFollowing) {
            setIsFollowing(false);
            onScrollChange?.(false);
          }
        }
      } else if (currentIsAtBottom && userScrolledUpRef.current) {
        userScrolledUpRef.current = false;
        cancelReadingSettle();
        endUserGesture();
        setIsFollowing(true);
        onScrollChange?.(true);
      } else if (currentIsAtBottom && !isFollowing) {
        userScrolledUpRef.current = false;
        cancelReadingSettle();
        endUserGesture();
        setIsFollowing(true);
        onScrollChange?.(true);
      }

      setIsScrolled(scrollTop > 0);

      if (handleScrollProp) {
        handleScrollProp(viewport);
      }
    }, [isFollowing, onScrollChange, handleScrollProp, armReadingSettle, cancelReadingSettle]);
    // Coalesce scroll handling to one run per frame: wheel streams can deliver
    // events faster than the display refreshes and each one did layout reads
    // plus state updates, which showed up as dropped frames.
    const scrollHandlerFrameRef = React.useRef(0);

    const handleScrollEvent = React.useCallback(() => {
      if (scrollHandlerFrameRef.current) return;
      scrollHandlerFrameRef.current = window.requestAnimationFrame(() => {
        scrollHandlerFrameRef.current = 0;
        handleScroll();
      });
    }, [handleScroll]);

    React.useEffect(
      () => () => {
        if (scrollHandlerFrameRef.current) {
          window.cancelAnimationFrame(scrollHandlerFrameRef.current);
          scrollHandlerFrameRef.current = 0;
        }
      },
      []
    );

    // Auto-scroll when content changes and user is following
    React.useEffect(() => {
      if (!autoScroll || !viewportRef.current) return;

      const viewport = viewportRef.current;
      const currentScrollHeight = viewport.scrollHeight;
      maxScrollTopRef.current = Math.max(0, currentScrollHeight - viewport.clientHeight);

      // Only auto-scroll if:
      // 1. Content has actually grown (new content added)
      // 2. User was following (at the bottom)
      // 3. User hasn't manually scrolled up
      // 4. User is not actively scrolling
      if (currentScrollHeight !== lastScrollHeightRef.current) {
        logScroll('sa.growth', viewport, {
          prevHeight: lastScrollHeightRef.current,
          follow: isFollowing,
          suspend: suspendFollowRef.current,
          scrolledUp: userScrolledUpRef.current,
          scrolling: userScrollingRecently(),
          input: userInputRecent(120),
          glide: isWheelGlideActive(viewport),
        });
      }
      if (
        currentScrollHeight > lastScrollHeightRef.current &&
        isFollowing &&
        !suspendFollowRef.current &&
        !userScrolledUpRef.current &&
        !userScrollingRecently() &&
        !userInputRecent(120) &&
        viewport &&
        !isWheelGlideActive(viewport)
      ) {
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          if (viewportRef.current && !userScrollingRecently()) {
            viewportRef.current.scrollTo({
              top: viewportRef.current.scrollHeight,
              behavior: 'auto',
            });
          }
        });
      }

      lastScrollHeightRef.current = currentScrollHeight;
    }, [children, autoScroll, isFollowing]);

    // Async markdown, images, and syntax highlighting change card height after
    // paint. Pin while following. Otherwise keep the first on-screen message
    // still so a taller card above the viewport does not shove the view down.
    React.useEffect(() => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content || typeof ResizeObserver === 'undefined') return;

      // `scrollTop` at capture time. The rect is only meaningful while the
      // viewport is still where it was; a user scroll in between moves the
      // rect by the scrolled distance, and applying that as "drift" replays
      // the gesture backwards.
      type Anchor = { node: HTMLElement; top: number; scrollTop: number };
      let anchor: Anchor | null = null;

      const rowInView = (row: HTMLElement, viewportRect: DOMRect) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > viewportRect.top + 8 && rect.top < viewportRect.bottom ? rect : null;
      };

      const captureAnchor = () => {
        const viewportRect = viewport.getBoundingClientRect();
        if (anchor?.node.isConnected) {
          const rect = rowInView(anchor.node, viewportRect);
          if (rect) {
            anchor = { node: anchor.node, top: rect.top, scrollTop: viewport.scrollTop };
            return;
          }
        }
        const x = viewportRect.left + Math.min(48, Math.max(8, viewportRect.width / 2));
        const y = viewportRect.top + 16;
        const hit = document.elementsFromPoint?.(x, y) ?? [];
        for (const node of hit) {
          if (!(node instanceof Element)) continue;
          const row = node.closest('[data-message-index]');
          if (row instanceof HTMLElement && content.contains(row)) {
            anchor = {
              node: row,
              top: row.getBoundingClientRect().top,
              scrollTop: viewport.scrollTop,
            };
            return;
          }
        }
        anchor = null;
      };

      // Capture the anchor only once the wheel/gesture has settled. Capturing
      // on every scroll event forced a layout + elementsFromPoint hit-test
      // per frame and was the dominant cost of low-FPS scrolling.
      let anchorCaptureTimer = 0;
      const scheduleAnchorCapture = () => {
        if (anchorCaptureTimer) window.clearTimeout(anchorCaptureTimer);
        anchorCaptureTimer = window.setTimeout(() => {
          anchorCaptureTimer = 0;
          captureAnchor();
        }, 60);
      };

      const observer = new ResizeObserver(() => {
        maxScrollTopRef.current = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        logScroll('sa.resize', viewport, {
          follow: isFollowingRef.current,
          suspend: suspendFollowRef.current,
          scrolledUp: userScrolledUpRef.current,
          scrolling: userScrollingRecently(),
          input: userInputRecent(120),
          smoothing: smoothingRef.current,
          glide: isWheelGlideActive(viewport),
        });
        // A wheel glide in flight is the user moving the view: don't fight it
        // until the gesture ends, and keep streaming growth corrections idle.
        if (isWheelGlideActive(viewport)) {
          logScrollMark('sa.resize.skip', { reason: 'glide' });
          return;
        }
        if (
          isFollowingRef.current &&
          !suspendFollowRef.current &&
          !userScrolledUpRef.current &&
          !userScrollingRecently() &&
          // Yield to fresh wheel/pointer input: a resize pin that fires
          // between the input and the coalesced scroll handler resets
          // scrollTop first, so the handler never sees the user's move and
          // follow never detaches. Same window the pins use everywhere else.
          !userInputRecent(120) &&
          !smoothingRef.current
        ) {
          const distanceBefore = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
          if (distanceBefore > viewport.clientHeight) {
            // A follower sits on the live edge; a viewport away from it is a
            // reader (keyboard scroll, missed input). Detach instead of
            // yanking them down after a content resize.
            logScrollMark('sa.resize.detach', { distanceBefore, client: viewport.clientHeight });
            userScrolledUpRef.current = true;
            setIsFollowing(false);
            onScrollChangeRef.current?.(false);
          } else {
            logScrollMark('sa.resize.pin', { distanceBefore, height: viewport.scrollHeight });
            cancelWheelSmoothing(viewport);
            viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
            captureAnchor();
            return;
          }
        }
        if (!anchor) {
          logScrollMark('sa.resize.anchor', { captured: false });
          captureAnchor();
          return;
        }
        // The stored rect is only meaningful while the viewport is where it
        // was at capture time. If it moved (user gesture, glide, pin, tween),
        // the rect delta is that movement, not layout drift — correcting it
        // would replay the user's scroll backwards. Re-capture instead.
        const movedSinceCapture = viewport.scrollTop !== anchor.scrollTop;
        if (
          movedSinceCapture ||
          smoothingRef.current ||
          isWheelGlideActive(viewport) ||
          userInputRecent(350) ||
          userGestureRecent(350)
        ) {
          logScrollMark('sa.resize.anchor', {
            captured: false,
            reason: movedSinceCapture ? 'moved' : 'gesture',
            delta: viewport.scrollTop - anchor.scrollTop,
            smoothing: smoothingRef.current,
            glide: isWheelGlideActive(viewport),
            input: userInputRecent(350),
            gesture: userGestureRecent(350),
          });
          captureAnchor();
          return;
        }
        const drift = anchor.node.getBoundingClientRect().top - anchor.top;
        logScrollMark('sa.resize.anchor', {
          captured: true,
          drift,
          corrected: Math.abs(drift) >= 1,
        });
        if (Math.abs(drift) >= 1) {
          // The correction keeps the anchor at its captured screen position,
          // so only the remembered offset moves with it.
          viewport.scrollTop += drift;
          anchor.scrollTop = viewport.scrollTop;
        }
        scheduleAnchorCapture();
      });
      observer.observe(content);
      captureAnchor();
      viewport.addEventListener('scroll', scheduleAnchorCapture, { passive: true });
      return () => {
        if (anchorCaptureTimer) window.clearTimeout(anchorCaptureTimer);
        observer.disconnect();
        viewport.removeEventListener('scroll', scheduleAnchorCapture);
      };
    }, []);

    // Add scroll event listener
    React.useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      const cancelSmooth = () => {
        if (!smoothingRef.current) return;
        cancelSmoothRef.current?.();
        cancelSmoothRef.current = null;
        smoothingRef.current = false;
      };
      // Wheel classification happens in handleScroll; a tick that never
      // leaves the bottom must not hold the growth pin behind the gesture
      // clock, or streaming during at-bottom wheel strokes starves again.
      const onWheel = () => {
        noteUserInput();
        cancelSmooth();
      };
      const onGesture = () => {
        noteUserGesture();
        noteUserInput();
      };
      // Scrollbar drags never fire wheel/touch on the viewport; capture the
      // pointer on the root so thumb drags still count as real input.
      const root = rootRef.current;
      const onRootPointerDown = () => noteUserInput();
      viewport.addEventListener('scroll', handleScrollEvent, { passive: true });
      viewport.addEventListener('wheel', onWheel, { passive: true });
      viewport.addEventListener('pointerdown', onGesture);
      viewport.addEventListener('touchstart', onGesture, { passive: true });
      root?.addEventListener('pointerdown', onRootPointerDown);
      return () => {
        viewport.removeEventListener('scroll', handleScrollEvent);
        viewport.removeEventListener('wheel', onWheel);
        viewport.removeEventListener('pointerdown', onGesture);
        viewport.removeEventListener('touchstart', onGesture);
        root?.removeEventListener('pointerdown', onRootPointerDown);
      };
    }, [handleScrollEvent]);

    React.useEffect(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      return attachWheelSmoothing(viewport);
    }, []);

    return (
      <ScrollAreaPrimitive.Root
        ref={rootRef}
        className={cn('relative overflow-hidden', className)}
        data-scrolled={isScrolled}
        {...props}
      >
        <div className={cn('absolute top-0 left-0 right-0 z-10 transition-all duration-200')} />
        <ScrollAreaPrimitive.Viewport
          ref={viewportRef}
          className="h-full w-full rounded-[inherit] [&>div]:!block"
        >
          <div
            ref={contentRef}
            className={cn(paddingX ? `px-${paddingX}` : '', paddingY ? `py-${paddingY}` : '')}
          >
            {children}
            {autoScroll && <div ref={viewportEndRef} style={{ height: '1px' }} />}
          </div>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar className={scrollbarClassName} />
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    );
  }
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
      orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border-primary dark:bg-background-secondary" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
