import { useEffect, useRef, useState } from 'react';
import { wheelGlideBusy } from '../utils/smoothScroll';

export const STREAMING_RENDER_COOLDOWN_MS = 100;

export function useThrottledStreamingText(
  content: string,
  enabled: boolean,
  cooldownMs = STREAMING_RENDER_COOLDOWN_MS
): string {
  const [renderedText, setRenderedText] = useState(content);
  const renderedTextRef = useRef(content);
  const latestTextRef = useRef(content);
  const cooldownTimerRef = useRef<number | null>(null);

  latestTextRef.current = content;

  useEffect(() => {
    if (!enabled) {
      if (cooldownTimerRef.current !== null) {
        window.clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
      renderedTextRef.current = content;
      setRenderedText(content);
      return;
    }

    if (cooldownTimerRef.current === null && content !== renderedTextRef.current) {
      renderedTextRef.current = content;
      setRenderedText(content);
    }
  }, [content, enabled]);

  useEffect(() => {
    if (!enabled) return;

    const flush = () => {
      // While a wheel glide is live it owns the frame budget: hold the text
      // update (re-check briefly) instead of paying a markdown re-render
      // mid-scroll. The pending text flushes once the gesture settles.
      if (wheelGlideBusy()) {
        cooldownTimerRef.current = window.setTimeout(flush, 120);
        return;
      }
      cooldownTimerRef.current = null;
      const latestText = latestTextRef.current;
      if (latestText !== renderedTextRef.current) {
        renderedTextRef.current = latestText;
        setRenderedText(latestText);
      }
    };
    cooldownTimerRef.current = window.setTimeout(flush, cooldownMs);

    return () => {
      if (cooldownTimerRef.current !== null) {
        window.clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }
    };
  }, [cooldownMs, enabled, renderedText]);

  return enabled ? renderedText : content;
}
