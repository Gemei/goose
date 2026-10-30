import type {
  ContentBlock as AcpContentBlock,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ContentBlock, Message } from '../../types/message';
import {
  type AcpChatStateChange,
  type AdapterState,
  DEFAULT_VISIBLE_MESSAGE_METADATA,
  getGooseMessageMeta,
  messagesChange,
  metadataWithInferenceMeta,
  withMessageAt,
} from './shared';

type StreamedContentBlock = Extract<ContentBlock, { type: 'text' | 'image' }>;

export interface MessageLocation {
  message: Message;
  index: number;
}

export function applyContentChunk(
  state: AdapterState,
  role: Message['role'],
  update: Extract<
    SessionNotification['update'],
    { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' }
  >
): AcpChatStateChange[] {
  const content = messageContentFromAcpContentBlock(update.content);
  if (!content) {
    return [];
  }

  const gooseMeta = getGooseMessageMeta(update);
  const messageId = update.messageId ?? gooseMeta.messageId;
  const existing = findMessageForChunk(state, role, messageId, gooseMeta.created, gooseMeta.steer);

  if (existing) {
    const isOutputLimitFallbackChunk =
      gooseMeta.outputTokenLimitReached === true && gooseMeta.fallbackContent === true;
    const existingMessageHasContent = existing.message.content.length > 0;
    const shouldSkipFallbackChunk = isOutputLimitFallbackChunk && existingMessageHasContent;

    let metadata: Message['metadata'] = {
      ...existing.message.metadata,
      outputTokenLimitReached: gooseMeta.outputTokenLimitReached,
      fallbackContent: shouldSkipFallbackChunk ? undefined : gooseMeta.fallbackContent,
    };
    if (gooseMeta.operationLogs) {
      metadata.operationLogs = gooseMeta.operationLogs;
    }
    metadata = metadataWithInferenceMeta(metadata, role, gooseMeta);
    let merged: Message = { ...existing.message, metadata };

    if (shouldSkipFallbackChunk) {
      return commitMessage(state, existing.index, merged, gooseMeta.steer);
    }

    const steerContent = reconcileLocalSteerTextChunk(state, merged, content, gooseMeta.steer);
    if (steerContent) {
      merged = { ...merged, content: steerContent };
      return commitMessage(state, existing.index, merged, gooseMeta.steer);
    }

    const lastContent = merged.content[merged.content.length - 1];
    if (lastContent?.type === 'text' && content.type === 'text') {
      merged = {
        ...merged,
        content: [
          ...merged.content.slice(0, -1),
          { ...lastContent, text: lastContent.text + content.text },
        ],
      };
    } else if (content.type === 'image' && hasImageContent(merged, content)) {
      return commitMessage(state, existing.index, merged, gooseMeta.steer);
    } else {
      merged = { ...merged, content: [...merged.content, content] };
    }

    return commitMessage(state, existing.index, merged, gooseMeta.steer);
  }

  const message: Message = {
    ...(messageId ? { id: messageId } : {}),
    role,
    created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
    content: [content],
    metadata: metadataWithInferenceMeta(
      {
        ...DEFAULT_VISIBLE_MESSAGE_METADATA,
        ...(gooseMeta.steer ? { steer: true } : {}),
        outputTokenLimitReached: gooseMeta.outputTokenLimitReached,
        fallbackContent: gooseMeta.fallbackContent,
        ...(gooseMeta.operationLogs ? { operationLogs: gooseMeta.operationLogs } : {}),
      },
      role,
      gooseMeta
    ),
  };

  state.messages = [...state.messages, message];

  return messagesChange(state);
}

export function applyThoughtChunk(
  state: AdapterState,
  update: Extract<SessionNotification['update'], { sessionUpdate: 'agent_thought_chunk' }>
): AcpChatStateChange[] {
  if (update.content.type !== 'text') {
    return [];
  }

  const gooseMeta = getGooseMessageMeta(update);
  const messageId = update.messageId ?? gooseMeta.messageId;
  const existing = findMessageForChunk(
    state,
    'assistant',
    messageId,
    gooseMeta.created,
    gooseMeta.steer
  );

  let message: Message;
  if (existing) {
    message = existing.message;
  } else {
    message = {
      ...(messageId ? { id: messageId } : {}),
      role: 'assistant',
      created: gooseMeta.created ?? Math.floor(Date.now() / 1000),
      content: [],
      metadata: { ...DEFAULT_VISIBLE_MESSAGE_METADATA },
    };
  }

  const metadata = metadataWithInferenceMeta(
    {
      ...message.metadata,
      outputTokenLimitReached: gooseMeta.outputTokenLimitReached,
      ...(gooseMeta.operationLogs ? { operationLogs: gooseMeta.operationLogs } : {}),
    },
    'assistant',
    gooseMeta
  );

  const lastContent = message.content[message.content.length - 1];
  const content: Message['content'] = lastContent?.type === 'thinking'
    ? [
        ...message.content.slice(0, -1),
        {
          ...lastContent,
          thinking: lastContent.thinking + update.content.text,
        },
      ]
    : [...message.content, { type: 'thinking', thinking: update.content.text, signature: '' }];

  const nextMessage: Message = { ...message, metadata, content };
  state.messages = existing
    ? withMessageAt(state.messages, existing.index, nextMessage)
    : [...state.messages, nextMessage];
  return messagesChange(state);
}

function messageContentFromAcpContentBlock(
  content: AcpContentBlock
): StreamedContentBlock | undefined {
  switch (content.type) {
    case 'text':
      return {
        type: 'text',
        text: content.text,
        ...(content._meta ? { _meta: content._meta } : {}),
        ...(content.annotations ? { annotations: content.annotations } : {}),
      };
    case 'image':
      return {
        type: 'image',
        data: content.data,
        mimeType: content.mimeType,
        ...(content._meta ? { _meta: content._meta } : {}),
        ...(content.annotations ? { annotations: content.annotations } : {}),
      };
    default:
      return undefined;
  }
}

/**
 * Provider completion ids are reused across turns. Only the copy that is still
 * at the end of the transcript (no later message with a different id) can
 * take another chunk. An older copy must not swallow the new reply.
 */
export function findActiveMessageById(
  state: AdapterState,
  role: Message['role'] | undefined,
  messageId: string
): MessageLocation | undefined {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.id !== messageId) continue;
    if (role && message.role !== role) continue;
    const separated = state.messages
      .slice(index + 1)
      .some((later) => later.id !== messageId);
    if (separated) return undefined;
    return { message, index };
  }
  return undefined;
}

