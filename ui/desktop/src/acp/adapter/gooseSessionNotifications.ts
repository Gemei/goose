import type { GooseSessionNotification_unstable } from '@aaif/goose-acp-client';
import type { Message, MessageUsage } from '../../types/message';
import { type AcpChatStateChange, type AdapterState, messagesChange, withMessageAt } from './shared';

export function applyGooseSessionNotification(
  state: AdapterState,
  notification: GooseSessionNotification_unstable
): AcpChatStateChange[] {
  const update = notification.update;

  switch (update.sessionUpdate) {
    case 'usage_update':
      return [
        {
          type: 'tokenState',
          tokenState: {
            totalTokens: update.used,
            contextLimit: update.contextLimit,
            accumulatedInputTokens: update.accumulatedInputTokens,
            accumulatedOutputTokens: update.accumulatedOutputTokens,
            accumulatedTotalTokens: update.accumulatedInputTokens + update.accumulatedOutputTokens,
            ...(update.accumulatedCost !== undefined
              ? { accumulatedCost: update.accumulatedCost }
              : {}),
          },
        },
      ];
    case 'status_message':
      return applyStatusMessage(state, notification.sessionId, update);
    case 'message_usage':
      return applyMessageUsage(state, update);
    default:
      return [];
  }
}

function applyStatusMessage(
  state: AdapterState,
  sessionId: string,
  update: Extract<GooseSessionNotification_unstable['update'], { sessionUpdate: 'status_message' }>
): AcpChatStateChange[] {
  if (update.status.type === 'progress') {
    return [{ type: 'progressMessage', message: update.status.message }];
  }

  const statusMessage: Message = {
    id: `acp_status_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    role: 'assistant',
    created: Math.floor(Date.now() / 1000),
    content: [
      {
        type: 'systemNotification',
        notificationType: 'inlineMessage',
        msg: update.status.message,
      },
    ],
    metadata: {
      userVisible: true,
      agentVisible: false,
    },
  };

  state.messages = [...state.messages, statusMessage];
  return messagesChange(state);
}

function applyMessageUsage(
  state: AdapterState,
  update: Extract<GooseSessionNotification_unstable['update'], { sessionUpdate: 'message_usage' }>
): AcpChatStateChange[] {
  // Live tool-call turns carry a server-side id the client never saw, so an
  // id miss falls back to the most recent assistant message with provider
  // content - skipping client-made rows (approval cards, status notices).
  const byIndex = findLastMessageIndex(state, (message) =>
    update.messageId ? message.id === update.messageId : false
  );
  const targetIndex =
    byIndex >= 0
      ? byIndex
      : findLastMessageIndex(
          state,
          (message) =>
            message.role === 'assistant' &&
            message.content.some(
              (content) =>
                content.type !== 'actionRequired' && content.type !== 'systemNotification'
            )
        );

  if (targetIndex === -1) {
    return [];
  }

  const usage: MessageUsage = {
    inputTokens: update.usage.inputTokens,
    outputTokens: update.usage.outputTokens,
    totalTokens: update.usage.totalTokens,
    cacheReadTokens: update.usage.cacheReadTokens,
    cacheWriteTokens: update.usage.cacheWriteTokens,
    cost: update.usage.cost,
    costSource: update.usage.costSource,
    elapsedMs: update.usage.elapsedMs,
    timeToFirstTokenMs: update.usage.timeToFirstTokenMs,
    isCompaction: update.usage.isCompaction,
  };

  const target = state.messages[targetIndex];
  state.messages = withMessageAt(state.messages, targetIndex, {
    ...target,
    metadata: { ...target.metadata, usage },
  });
  return messagesChange(state);
}

function findLastMessageIndex(
  state: AdapterState,
  predicate: (message: Message) => boolean
): number {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    if (predicate(state.messages[index])) {
      return index;
    }
  }
  return -1;
}
