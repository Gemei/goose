import {
  Fragment,
  memo,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isEqual } from 'lodash';
import { defineMessages, useIntl } from '../i18n';
import GooseMessage from './GooseMessage';
import UserMessage from './UserMessage';
import { DeferHighlightContext } from './MarkdownContent';
import {
  SystemNotificationInline,
  getInlineSystemNotification,
} from './context_management/SystemNotificationInline';
import {
  CreditsExhaustedNotification,
  getCreditsExhaustedNotification,
} from './context_management/CreditsExhaustedNotification';
import {
  type ImageData,
  type Message,
  type NotificationEvent,
  type SystemNotificationContent,
} from '../types/message';
import { getModelDisplayName } from './settings/models/predefinedModelsUtils';
import {
  deriveMessageRowContexts,
  inferenceModel,
  isModelChange,
  type InferenceModel,
  type MessageRowContext,
} from './messageRowContext';
import { AppEvents } from '../constants/events';
import { clearTranscriptHighlights, paintTranscriptHighlights } from '../utils/transcriptHighlight';
import {
  cancelWheelSmoothing,
  endUserGesture,
  isWheelGlideActive,
  noteUserGesture,
  noteUserInput,
  prefersInstantScroll,
  READING_SETTLE_MS,
  shouldAnimateScroll,
  smoothScrollTo,
  userGestureRecent,
  userInputRecent,
} from '../utils/smoothScroll';
import { logScroll, logScrollMark, logScrollThrottled } from '../utils/scrollDiagnostics';

// Rejoin the live edge only when the user is actually at the bottom. A 200px
// band kept follow on through wheel ticks, so streaming height growth snapped
// the viewport back before they could leave the tail.
const FOLLOW_RESUME_PX = 48;
// Long chats mount the live tail first, then older cards in idle batches.
// After historyStart hits 0 every card stays in document flow so a wheel
// tick never mounts GooseMessage. That load can take a few seconds.
const HISTORY_TAIL = 32;
const LIVE_TAIL = 12;
// Hydration batches size themselves from the measured cost of the previous
// one so each reveal stays inside a single frame budget.
const HISTORY_BATCH_MIN = 1;
const HISTORY_BATCH_MAX = 16;
const HYDRATE_BUDGET_MS = 24;
const HYDRATE_RETRY_MS = 16;
// While the user is mid-scroll the queue only progresses near the hydration
// frontier: the cards being scrolled into exist only if it keeps mounting.
const HYDRATE_QUIET_MS = 200;
const HYDRATE_FRONTIER_VIEWPORTS = 3;
// A reveal that costs more than this gets the next chunk halved; heavy
// command/code cards can cost many times a text card.
const REVEAL_BUDGET_MS = 32;

const i18n = defineMessages({
  modelChanged: {
    id: 'messageList.modelChanged',
    defaultMessage: 'Model changed: {previousModel} → {currentModel}',
  },
  requestedModel: {
    id: 'messageList.requestedModel',
    defaultMessage: '{model} (requested)',
  },
});

const emptyToolCallNotifications = new Map<string, NotificationEvent[]>();
const emptyAppend = () => {};

function getSystemNotification(message: Message): SystemNotificationContent | undefined {
  return getCreditsExhaustedNotification(message) ?? getInlineSystemNotification(message);
}

function renderSystemNotification(notification: SystemNotificationContent) {
  switch (notification.notificationType) {
    case 'creditsExhausted':
      return <CreditsExhaustedNotification notification={notification} />;
    case 'inlineMessage':
      return <SystemNotificationInline notification={notification} />;
    default:
      return null;
  }
}

interface MessageRowProps {
  append: (value: string) => void;
  index: number;
  isStreaming: boolean;
  isUser: boolean;
  message: Message;
  modelChangeMessage: string | null;
  onMessageUpdate?: (
    messageId: string,
    newContent: string,
    editType: 'fork' | 'edit',
    retainedImages: ImageData[]
  ) => void;
  rowContext: MessageRowContext;
  registerPreWarm?: (el: HTMLDivElement) => void;
  sessionId: string;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>,
    action?: 'accept' | 'decline'
  ) => Promise<boolean>;
  toolNotifications: readonly (NotificationEvent[] | undefined)[];
}

