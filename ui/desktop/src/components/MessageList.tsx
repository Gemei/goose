import {
  Fragment,
  memo,
  useCallback,
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
import {
  SystemNotificationInline,
  getInlineSystemNotification,
} from './context_management/SystemNotificationInline';
import {
  CreditsExhaustedNotification,
  getCreditsExhaustedNotification,
} from './context_management/CreditsExhaustedNotification';
import type {
  ImageData,
  Message,
  NotificationEvent,
  SystemNotificationContent,
} from '../types/message';
import { getModelDisplayName } from './settings/models/predefinedModelsUtils';
import { deriveMessageRowContexts, type MessageRowContext } from './messageRowContext';
import { AppEvents } from '../constants/events';
import { messageOffset, messageWindow } from './messageWindow';
import { clearTranscriptHighlights, paintTranscriptHighlights } from '../utils/transcriptHighlight';

const i18n = defineMessages({
  loadingMessages: {
    id: 'progressiveMessageList.loadingMessages',
    defaultMessage: 'Loading messages... ({renderedCount}/{totalCount})',
  },
  modelChanged: {
    id: 'messageList.modelChanged',
    defaultMessage: 'Model changed: {previousModel} → {currentModel}',
  },
  requestedModel: {
    id: 'messageList.requestedModel',
    defaultMessage: '{model} (requested)',
  },
  hiddenMessages: {
    id: 'messageList.hiddenMessages',
    defaultMessage: '{count, plural, one {# message hidden} other {# messages hidden}}',
  },
  showAllMessages: {
    id: 'messageList.showAllMessages',
    defaultMessage: 'Show all',
  },
});

const emptyToolCallNotifications = new Map<string, NotificationEvent[]>();
const emptyAppend = () => {};
const HEAD_MESSAGE_COUNT = 20;
const TAIL_MESSAGE_COUNT = 200;
const MESSAGE_DISPLAY_LIMIT = HEAD_MESSAGE_COUNT + TAIL_MESSAGE_COUNT;

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
  sessionId: string;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
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
  rowContext,
  sessionId,
  submitElicitationResponse,
  toolNotifications,
}: MessageRowProps) {
  const notification = getSystemNotification(message);

  if (notification) {
    return (
      <div
        className={`relative ${index === 0 ? 'mt-0' : 'mt-4'} assistant`}
        data-testid="message-container"
        data-message-index={index}
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

const MessageRow = memo(MessageRowComponent, isEqual);

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
  /** Scroll this message into view. Used by transcript search. */
  focusedIndex?: number | null;
  /** Term to highlight inside the focused message. Empty skips the paint. */
  searchTerm?: string;
  searchCaseSensitive?: boolean;
  /** Which visible hit inside the focused message is the current one. */
  searchOccurrence?: number;
  submitElicitationResponse?: (
    elicitationId: string,
    userData: Record<string, unknown>
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
  onMessageUpdate?: ProgressiveMessageListProps['onMessageUpdate'];
  renderMessage?: ProgressiveMessageListProps['renderMessage'];
  sessionId: string;
  submitElicitationResponse?: ProgressiveMessageListProps['submitElicitationResponse'];
  toolCallNotifications: Map<string, NotificationEvent[]>;
}

function useVisibleRows({
  append,
  end,
  isStreamingMessage,
  isUserMessage,
  messages,
  onMessageUpdate,
  renderMessage,
  sessionId,
  start,
  submitElicitationResponse,
  toolCallNotifications,
}: SharedRowProps & { start: number; end: number }) {
  const intl = useIntl();
  const rowContexts = useMemo(() => deriveMessageRowContexts(messages), [messages]);

  return messages.slice(start, end).map((message, offset) => {
    const index = start + offset;
    if (!message.metadata.userVisible) return null;
    if (renderMessage) return renderMessage(message, index);

    const isUser = isUserMessage(message);
    const messageIdentifier = message.id ?? `msg-${index}-${message.created}`;
    const messageKey = getSystemNotification(message)
      ? `notification-${messageIdentifier}`
      : messageIdentifier;
    const rowContext = rowContexts[index];
    const currentResolvedModel = getResolvedModel(message);
    const modelChangeMessage =
      currentResolvedModel &&
      rowContext.previousResolvedModel &&
      currentResolvedModel !== rowContext.previousResolvedModel
        ? intl.formatMessage(i18n.modelChanged, {
            previousModel: getModelDisplayName(rowContext.previousResolvedModel),
            currentModel: getModelDisplayName(currentResolvedModel),
          })
        : null;
    const toolNotifications = rowContext.toolStates.map((toolState) =>
      toolCallNotifications.get(toolState.requestId)
    );

    return (
      <MessageRow
        key={messageKey}
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
        rowContext={rowContext}
        sessionId={sessionId}
        submitElicitationResponse={submitElicitationResponse}
        toolNotifications={toolNotifications}
      />
    );
  });
}

function messageKeyOf(message: Message, index: number) {
  // Provider ids such as chatcmpl-* repeat across turns. The index keeps
  // each row's React identity unique so a later copy is not dropped.
  return `${message.id ?? 'msg'}:${index}:${message.created}`;
}

export default function ProgressiveMessageList(props: ProgressiveMessageListProps) {
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
  onRenderingComplete,
  renderMessage,
  submitElicitationResponse,
  focusedIndex = null,
  searchTerm = '',
  searchCaseSensitive = false,
  searchOccurrence = 0,
}: ProgressiveMessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const heightsRef = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [positioned, setPositioned] = useState(false);
  // While this is set, the mounted window is the tail. Scrolling to the
  // scrollHeight of a mid-transcript window only reaches the empty bottom
  // spacer, so the latest rows have to be mounted before that scroll.
  const [stickToTail, setStickToTail] = useState(true);
  const followRef = useRef(true);
  const nearBottomRef = useRef(true);
  // Scroll position written by scrollViewportTo. The matching scroll event is
  // the echo of that write, not the user leaving or reaching the tail.
  const pendingScrollRef = useRef<number | null>(null);
  const searchLockRef = useRef(false);
  const scrollTopRef = useRef(0);
  const measureFlushRef = useRef(false);
  const scrollingRef = useRef(false);
  const pendingMeasureRef = useRef(false);
  const scrollIdleRef = useRef<number | null>(null);
  const completedSessionRef = useRef<string | null>(null);

  const heights = useMemo(() => {
    return messages.map((message, index) => {
      if (!message.metadata.userVisible) return 0;
      return heightsRef.current.get(messageKeyOf(message, index));
    });
    // measureVersion retargets the memo after a row reports a real height.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, measureVersion]);

  const windowRange = messageWindow({
    count: messages.length,
    scrollTop,
    viewportHeight,
    heights,
    // Before the first measurement, and whenever the user is at the live edge,
    // mount the tail. A scroll offset alone cannot see past the bottom spacer.
    pinToBottom: !positioned || stickToTail,
  });

  const viewportOf = () => {
    const viewport = listRef.current?.closest('[data-radix-scroll-area-viewport]');
    return viewport instanceof HTMLElement ? viewport : null;
  };

  const scrollViewportTo = (viewport: HTMLElement, top: number) => {
    const nextTop = Math.max(0, top);
    viewport.scrollTop = nextTop;
    pendingScrollRef.current = viewport.scrollTop;
    scrollTopRef.current = viewport.scrollTop;
    setScrollTop(viewport.scrollTop);
    setViewportHeight(viewport.clientHeight);
  };

  useEffect(() => {
    const viewport = viewportOf();
    if (!viewport) return;

    // Keep the thumb glued to the gesture. Measured row heights are applied
    // after the drag, and they do not move scrollTop.
    const markScrolling = () => {
      scrollingRef.current = true;
      if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
      scrollIdleRef.current = window.setTimeout(() => {
        scrollingRef.current = false;
        scrollIdleRef.current = null;
        if (!pendingMeasureRef.current) return;
        pendingMeasureRef.current = false;
        setMeasureVersion((version) => version + 1);
      }, 120);
    };
    const read = () => {
      const nextTop = viewport.scrollTop;
      const nextHeight = viewport.clientHeight;
      const distance = viewport.scrollHeight - nextTop - nextHeight;
      const movedUp = nextTop < scrollTopRef.current - 1;
      const nearBottom = distance <= 200;
      nearBottomRef.current = nearBottom;
      const echoed =
        pendingScrollRef.current !== null && Math.abs(nextTop - pendingScrollRef.current) < 2;
      pendingScrollRef.current = null;
      if (!echoed) {
        searchLockRef.current = false;
        // Stay with the live edge until the user actually scrolls up. A wheel
        // tick that does not move the viewport must not hide the next reply.
        if (nearBottom) {
          followRef.current = true;
          setStickToTail(true);
        } else {
          // Any position above the live edge has to leave the tail pin.
          // Otherwise the window ignores scrollTop and the latest rows stay
          // mounted while the user is looking further up.
          setStickToTail(false);
          if (movedUp) followRef.current = false;
        }
        if (distance > 1) markScrolling();
      }

      scrollTopRef.current = nextTop;
      // The mounted rows have to track the viewport. Updating only when the
      // window indexes change left a blank gap and hid a reply that arrived
      // just below the old offset.
      setScrollTop((current) => (Math.abs(current - nextTop) < 1 ? current : nextTop));
      setViewportHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    const previousAnchor = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = 'none';
    read();
    viewport.addEventListener('scroll', read, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            setViewportHeight(viewport.clientHeight);
          });
    observer?.observe(viewport);
    return () => {
      viewport.style.overflowAnchor = previousAnchor;
      viewport.removeEventListener('scroll', read);
      observer?.disconnect();
      if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
    };
  }, [heights, messages.length, sessionId]);

  useLayoutEffect(() => {
    const viewport = viewportOf();
    if (!viewport) return;

    if (!positioned) {
      scrollViewportTo(viewport, viewport.scrollHeight - viewport.clientHeight);
      setPositioned(true);
      return;
    }

    if (
      searchLockRef.current ||
      (!followRef.current && !nearBottomRef.current && !stickToTail)
    )
      return;
    const nextTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (Math.abs(viewport.scrollTop - nextTop) > 1) {
      scrollViewportTo(viewport, nextTop);
    }
  }, [heights, messages.length, positioned, stickToTail, viewportHeight]);

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
    setStickToTail(false);
    const top = (listRef.current?.offsetTop ?? 0) + messageOffset(heights, focusedIndex);
    scrollViewportTo(viewport, top);
  }, [focusedIndex]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    clearTranscriptHighlights(list);
    const term = searchTerm.trim();
    if (!term || focusedIndex == null || focusedIndex < 0) return;

    const row = list.querySelector(`[data-message-index="${focusedIndex}"]`);
    if (!(row instanceof HTMLElement)) return;

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
  }, [
    focusedIndex,
    measureVersion,
    searchCaseSensitive,
    searchOccurrence,
    searchTerm,
    windowRange.end,
    windowRange.start,
  ]);

  useEffect(() => {
    const scrollToEnd = () => {
      const viewport = viewportOf();
      if (!viewport) return;
      searchLockRef.current = false;
      followRef.current = true;
      nearBottomRef.current = true;
      setStickToTail(true);
      // If the tail is already mounted, this is the real end. If it is not,
      // the layout effect scrolls again once the bottom spacer is gone.
      scrollViewportTo(viewport, viewport.scrollHeight - viewport.clientHeight);
    };

    window.addEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, scrollToEnd);
    return () => window.removeEventListener(AppEvents.SCROLL_CHAT_TO_BOTTOM, scrollToEnd);
  }, []);

  useEffect(() => {
    if (messages.length === 0) return;
    const completedKey = sessionId;
    if (completedSessionRef.current === completedKey) return;

    const timeout = window.setTimeout(() => {
      completedSessionRef.current = completedKey;
      onRenderingComplete?.();
    }, 50);

    return () => window.clearTimeout(timeout);
  }, [messages.length, onRenderingComplete, sessionId]);

  const recordHeight = useCallback((key: string, height: number) => {
    if (height <= 0) return;
    const previous = heightsRef.current.get(key);
    if (previous !== undefined && Math.abs(previous - height) < 1) return;
    heightsRef.current.set(key, height);
    if (scrollingRef.current) {
      pendingMeasureRef.current = true;
      return;
    }
    if (measureFlushRef.current) return;
    measureFlushRef.current = true;
    queueMicrotask(() => {
      measureFlushRef.current = false;
      setMeasureVersion((version) => version + 1);
    });
  }, []);

  const rows = useVisibleRows({
    append,
    end: windowRange.end,
    isStreamingMessage,
    isUserMessage,
    messages,
    onMessageUpdate,
    renderMessage,
    sessionId,
    start: windowRange.start,
    submitElicitationResponse,
    toolCallNotifications,
  });

  return (
    <div
      ref={listRef}
      data-testid="virtual-message-list"
      style={{ overflowAnchor: 'none' }}
    >
      {windowRange.paddingTop > 0 && (
        <div data-testid="virtual-spacer-top" style={{ height: windowRange.paddingTop }} />
      )}
      {messages.slice(windowRange.start, windowRange.end).map((message, offset) => {
        const index = windowRange.start + offset;
        const key = messageKeyOf(message, index);
        return (
          <MeasuredRow key={key} messageKey={key} messageIndex={index} onHeight={recordHeight}>
            {rows[offset]}
          </MeasuredRow>
        );
      })}
      {windowRange.paddingBottom > 0 && (
        <div data-testid="virtual-spacer-bottom" style={{ height: windowRange.paddingBottom }} />
      )}
    </div>
  );
}