export function findMessageForChunk(
  state: AdapterState,
  role: Message['role'],
  messageId: string | undefined,
  created: number | undefined,
  isSteerChunk: boolean | undefined
): MessageLocation | undefined {
  if (!messageId) {
    const lastMessage = lastMergeableMessageWithRole(state, role);
    if (!lastMessage) {
      return undefined;
    }
    return { message: lastMessage, index: state.messages.length - 1 };
  }

  const existing = findActiveMessageById(state, role, messageId);
  if (existing) {
    return existing;
  }

  // Steer echo ids are assigned once per queued steer, unlike provider
  // completion ids that are reused across turns, so a steer chunk keeps
  // targeting its row even after newer rows (another queued steer) moved it
  // off the transcript tail.
  if (isSteerChunk) {
    for (let index = state.messages.length - 1; index >= 0; index--) {
      const message = state.messages[index];
      if (message.id !== messageId) continue;
      if (message.role !== role || !message.metadata.steer) continue;
      return { message, index };
    }
  }

  const pendingIndex = lastMergeableMessageIndexWithRole(state, role);
  if (pendingIndex === undefined) {
    return undefined;
  }

  const pending = state.messages[pendingIndex];
  if (pending.id) {
    return undefined;
  }

  const adopted: Message = { ...pending, id: messageId, created: created ?? pending.created };
  state.messages = withMessageAt(state.messages, pendingIndex, adopted);
  return { message: adopted, index: pendingIndex };
}

function lastMergeableMessageIndexWithRole(
  state: AdapterState,
  role: Message['role']
): number | undefined {
  const index = state.messages.length - 1;
  const lastMessage = state.messages[index];
  if (lastMessage?.role !== role || lastMessage.metadata.agentVisible === false) {
    return undefined;
  }
  return index;
}

function lastMergeableMessageWithRole(
  state: AdapterState,
  role: Message['role']
): Message | undefined {
  const index = lastMergeableMessageIndexWithRole(state, role);
  return index === undefined ? undefined : state.messages[index];
}

function hasImageContent(
  message: Message,
  image: Extract<StreamedContentBlock, { type: 'image' }>
) {
  return message.content.some(
    (content) =>
      content.type === 'image' && content.data === image.data && content.mimeType === image.mimeType
  );
}

function messagesChangeWithLocalSteerConfirmation(
  state: AdapterState,
  message: Message,
  isSteerChunk: boolean | undefined
): AcpChatStateChange[] {
  const changes = messagesChange(state);
  if (isSteerChunk && message.metadata.steer && message.role === 'user' && message.id) {
    changes.push({ type: 'localSteerConfirmed', messageId: message.id });
  }
  return changes;
}

function commitMessage(
  state: AdapterState,
  index: number,
  message: Message,
  isSteerChunk: boolean | undefined
): AcpChatStateChange[] {
  state.messages = withMessageAt(state.messages, index, message);
  return messagesChangeWithLocalSteerConfirmation(state, message, isSteerChunk);
}

function reconcileLocalSteerTextChunk(
  state: AdapterState,
  message: Message,
  content: StreamedContentBlock,
  isSteerChunk: boolean | undefined
): Message['content'] | undefined {
  if (!isSteerChunk || !message.metadata.steer || message.role !== 'user') {
    return undefined;
  }

  if (
    content.type !== 'text' ||
    message.content.length === 0 ||
    message.content[0].type !== 'text'
  ) {
    return undefined;
  }

  const text = (message.id ? state.localSteerTextByMessageId.get(message.id) : undefined) ?? '';
  const nextText = text + content.text;
  if (message.id) {
    state.localSteerTextByMessageId.set(message.id, nextText);
  }

  return [{ ...content, text: nextText }, ...message.content.slice(1)];
}