function MessageRowComponent({
  append,
  index,
  isStreaming,
  isUser,
  message,
  modelChangeMessage,
  onMessageUpdate,
  registerPreWarm,
  rowContext,
  sessionId,
  submitElicitationResponse,
  toolNotifications,
}: MessageRowProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!registerPreWarm) return;
    const wrapper = wrapperRef.current;
    if (wrapper) registerPreWarm(wrapper);
  }, [registerPreWarm]);

  const notification = getSystemNotification(message);

  if (notification) {
    return (
      <div
        className={`relative ${index === 0 ? 'mt-0' : 'mt-4'} assistant`}
        data-testid="message-container"
        data-message-index={index}
        style={{
          contain: 'layout',
          contentVisibility: 'auto',
          containIntrinsicSize: 'auto 160px',
        }}
      >
        {renderSystemNotification(notification)}
      </div>
    );
  }

  const hasOnlyToolResponses = message.content.every((content) => content.type === 'toolResponse');

  return (
    <Fragment>
      {modelChangeMessage && (
        <SystemNotificationInline
          notification={{
            msg: modelChangeMessage,
            notificationType: 'inlineMessage',
          }}
        />
      )}
      <div
        className={`relative ${index === 0 ? 'mt-0' : 'mt-4'} ${isUser ? 'user' : 'assistant'} ${rowContext.isInToolCallChain ? 'in-chain' : ''}`}
        data-testid="message-container"
        data-message-index={index}
        ref={wrapperRef}
        style={{
          contain: 'layout',
          contentVisibility: 'auto',
          containIntrinsicSize: 'auto 160px',
        }}
      >
        {isUser ? (
          !hasOnlyToolResponses && (
            <UserMessage message={message} onMessageUpdate={onMessageUpdate} />
          )
        ) : (
          <GooseMessage
            sessionId={sessionId}
            message={message}
            hideTimestamp={rowContext.hideTimestamp}
            toolStates={rowContext.toolStates}
            toolNotifications={toolNotifications}
            toolConfirmationShownInline={rowContext.toolConfirmationShownInline}
            append={append}
            isStreaming={isStreaming}
            submitElicitationResponse={submitElicitationResponse}
          />
        )}
      </div>
    </Fragment>
  );
}

function areMessageRowPropsEqual(prev: MessageRowProps, next: MessageRowProps) {
  // Scalar props first, then per-field reference short-circuits that skip the
  // deep walk whenever the identity already matches (settled rows, common case).
  if (
    prev.sessionId !== next.sessionId ||
    prev.index !== next.index ||
    prev.isUser !== next.isUser ||
    prev.isStreaming !== next.isStreaming ||
    prev.append !== next.append ||
    prev.onMessageUpdate !== next.onMessageUpdate ||
    prev.submitElicitationResponse !== next.submitElicitationResponse ||
    prev.modelChangeMessage !== next.modelChangeMessage
  ) {
    return false;
  }
  if (prev.message !== next.message && !isEqual(prev.message, next.message)) return false;
  if (prev.rowContext !== next.rowContext && !isEqual(prev.rowContext, next.rowContext)) {
    return false;
  }
  if (
    prev.toolNotifications !== next.toolNotifications &&
    !isEqual(prev.toolNotifications, next.toolNotifications)
  ) {
    return false;
  }
  return true;
}

const MessageRow = memo(MessageRowComponent, areMessageRowPropsEqual);

interface MessageListProps {
  messages: Message[];
  sessionId: string;
  toolCallNotifications?: Map<string, NotificationEvent[]>;
  append?: (value: string) => void;
  isUserMessage: (message: Message) => boolean;
  batchSize?: number;
  batchDelay?: number;
  showLoadingThreshold?: number;
  renderMessage?: (message: Message, index: number) => ReactNode | null;
  isStreamingMessage?: boolean;
  onMessageUpdate?: (
    messageId: string,
    newContent: string,
    editType: 'fork' | 'edit',
    retainedImages: ImageData[]
  ) => void;
  onRenderingComplete?: () => void;
  /** Reports hydration progress 0..1 while rows mount; null once the session is settled. */
  onHydrationProgress?: (progress: number | null) => void;
  /** Scroll this message into view. Used by transcript search. */
  focusedIndex?: number | null;
  /** Term to highlight inside the focused message. Empty skips the paint. */
  searchTerm?: string;
  searchCaseSensitive?: boolean;
  /** Which visible hit inside the focused message is the current one. */
  searchOccurrence?: number;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>,
    action?: 'accept' | 'decline'
  ) => Promise<boolean>;
}

function initialRevealedCount(length: number, threshold: number, batchSize: number) {
  if (length === 0) return 0;
  if (threshold > 0 && length <= threshold) return length;
  return Math.min(batchSize, length);
}

interface SharedRowProps {
  append: (value: string) => void;
  isStreamingMessage: boolean;
  isUserMessage: (message: Message) => boolean;
  messages: Message[];
  onMessageUpdate?: MessageListProps['onMessageUpdate'];
  renderMessage?: MessageListProps['renderMessage'];
  sessionId: string;
  submitElicitationResponse?: MessageListProps['submitElicitationResponse'];
  toolCallNotifications: Map<string, NotificationEvent[]>;
  registerPreWarm?: (el: HTMLDivElement) => void;
}