function MeasuredRow({
  children,
  messageKey,
  messageIndex,
  onHeight,
}: {
  children: ReactNode;
  messageKey: string;
  messageIndex: number;
  onHeight: (messageKey: string, height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      onHeight(messageKey, element.getBoundingClientRect().height);
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [messageKey, onHeight]);

  return (
    <div
      ref={ref}
      data-message-index={messageIndex}
      style={{ display: 'flow-root', position: 'relative' }}
    >
      {children}
    </div>
  );
}

function BatchedMessageList({
  messages,
  sessionId,
  toolCallNotifications = emptyToolCallNotifications,
  append = emptyAppend,
  isUserMessage,
  isStreamingMessage = false,
  onMessageUpdate,
  onRenderingComplete,
  submitElicitationResponse,
  focusedIndex = null,
  searchTerm = '',
  searchCaseSensitive = false,
  searchOccurrence = 0,
}: ProgressiveMessageListProps) {
  const intl = useIntl();
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
  }, [
    batchDelay,
    batchSize,
    isLoading,
    messages.length,
    renderedCount,
    showLoadingThreshold,
  ]);

  useEffect(() => {
    onRenderingComplete?.();
  }, [messages.length, onRenderingComplete, sessionId]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    clearTranscriptHighlights(list);
    const term = searchTerm.trim();
    if (!term || focusedIndex == null || focusedIndex < 0) return;
    const row = list.querySelector(`[data-message-index="${focusedIndex}"]`);
    if (!(row instanceof HTMLElement)) return;
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
    <div ref={listRef}>
      {rows}

      {isLoading && (
        <div className="flex flex-col items-center justify-center py-8">
          <LoadingGoose
            message={intl.formatMessage(i18n.loadingMessages, {
              renderedCount,
              totalCount: messages.length,
            })}
          />
        </div>
      )}
    </div>
  );
}
