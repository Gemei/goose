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
import LoadingGoose from './LoadingGoose';
import { ChatState } from '../types/chatState';
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
import { cancelWheelSmoothing, prefersInstantScroll, smoothScrollTo } from '../utils/smoothScroll';

// Rejoin the live edge only when the user is actually at the bottom. A 200px
// band kept follow on through wheel ticks, so streaming height growth snapped
// the viewport back before they could leave the tail.
const FOLLOW_RESUME_PX = 48;
// Long chats mount the live tail first, then older cards in idle batches.
// After historyStart hits 0 every card stays in document flow so a wheel
// tick never mounts GooseMessage. That load can take a few seconds.
const HISTORY_TAIL = 32;
const HISTORY_BATCH = 6;
const HISTORY_BATCH_MS = 32;
const LIVE_TAIL = 12;

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
  loadingHistory: {
    id: 'messageList.loadingHistory',
    defaultMessage: 'Chat is loading',
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
        style={{ contain: 'layout' }}
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
        style={{ contain: 'layout' }}
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
  onMessageUpdate?: MessageListProps['onMessageUpdate'];
  renderMessage?: MessageListProps['renderMessage'];
  sessionId: string;
  submitElicitationResponse?: MessageListProps['submitElicitationResponse'];
  toolCallNotifications: Map<string, NotificationEvent[]>;
}

function buildVisibleRows({
  append,
  end,
  intl,
  isStreamingMessage,
  isUserMessage,
  messages,
  onMessageUpdate,
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
  const initialStart = initialHistoryStart(messages.length);
  const [historyStart, setHistoryStart] = useState(initialStart);
  const [historySettled, setHistorySettled] = useState(initialStart === 0);
  const followRef = useRef(true);
  const positionedRef = useRef(false);
  const pendingScrollRef = useRef<number | null>(null);
  const smoothingRef = useRef(false);
  const cancelSmoothRef = useRef<(() => void) | null>(null);
  const searchLockRef = useRef(false);
  const scrollTopRef = useRef(0);
  const loadingHistoryRef = useRef(false);
  const completedSessionRef = useRef<string | null>(null);
  const sessionRef = useRef(sessionId);
  const messagesLengthRef = useRef(messages.length);
  messagesLengthRef.current = messages.length;

  const loadingHistory = historyStart > 0 || !historySettled;
  loadingHistoryRef.current = loadingHistory;

  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    const start = initialHistoryStart(messagesLengthRef.current);
    setHistoryStart(start);
    setHistorySettled(start === 0);
    followRef.current = true;
    positionedRef.current = false;
    completedSessionRef.current = null;
  }, [sessionId]);

  useEffect(() => {
    if (historyStart <= 0) return;
    const timeout = window.setTimeout(() => {
      startTransition(() => {
        setHistoryStart((start) => Math.max(0, start - HISTORY_BATCH));
      });
    }, HISTORY_BATCH_MS);
    return () => window.clearTimeout(timeout);
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
      cancelSmoothRef.current = smoothScrollTo(viewport, nextTop);
    } else {
      smoothingRef.current = false;
      viewport.scrollTop = nextTop;
    }
    pendingScrollRef.current = nextTop;
    scrollTopRef.current = viewport.scrollTop;
  };

  useEffect(() => {
    const viewport = viewportOf();
    if (!viewport) return;

    const pinToEnd = () => {
      cancelWheelSmoothing(viewport);
      const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      viewport.scrollTop = end;
      pendingScrollRef.current = end;
      scrollTopRef.current = viewport.scrollTop;
    };

    const read = () => {
      if (loadingHistoryRef.current) {
        pinToEnd();
        return;
      }

      const nextTop = viewport.scrollTop;
      const distance = viewport.scrollHeight - nextTop - viewport.clientHeight;
      const movedUp = nextTop < scrollTopRef.current - 1;
      const atLiveEdge = distance <= FOLLOW_RESUME_PX;
      const echoed =
        pendingScrollRef.current !== null && Math.abs(nextTop - pendingScrollRef.current) < 2;
      pendingScrollRef.current = null;

      if (smoothingRef.current) {
        if (atLiveEdge || echoed) {
          smoothingRef.current = false;
          followRef.current = true;
        }
      } else if (!echoed) {
        searchLockRef.current = false;
        if (movedUp && !atLiveEdge) {
          followRef.current = false;
        } else if (atLiveEdge) {
          followRef.current = true;
        }
      }
      scrollTopRef.current = nextTop;
    };

    const blockWhileLoading = (event: WheelEvent) => {
      if (!loadingHistoryRef.current) return;
      event.preventDefault();
      pinToEnd();
    };

    read();
    const cancelSmooth = () => {
      if (!smoothingRef.current) return;
      cancelSmoothRef.current?.();
      cancelSmoothRef.current = null;
      smoothingRef.current = false;
    };
    viewport.addEventListener('scroll', read, { passive: true });
    viewport.addEventListener('wheel', blockWhileLoading, { passive: false });
    viewport.addEventListener('wheel', cancelSmooth, { passive: true });
    viewport.addEventListener('pointerdown', cancelSmooth);
    return () => {
      viewport.removeEventListener('scroll', read);
      viewport.removeEventListener('wheel', blockWhileLoading);
      viewport.removeEventListener('wheel', cancelSmooth);
      viewport.removeEventListener('pointerdown', cancelSmooth);
    };
  }, [sessionId]);

  useLayoutEffect(() => {
    const viewport = viewportOf();
    if (!viewport) return;
    if (searchLockRef.current || smoothingRef.current) return;
    const pinToLiveEdge = !positionedRef.current || loadingHistory || followRef.current;
    if (!pinToLiveEdge) return;
    scrollViewportTo(viewport, viewport.scrollHeight - viewport.clientHeight);
    positionedRef.current = true;
  }, [historyStart, loadingHistory, messages, isStreamingMessage]);

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
      const instant = prefersInstantScroll();
      followRef.current = instant;
      scrollViewportTo(viewport, viewport.scrollHeight - viewport.clientHeight, true);
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
      onRenderingComplete?.();
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [loadingHistory, messages.length, onRenderingComplete, sessionId]);

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
      style={{ overflowAnchor: 'auto' }}
    >
      {historyRows}
      {liveRows}
      {loadingHistory && (
        <div
          data-testid="history-loading-overlay"
          className="flex justify-center py-2"
          style={{
            position: 'sticky',
            bottom: 8,
            zIndex: 20,
            pointerEvents: 'none',
            overflowAnchor: 'none',
          }}
        >
          <div className="rounded-full border border-border-primary bg-background-primary/95 px-3 shadow-sm">
            <LoadingGoose
              chatState={ChatState.LoadingConversation}
              message={intl.formatMessage(i18n.loadingHistory)}
            />
          </div>
        </div>
      )}
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
  onRenderingComplete,
  submitElicitationResponse,
  focusedIndex = null,
  searchTerm = '',
  searchCaseSensitive = false,
  searchOccurrence = 0,
}: MessageListProps) {
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