function buildVisibleRows({
  append,
  end,
  intl,
  isStreamingMessage,
  isUserMessage,
  messages,
  onMessageUpdate,
  registerPreWarm,
  renderMessage,
  sessionId,
  start,
  submitElicitationResponse,
  toolCallNotifications,
}: SharedRowProps & {
  end: number;
  intl: ReturnType<typeof useIntl>;
  start: number;
}) {
  const slice = messages.slice(start, end);
  const contextSource = start > 0 ? [messages[start - 1], ...slice] : slice;
  const rowContexts = deriveMessageRowContexts(contextSource);
  return slice.map((message, offset) => {
    const index = start + offset;
    if (!message.metadata.userVisible) return null;
    if (renderMessage) return renderMessage(message, index);

    const isUser = isUserMessage(message);
    const rowContext = rowContexts[start > 0 ? offset + 1 : offset];
    const currentModel = inferenceModel(message);
    const previousModel = rowContext.previousModel;
    const modelLabel = (model: InferenceModel) =>
      model.confirmed
        ? getModelDisplayName(model.id)
        : intl.formatMessage(i18n.requestedModel, { model: getModelDisplayName(model.id) });
    const modelChangeMessage =
      currentModel && previousModel && isModelChange(previousModel, currentModel)
        ? intl.formatMessage(i18n.modelChanged, {
            previousModel: modelLabel(previousModel),
            currentModel: modelLabel(currentModel),
          })
        : null;
    const toolNotifications = rowContext.toolStates.map((toolState) =>
      toolCallNotifications.get(toolState.requestId)
    );

    return (
      <MessageRow
        key={messageKeyOf(message, index)}
        append={append}
        index={index}
        isStreaming={
          isStreamingMessage &&
          !isUser &&
          index === messages.length - 1 &&
          message.role === 'assistant'
        }
        isUser={isUser}
        message={message}
        modelChangeMessage={modelChangeMessage}
        onMessageUpdate={onMessageUpdate}
        registerPreWarm={registerPreWarm}
        rowContext={rowContext}
        sessionId={sessionId}
        submitElicitationResponse={submitElicitationResponse}
        toolNotifications={toolNotifications}
      />
    );
  });
}

function useVisibleRows(props: SharedRowProps & { start: number; end: number }) {
  const intl = useIntl();
  const { messages, start, end } = props;
  return useMemo(
    () => buildVisibleRows({ ...props, intl }),
    // Slice identity is the only cheap lock BatchedMessageList needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, start, end, intl, props.isStreamingMessage, props.toolCallNotifications]
  );
}

function messageKeyOf(message: Message, index: number) {
  // Provider ids such as chatcmpl-* repeat across turns. The index keeps
  // each row's React identity unique so a later copy is not dropped.
  return `${message.id ?? 'msg'}:${index}:${message.created}`;
}

function initialHistoryStart(length: number) {
  if (length <= 0) return 0;
  if (prefersInstantScroll()) return 0;
  return Math.max(0, length - HISTORY_TAIL);
}

export default function MessageList(props: MessageListProps) {
  const { messages, showLoadingThreshold = 50 } = props;
  const virtualize = showLoadingThreshold > 0 && messages.length > showLoadingThreshold;

  if (virtualize) {
    return <VirtualMessageList {...props} />;
  }

  return <BatchedMessageList {...props} sessionId={props.sessionId} />;
}

