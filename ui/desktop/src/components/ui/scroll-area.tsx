import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';

type ScrollBehavior = 'auto' | 'smooth';

import { cn } from '../../utils';
import {
  attachWheelSmoothing,
  cancelWheelSmoothing,
  prefersInstantScroll,
  smoothScrollTo,
} from '../../utils/smoothScroll';

export interface ScrollAreaHandle {
  scrollToBottom: () => void;
  scrollToPosition: (options: { top: number; behavior?: ScrollBehavior }) => void;
  isAtBottom: () => boolean;
  isFollowing: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  autoScroll?: boolean;
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
    const isActivelyScrollingRef = React.useRef(false);
    const scrollTimeoutRef = React.useRef<number | null>(null);
    const smoothingRef = React.useRef(false);
    const cancelSmoothRef = React.useRef<(() => void) | null>(null);

    isFollowingRef.current = isFollowing;

    const BOTTOM_SCROLL_THRESHOLD = 48;

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
      smoothingRef.current = !prefersInstantScroll();
      cancelSmoothRef.current = smoothScrollTo(viewport, Math.max(0, target));
      setIsFollowing(true);
      userScrolledUpRef.current = false;
      onScrollChange?.(true);
    }, [onScrollChange]);

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
      const currentIsAtBottom = isAtBottom();

      // detect if this is a user-initiated scroll (position changed from last known position)
      const scrollDelta = Math.abs(scrollTop - lastScrollTopRef.current);
      if (scrollDelta > 0) {
        // Mark that user is actively scrolling immediately
        isActivelyScrollingRef.current = true;

        // clear any existing timeout and set a new one
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current);
        }

        // mark as not actively scrolling
        scrollTimeoutRef.current = window.setTimeout(() => {
          isActivelyScrollingRef.current = false;
        }, 100);
      }

      const movedUp = scrollTop < lastScrollTopRef.current - 1;
      lastScrollTopRef.current = scrollTop;

      if (smoothingRef.current) {
        if (currentIsAtBottom) smoothingRef.current = false;
        setIsScrolled(scrollTop > 0);
        if (handleScrollProp) handleScrollProp(viewport);
        return;
      }

      // Leave follow only after the viewport has left the live edge. A tiny
      // upward move while still at the bottom hid the jump-to-bottom control
      // and left auto-scroll off, so the user could not reach new tokens.
      if (movedUp && !currentIsAtBottom) {
        userScrolledUpRef.current = true;
        if (isFollowing) {
          setIsFollowing(false);
          onScrollChange?.(false);
        }
      } else if (currentIsAtBottom && userScrolledUpRef.current) {
        userScrolledUpRef.current = false;
        setIsFollowing(true);
        onScrollChange?.(true);
      } else if (currentIsAtBottom && !isFollowing) {
        userScrolledUpRef.current = false;
        setIsFollowing(true);
        onScrollChange?.(true);
      }

      setIsScrolled(scrollTop > 0);

      if (handleScrollProp) {
        handleScrollProp(viewport);
      }
    }, [isAtBottom, isFollowing, onScrollChange, handleScrollProp]);

    // Auto-scroll when content changes and user is following
    React.useEffect(() => {
      if (!autoScroll || !viewportRef.current) return;

      const viewport = viewportRef.current;
      const currentScrollHeight = viewport.scrollHeight;

      // Only auto-scroll if:
      // 1. Content has actually grown (new content added)
      // 2. User was following (at the bottom)
      // 3. User hasn't manually scrolled up
      // 4. User is not actively scrolling
      if (
        currentScrollHeight > lastScrollHeightRef.current &&
        isFollowing &&
        !userScrolledUpRef.current &&
        !isActivelyScrollingRef.current
      ) {
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          if (viewportRef.current && !isActivelyScrollingRef.current) {
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

      type Anchor = { node: HTMLElement; top: number };
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
            anchor = { node: anchor.node, top: rect.top };
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
            anchor = { node: row, top: row.getBoundingClientRect().top };
            return;
          }
        }
        anchor = null;
      };

      const observer = new ResizeObserver(() => {
        if (
          isFollowingRef.current &&
          !userScrolledUpRef.current &&
          !isActivelyScrollingRef.current &&
          !smoothingRef.current
        ) {
          cancelWheelSmoothing(viewport);
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'auto' });
          captureAnchor();
          return;
        }
        if (!anchor) {
          captureAnchor();
          return;
        }
        const drift = anchor.node.getBoundingClientRect().top - anchor.top;
        if (Math.abs(drift) >= 1) {
          viewport.scrollTop += drift;
        }
        captureAnchor();
      });
      observer.observe(content);
      captureAnchor();
      viewport.addEventListener('scroll', captureAnchor, { passive: true });
      return () => {
        observer.disconnect();
        viewport.removeEventListener('scroll', captureAnchor);
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
      viewport.addEventListener('scroll', handleScroll, { passive: true });
      viewport.addEventListener('wheel', cancelSmooth, { passive: true });
      viewport.addEventListener('pointerdown', cancelSmooth);
      return () => {
        viewport.removeEventListener('scroll', handleScroll);
        viewport.removeEventListener('wheel', cancelSmooth);
        viewport.removeEventListener('pointerdown', cancelSmooth);
        if (scrollTimeoutRef.current) {
          clearTimeout(scrollTimeoutRef.current);
        }
      };
    }, [handleScroll]);

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