function VirtualMessageList({
  messages,
  sessionId,
  toolCallNotifications = emptyToolCallNotifications,
  append = emptyAppend,
  isUserMessage,
  isStreamingMessage = false,
  onMessageUpdate,
  onHydrationProgress,
  onRenderingComplete,
  renderMessage,
  submitElicitationResponse,
  focusedIndex = null,
  searchTerm = '',
  searchCaseSensitive = false,
  searchOccurrence = 0,
}: MessageListProps) {
  const intl = useIntl();
  const listRef = useRef<HTMLDivElement>(null);
  const preWarmObserverRef = useRef<IntersectionObserver | null>(null);
  const registerPreWarm = useMemo(
    () => (element: HTMLDivElement) => {
      preWarmObserverRef.current?.observe(element);
    },
    []
  );
  const initialStart = initialHistoryStart(messages.length);
  const [historyStart, setHistoryStart] = useState(initialStart);
  const [historySettled, setHistorySettled] = useState(initialStart === 0);
  const followRef = useRef(true);
  const positionedRef = useRef(false);
  const pendingScrollRef = useRef<number | null>(null);
  const smoothingRef = useRef(false);
  const cancelSmoothRef = useRef<(() => void) | null>(null);
  const readingSettleRef = useRef(0);
  const cancelReadingSettle = () => {
    if (readingSettleRef.current) {
      window.clearTimeout(readingSettleRef.current);
      readingSettleRef.current = 0;
    }
  };
  const searchLockRef = useRef(false);
  const scrollTopRef = useRef(0);
  // Cached scroll maximum. `read()` runs on every coalesced scroll frame and
  // must not touch scrollHeight: that read forces pending content-visibility
  // layout synchronously while the user is moving the viewport.
  const maxScrollTopRef = useRef(0);
  const historyStartRef = useRef(0);
  const batchQueuedAtRef = useRef(0);
  const batchQueuedSizeRef = useRef(1);
  const overrunSkipsRef = useRef(0);
  const lastBatchCostMsRef = useRef(-1);
  const loadingHistoryRef = useRef(false);
  const completedSessionRef = useRef<string | null>(null);
  const sessionRef = useRef(sessionId);
  const messagesLengthRef = useRef(messages.length);
  messagesLengthRef.current = messages.length;

  const hasMessages = messages.length > 0;
  const hydratedWithMessagesRef = useRef(hasMessages);

  const loadingHistory = historyStart > 0 || !historySettled;
  loadingHistoryRef.current = loadingHistory;
  historyStartRef.current = historyStart;
  useEffect(() => {
    logScrollMark('ml.loadingHistory', {
      loading: loadingHistory,
      historyStart,
      sessionId,
      messages: messages.length,
    });
  }, [loadingHistory, historyStart, sessionId, messages.length]);
  useLayoutEffect(() => {
    const resetHydration = () => {
      const start = initialHistoryStart(messagesLengthRef.current);
      logScrollMark('ml.resetHydration', { start, messages: messagesLengthRef.current, sessionId });
      setHistoryStart(start);
      setHistorySettled(start === 0);
      followRef.current = true;
      positionedRef.current = false;
      completedSessionRef.current = null;
    };

    if (sessionRef.current !== sessionId) {
      sessionRef.current = sessionId;
      resetHydration();
      hydratedWithMessagesRef.current =
        hasMessages && initialHistoryStart(messagesLengthRef.current) > 0;
      return;
    }

    // The list can mount while a session-load replay holds the transcript
    // back (recipe sessions keep it rendered with zero messages). The full
    // conversation then lands in one notify, so size the hydration from the
    // real length here instead of a mount that saw nothing. Layout effect so
    // the already-committed rows go hidden before the first paint.
    if (hydratedWithMessagesRef.current !== hasMessages) {
      hydratedWithMessagesRef.current = hasMessages;
      resetHydration();
      hydratedWithMessagesRef.current =
        hasMessages && initialHistoryStart(messagesLengthRef.current) > 0;
    }
  }, [sessionId, hasMessages]);

  useEffect(() => {
    if (historyStart <= 0) return;
    let cancelled = false;
    let timer = 0;

    // Size the next batch from the measured cost of the last one (ms per
    // card) so each reveal stays inside the frame budget. Unknown cost
    // starts small.
    const nextBatchSize = () => {
      const perCardMs =
        lastBatchCostMsRef.current >= 0 && batchQueuedSizeRef.current > 0
          ? Math.max(1, lastBatchCostMsRef.current / batchQueuedSizeRef.current)
          : HYDRATE_BUDGET_MS / 2;
      const size = Math.round(HYDRATE_BUDGET_MS / perCardMs);
      return Math.min(HISTORY_BATCH_MAX, Math.max(HISTORY_BATCH_MIN, size));
    };

    // Near the hydration frontier the cards being scrolled into exist only
    // if the queue keeps mounting, so scrolling up there does not pause it.
    const canMount = () => {
      if (followRef.current) return true;
      const viewportEl = listRef.current?.closest('[data-radix-scroll-area-viewport]');
      if (!(viewportEl instanceof HTMLElement)) return true;
      if (viewportEl.scrollTop <= HYDRATE_FRONTIER_VIEWPORTS * viewportEl.clientHeight) {
        return true;
      }
      return !userGestureRecent(HYDRATE_QUIET_MS);
    };

    const step = () => {
      if (cancelled) return;
      const lastCost = lastBatchCostMsRef.current;
      if (lastCost >= 0 && lastCost > HYDRATE_RETRY_MS * 3 && overrunSkipsRef.current < 2) {
        overrunSkipsRef.current += 1;
      } else {
        overrunSkipsRef.current = 0;
        if (canMount()) {
          const size = Math.min(nextBatchSize(), historyStartRef.current);
          batchQueuedAtRef.current = performance.now();
          batchQueuedSizeRef.current = size;
          startTransition(() => {
            setHistoryStart((start) => Math.max(0, start - size));
          });
        }
      }
      timer = window.setTimeout(step, HYDRATE_RETRY_MS);
    };

    timer = window.setTimeout(step, HYDRATE_RETRY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historyStart]);

  useEffect(() => {
    if (historyStart > 0) {
      setHistorySettled(false);
      return;
    }
    const list = listRef.current;
    if (!list || prefersInstantScroll()) {
      setHistorySettled(true);
      return;
    }
    let lastHeight = list.offsetHeight;
    let stableFrames = 0;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      frames += 1;
      const nextHeight = list.offsetHeight;
      if (nextHeight === lastHeight) stableFrames += 1;
      else {
        stableFrames = 0;
        lastHeight = nextHeight;
      }
      if (stableFrames >= 4 || frames >= 45) {
        setHistorySettled(true);
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [historyStart]);

  useEffect(() => {
    if (focusedIndex == null || focusedIndex < 0) return;
    setHistoryStart((start) => Math.min(start, focusedIndex));
  }, [focusedIndex]);

  const viewportOf = () => {
    const viewport = listRef.current?.closest('[data-radix-scroll-area-viewport]');
    return viewport instanceof HTMLElement ? viewport : null;
  };

  const scrollViewportTo = (viewport: HTMLElement, top: number, smooth = false) => {
    const nextTop = Math.max(0, top);
    cancelWheelSmoothing(viewport);
    cancelSmoothRef.current?.();
    cancelSmoothRef.current = null;
    if (smooth) {
      smoothingRef.current = true;
      cancelSmoothRef.current = smoothScrollTo(viewport, nextTop, () => {
        // Clear even if the tween never reaches its target: streaming growth
        // can move the live edge past a fixed target mid-tween, and a stuck
        // flag would block every later follow pin until the next gesture.
        smoothingRef.current = false;
      });
    } else {
      smoothingRef.current = false;
      viewport.scrollTop = nextTop;
    }
    pendingScrollRef.current = nextTop;
    scrollTopRef.current = viewport.scrollTop;
  };

  useLayoutEffect(() => {
    const viewport = listRef.current?.closest('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) return;
    maxScrollTopRef.current = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    scrollTopRef.current = viewport.scrollTop;
  }, [sessionId]);

  useEffect(() => {
    const viewport = viewportOf();
    if (!viewport) return;

    const read = () => {
      const nextTop = viewport.scrollTop;
      // Fall back to a measurement when the list is not scrollable yet or the
      // observer has not reported; the cached path keeps scroll frames free
      // of scrollHeight reads.
      const maxScrollTop =
        maxScrollTopRef.current > 0
          ? maxScrollTopRef.current
          : viewport.scrollHeight - viewport.clientHeight;
      const distance = maxScrollTop - nextTop;
      const movedUp = nextTop < scrollTopRef.current - 1;
      const atLiveEdge = distance <= FOLLOW_RESUME_PX;
      const echoed =
        pendingScrollRef.current !== null && Math.abs(nextTop - pendingScrollRef.current) < 2;
      pendingScrollRef.current = null;

      logScrollThrottled('ml.read', viewport, {
        prevTop: scrollTopRef.current,
        movedUp,
        atLiveEdge,
        echoed,
        follow: followRef.current,
        loading: loadingHistoryRef.current,
        gesture: userGestureRecent(350),
        input: userInputRecent(350),
      });

      if (smoothingRef.current) {
        if (atLiveEdge || echoed) {
          smoothingRef.current = false;
          followRef.current = true;
        }
      } else if (!echoed) {
        searchLockRef.current = false;
        // Only wheel/pointer/touch input proves the user moved the view.
        // Scroll anchoring (a row above converting from its 160px estimate,
        // or a card growing after async markdown) also raises movedUp, and
        // classifying that as a gesture blocked the streaming pins and
        // detached follow with no user input.
        if (movedUp && userInputRecent(350)) {
          noteUserGesture();
          if (loadingHistoryRef.current) {
            // Hydration pins to the live edge every ~16ms batch; an in-band
            // nudge must not be re-glued mid-drain or the user fights the
            // follower for the whole load.
            cancelReadingSettle();
            followRef.current = false;
          } else if (atLiveEdge) {
            // In-band nudge: flushes keep re-gluing while the turn is
            // actively emitting, but if the gesture settles parked above the
            // exact bottom the user is reading — detach instead of gluing.
            cancelReadingSettle();
            readingSettleRef.current = window.setTimeout(() => {
              readingSettleRef.current = 0;
              const settled = viewportOf();
              if (!settled) return;
              if (userGestureRecent(80) || isWheelGlideActive(settled) || smoothingRef.current) {
                return;
              }
              const settledDistance =
                settled.scrollHeight - settled.scrollTop - settled.clientHeight;
              if (settledDistance <= 2) {
                endUserGesture();
                followRef.current = true;
                return;
              }
              followRef.current = false;
            }, READING_SETTLE_MS);
          } else {
            cancelReadingSettle();
            followRef.current = false;
          }
        } else if (distance <= 2) {
          // Back on the exact bottom is a deliberate re-attach; above it
          // (the resume band) only the settle path decides, so small
          // adjustments while reading never drag the viewport to the tail.
          cancelReadingSettle();
          endUserGesture();
          followRef.current = true;
        }
      }
      scrollTopRef.current = nextTop;
    };

    read();
    const cancelSmooth = () => {
      if (!smoothingRef.current) return;
      cancelSmoothRef.current?.();
      cancelSmoothRef.current = null;
      smoothingRef.current = false;
    };
    let scrollFrame = 0;
    const queueRead = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        read();
      });
    };
    // Wheel classification happens in read() (a moving wheel fires scroll
    // events), so a tick that never leaves the live edge cannot hold the pin.
    const onWheel = () => {
      noteUserInput();
      cancelSmooth();
    };
    const onGesture = () => {
      noteUserGesture();
      noteUserInput();
    };
    viewport.addEventListener('scroll', queueRead, { passive: true });
    viewport.addEventListener('wheel', onWheel, { passive: true });
    viewport.addEventListener('pointerdown', onGesture);
    viewport.addEventListener('touchstart', onGesture, { passive: true });
    return () => {
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      cancelReadingSettle();
      viewport.removeEventListener('scroll', queueRead);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerdown', onGesture);
      viewport.removeEventListener('touchstart', onGesture);
    };
  }, [sessionId]);

  // Pre-warm rows approaching the viewport so their first real style/layout
  // happens during idle time instead of mid-scroll.
  useEffect(() => {
    if (prefersInstantScroll()) {
      preWarmObserverRef.current = null;
      return;
    }
    const viewport = viewportOf();
    if (!viewport) return;

    let queued = false;
    let idleId: number | null = null;
    let timerId: number | null = null;
    const pending: HTMLElement[] = [];

    let bundleRows = 4;
    const flushPending = () => {
      // Scrolling is a rendering-critical window: a bundle conversion here
      // (the 12ms timer path) lands as one multi-card layout mid-gesture and
      // shows up as the scroll sawtooth. Keep queueing instead; the pile
      // drains fast once the gesture goes quiet.
      if (userGestureRecent(120)) {
        schedulePending();
        return;
      }
      queued = false;
      idleId = null;
      timerId = null;
      const count = Math.min(bundleRows, pending.length);
      if (count === 0) return;
      const started = performance.now();
      for (const element of pending.splice(0, count)) {
        element.style.contentVisibility = 'visible';
      }
      // Absorb + measure the conversion layout inside this idle slot so the
      // bundle adapts to heavy cards instead of stampeding a scroll frame.
      void viewport.scrollHeight;
      logScroll('ml.prewarm', viewport, { converted: count, follow: followRef.current });
      const costMs = performance.now() - started;
      if (costMs > REVEAL_BUDGET_MS) {
        bundleRows = Math.max(2, Math.round(bundleRows / 2));
      } else if (costMs < REVEAL_BUDGET_MS / 3) {
        bundleRows = Math.min(8, bundleRows + 2);
      }
      if (pending.length > 0) schedulePending();
    };

    const schedulePending = () => {
      if (queued) return;
      queued = true;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          flushPending();
        });
      } else {
        timerId = window.setTimeout(flushPending, 12);
      }
    };

    const cancelPending = () => {
      if (!queued) return;
      queued = false;
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timerId !== null) window.clearTimeout(timerId);
    };

    const io = new IntersectionObserver(
      (entries) => {
        let immediate = 0;
        // Converting a heavy card is a layout; doing it inside the scroll
        // frame is the sawtooth. While the user is moving the view, queue
        // every row for the idle pass instead of revealing ahead of them:
        // only rows the browser actually brings on screen pay layout now.
        const gesturing = userGestureRecent(120) || isWheelGlideActive(viewport);
        const immediateBudget = gesturing ? 0 : 4;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.unobserve(entry.target);
          const element = entry.target as HTMLElement;
          if (immediate < immediateBudget && !loadingHistoryRef.current) {
            immediate += 1;
            element.style.contentVisibility = 'visible';
          } else {
            pending.push(element);
            schedulePending();
          }
        }
      },
      { root: viewport, rootMargin: '200% 0px 200% 0px' }
    );
    preWarmObserverRef.current = io;

    return () => {
      if (preWarmObserverRef.current === io) preWarmObserverRef.current = null;
      cancelPending();
      io.disconnect();
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const viewport = viewportOf();
    if (!viewport) return;
    // A glide is the user moving the view; so is any real scroll movement
    // within the last 120ms (trackpads have no glide to detect). Skipping the
    // pin for that window keeps a streaming flush from yanking the user back
    // down in the frame before follow detaches.
    if (
      searchLockRef.current ||
      smoothingRef.current ||
      isWheelGlideActive(viewport) ||
      userGestureRecent(120)
    ) {
      logScrollMark('ml.pin.skip', {
        reason: 'gesture',
        search: searchLockRef.current,
        smoothing: smoothingRef.current,
        glide: isWheelGlideActive(viewport),
        gesture: userGestureRecent(120),
        loading: loadingHistoryRef.current,
      });
      return;
    }
    if (loadingHistoryRef.current && userInputRecent(120)) {
      // During hydration a hydration batch pin can land between a wheel event
      // and the coalesced read that classifies it, erasing the user's move
      // before follow can detach. Yield the pin to fresh input and let the
      // read decide; streaming pins are unaffected.
      logScrollMark('ml.pin.skip', { reason: 'input-during-load' });
      return;
    }
    const sinceQueuedMs = batchQueuedAtRef.current
      ? Math.round(performance.now() - batchQueuedAtRef.current)
      : 0;
    if (loadingHistoryRef.current && sinceQueuedMs > 0 && sinceQueuedMs < 1000) {
      lastBatchCostMsRef.current = sinceQueuedMs;
    }
    const pinToLiveEdge = !positionedRef.current || followRef.current;
    if (!pinToLiveEdge) {
      logScrollMark('ml.pin.skip', {
        reason: 'not-following',
        positioned: positionedRef.current,
        loading: loadingHistoryRef.current,
      });
      return;
    }
    const target = viewport.scrollHeight - viewport.clientHeight;
    scrollViewportTo(viewport, target);
    positionedRef.current = true;
    logScroll('ml.pin', viewport, {
      target,
      loading: loadingHistoryRef.current,
      follow: followRef.current,
      messages: messages.length,
    });
  }, [historyStart, loadingHistory, messages, isStreamingMessage]);

  // The batch pin only runs on render. Once history settles, the idle reveal
  // pass (and async markdown inside mounted rows) keeps growing earlier rows,
  // so the live edge drifts below the viewport with no further render to pin
  // it. Re-glue on content growth while the reader is still following.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const list = listRef.current;
    const viewport = viewportOf();
    if (!list || !viewport) return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      maxScrollTopRef.current = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      logScroll('ml.resize', viewport, {
        loading: loadingHistoryRef.current,
        follow: followRef.current,
      });
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (loadingHistoryRef.current || !followRef.current) {
          logScrollMark('ml.growth.skip', {
            reason: loadingHistoryRef.current ? 'loading' : 'not-following',
          });
          return;
        }
        if (
          smoothingRef.current ||
          isWheelGlideActive(viewport) ||
          userGestureRecent(120) ||
          userInputRecent(120)
        ) {
          logScrollMark('ml.growth.skip', {
            reason: 'gesture-or-smoothing',
            smoothing: smoothingRef.current,
            glide: isWheelGlideActive(viewport),
            gesture: userGestureRecent(120),
            input: userInputRecent(120),
          });
          return;
        }
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (distance <= 2) {
          logScrollMark('ml.growth.skip', { reason: 'at-edge', distance });
          return;
        }
        scrollViewportTo(viewport, viewport.scrollHeight - viewport.clientHeight);
        logScroll('ml.growth.pin', viewport, { distanceBefore: distance });
      });
    });
    observer.observe(list);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    if (focusedIndex == null || focusedIndex < 0) {
      searchLockRef.current = false;
      if (listRef.current) clearTranscriptHighlights(listRef.current);
      return;
    }
    const viewport = viewportOf();
    if (!viewport) return;
    searchLockRef.current = true;
    followRef.current = false;
  }, [focusedIndex]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    clearTranscriptHighlights(list);
    const term = searchTerm.trim();
    if (!term || focusedIndex == null || focusedIndex < 0) return;
    const row = list.querySelector(`[data-message-index="${focusedIndex}"]`);
    if (!(row instanceof HTMLElement)) return;
    // Far rows are content-visibility skipped; force full layout so the
    // highlight paint and the centering measurement see real geometry.
    row.style.contentVisibility = 'visible';
    const current = paintTranscriptHighlights(row, term, searchCaseSensitive, searchOccurrence);
    if (!searchLockRef.current) return;
    const viewport = viewportOf();
    if (!viewport) return;
    const target = current ?? row;
    const targetRect = target.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    if (targetRect.width === 0 && targetRect.height === 0) return;
    const centered =
      viewport.scrollTop +
      (targetRect.top - viewportRect.top) -
      Math.max(0, (viewport.clientHeight - targetRect.height) / 2);
    if (Math.abs(viewport.scrollTop - centered) > 2) {
      followRef.current = false;
      scrollViewportTo(viewport, centered);
    }
  }, [focusedIndex, historyStart, searchCaseSensitive, searchOccurrence, searchTerm]);

  useEffect(() => {
    const scrollToEnd = () => {
      const viewport = viewportOf();
      if (!viewport) return;
      searchLockRef.current = false;
      const animate = shouldAnimateScroll();
      followRef.current = !animate;
      scrollViewportTo(viewport, viewport.scrollHeight - viewport.clientHeight, animate);
    };
    window.addEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, scrollToEnd);
    return () => window.removeEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, scrollToEnd);
  }, []);

  useEffect(() => {
    if (loadingHistory || messages.length === 0) return;
    const completedKey = `${sessionId}:${messages.length}`;
    if (completedSessionRef.current === completedKey) return;
    const timeout = window.setTimeout(() => {
      completedSessionRef.current = completedKey;
      const viewport = viewportOf();
      logScroll('ml.renderingComplete', viewport, {
        messages: messages.length,
        follow: followRef.current,
      });
      onRenderingComplete?.();
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [loadingHistory, messages.length, onRenderingComplete, sessionId]);

  useEffect(() => {
    onHydrationProgress?.(
      loadingHistory && initialStart > 0
        ? Math.max(0, Math.min(1, 1 - historyStart / initialStart))
        : null
    );
  }, [loadingHistory, historyStart, initialStart, onHydrationProgress]);

  const liveStart = Math.max(historyStart, Math.max(0, messages.length - LIVE_TAIL));
  const historyLock = isStreamingMessage ? (messages[liveStart - 1] ?? liveStart) : messages;

  const historyRows = useMemo(
    () =>
      buildVisibleRows({
        append,
        end: liveStart,
        intl,
        isStreamingMessage: false,
        isUserMessage,
        messages,
        onMessageUpdate,
        registerPreWarm,
        renderMessage,
        sessionId,
        start: historyStart,
        submitElicitationResponse,
        toolCallNotifications,
      }),
    // Freeze the prefix while the last cards stream so React does not walk
    // hundreds of GooseMessage fibers on every token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      append,
      historyLock,
      historyStart,
      intl,
      isUserMessage,
      liveStart,
      onMessageUpdate,
      renderMessage,
      sessionId,
      submitElicitationResponse,
      toolCallNotifications,
    ]
  );

  const liveRows = useMemo(
    () =>
      buildVisibleRows({
        append,
        end: messages.length,
        intl,
        isStreamingMessage,
        isUserMessage,
        messages,
        onMessageUpdate,
        registerPreWarm,
        renderMessage,
        sessionId,
        start: liveStart,
        submitElicitationResponse,
        toolCallNotifications,
      }),
    [
      append,
      intl,
      isStreamingMessage,
      isUserMessage,
      liveStart,
      messages,
      onMessageUpdate,
      registerPreWarm,
      renderMessage,
      sessionId,
      submitElicitationResponse,
      toolCallNotifications,
    ]
  );

  return (
    <div
      ref={listRef}
      data-testid="virtual-message-list"
      className={loadingHistory ? undefined : 'chat-history-settled'}
      style={{
        overflowAnchor: 'auto',
        visibility: loadingHistory ? 'hidden' : undefined,
      }}
    >
      <DeferHighlightContext.Provider value={loadingHistory}>
        {historyRows}
        {liveRows}
      </DeferHighlightContext.Provider>
    </div>
  );
}

function BatchedMessageList({
  messages,
  sessionId,
  toolCallNotifications = emptyToolCallNotifications,
  append = emptyAppend,
  isUserMessage,
  batchSize = 5,
  batchDelay = 20,
  showLoadingThreshold = 50,
  renderMessage,
  isStreamingMessage = false,
  onMessageUpdate,
  onHydrationProgress,
  onRenderingComplete,
  submitElicitationResponse,
  focusedIndex = null,
  searchTerm = '',
  searchCaseSensitive = false,
  searchOccurrence = 0,
}: MessageListProps) {
  const [renderedCount, setRenderedCount] = useState(() =>
    initialRevealedCount(messages.length, showLoadingThreshold, batchSize)
  );
  const completedMessageKeyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isLoading = renderedCount < messages.length;

  useEffect(() => {
    setRenderedCount((current) => {
      if (showLoadingThreshold > 0 && messages.length <= showLoadingThreshold) {
        return messages.length;
      }
      if (messages.length === 0) return 0;
      if (current === 0) {
        return initialRevealedCount(messages.length, showLoadingThreshold, batchSize);
      }
      return Math.min(current, messages.length);
    });
  }, [batchSize, messages.length, showLoadingThreshold]);

  useEffect(() => {
    if (messages.length <= showLoadingThreshold || !isLoading) return;

    const timeout = window.setTimeout(() => {
      setRenderedCount((current) => Math.min(current + batchSize, messages.length));
    }, batchDelay);

    return () => window.clearTimeout(timeout);
  }, [batchDelay, batchSize, isLoading, messages.length, renderedCount, showLoadingThreshold]);

  useEffect(() => {
    if (isLoading) return;

    const completedMessageKey = `${sessionId}:${messages.length}`;
    if (completedMessageKeyRef.current === completedMessageKey) return;

    const timeout = window.setTimeout(() => {
      completedMessageKeyRef.current = completedMessageKey;
      onRenderingComplete?.();
    }, 50);

    return () => window.clearTimeout(timeout);
  }, [isLoading, messages.length, onRenderingComplete, sessionId]);

  useEffect(() => {
    onHydrationProgress?.(isLoading ? renderedCount / messages.length : null);
    return () => onHydrationProgress?.(null);
  }, [isLoading, renderedCount, messages.length, onHydrationProgress]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    clearTranscriptHighlights(list);
    const term = searchTerm.trim();
    if (!term || focusedIndex == null || focusedIndex < 0) return;
    const row = list.querySelector(`[data-message-index="${focusedIndex}"]`);
    if (!(row instanceof HTMLElement)) return;
    row.style.contentVisibility = 'visible';
    const current = paintTranscriptHighlights(row, term, searchCaseSensitive, searchOccurrence);
    const viewport = list.closest('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) return;
    const target = current ?? row;
    const targetRect = target.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    if (targetRect.width === 0 && targetRect.height === 0) return;
    const centered =
      viewport.scrollTop +
      (targetRect.top - viewportRect.top) -
      Math.max(0, (viewport.clientHeight - targetRect.height) / 2);
    if (Math.abs(viewport.scrollTop - centered) > 2) viewport.scrollTop = centered;
  }, [focusedIndex, renderedCount, searchCaseSensitive, searchOccurrence, searchTerm]);

  const rows = useVisibleRows({
    append,
    end: Math.min(renderedCount, messages.length),
    isStreamingMessage,
    isUserMessage,
    messages,
    onMessageUpdate,
    renderMessage,
    sessionId,
    start: 0,
    submitElicitationResponse,
    toolCallNotifications,
  });

  return (
    <div ref={listRef} style={{ visibility: isLoading ? 'hidden' : undefined }}>
      {rows}
    </div>
  );
}
