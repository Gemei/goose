import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { TokenState } from '../../types/chat';
import type { InferenceMetadata, Message, NotificationEvent } from '../../types/message';

export type AcpChatStateChange =
  | { type: 'messages'; messages: Message[] }
  | { type: 'tokenState'; tokenState: Partial<TokenState> }
  | { type: 'progressMessage'; message: string | undefined }
  | {
      type: 'sessionInfo';
      name?: string;
      activeRunId?: string | null;
      gooseMode?: string;
    }
  | { type: 'localSteerConfirmed'; messageId: string }
  | { type: 'notification'; notification: NotificationEvent };

export interface AdapterState {
  messages: Message[];
  localSteerTextByMessageId: Map<string, string>;
  toolCallStatesById: Map<string, ToolCallState>;
}

export type ToolCallState = Omit<ToolCallUpdate, '_meta'>;

export interface GooseMessageMeta {
  messageId?: string;
  created?: number;
  outputTokenLimitReached?: boolean;
  fallbackContent?: boolean;
  operationLogs?: string[];
  steer?: boolean;
  inference?: InferenceMetadata;
}

export interface ToolIdentity {
  toolName?: string;
  extensionName?: string;
}

export const DEFAULT_VISIBLE_MESSAGE_METADATA: Message['metadata'] = {
  userVisible: true,
  agentVisible: true,
};

export function messagesChange(state: AdapterState): AcpChatStateChange[] {
  // Adapter code never mutates a message object or its array after emission
  // (each update clones the touched message and rebuilds the array), so the
  // store can adopt the live array by reference with no per-notification
  // deep clone.
  return [{ type: 'messages', messages: state.messages }];
}

export function cloneMessage(message: Message): Message {
  return {
    ...message,
    content: message.content.map((content) => ({ ...content })),
    metadata: { ...message.metadata },
  };
}

export function getGooseMessageMeta(update: { _meta?: unknown }): GooseMessageMeta {
  if (!isRecord(update._meta)) {
    return {};
  }

  const goose = update._meta.goose;
  if (!isRecord(goose)) {
    return {};
  }

  const outputTokenLimitReached = goose.outputTokenLimitReached === true;
  const operationLogs = Array.isArray(goose.operationLogs)
    ? goose.operationLogs.filter((line): line is string => typeof line === 'string')
    : undefined;

  return {
    created: typeof goose.created === 'number' ? goose.created : undefined,
    messageId: typeof goose.messageId === 'string' ? goose.messageId : undefined,
    outputTokenLimitReached: outputTokenLimitReached ? true : undefined,
    fallbackContent: goose.fallbackContent === true ? true : undefined,
    operationLogs,
    steer: goose.steer === true ? true : undefined,
    inference: getInferenceMeta(goose.inference),
  };
}

function getInferenceMeta(inference: unknown): InferenceMetadata | undefined {
  if (
    !isRecord(inference) ||
    typeof inference.provider !== 'string' ||
    typeof inference.requestedModel !== 'string'
  ) {
    return undefined;
  }

  return {
    provider: inference.provider,
    requestedModel: inference.requestedModel,
    ...(typeof inference.resolvedModel === 'string'
      ? { resolvedModel: inference.resolvedModel }
      : {}),
  };
}

export function metadataWithInferenceMeta(
  metadata: Message['metadata'],
  role: Message['role'],
  gooseMeta: GooseMessageMeta
): Message['metadata'] {
  if (role === 'assistant' && gooseMeta.inference) {
    return { ...metadata, inference: gooseMeta.inference };
  }
  return metadata;
}

export function withMessageAt(messages: Message[], index: number, next: Message): Message[] {
  // An index equal to the array length appends; otherwise the slot is replaced.
  if (index >= messages.length) {
    return [...messages, next];
  }
  const rebuilt = messages.slice();
  rebuilt[index] = next;
  return rebuilt;
}

export function getGooseActiveRunId(update: { _meta?: unknown }): string | null | undefined {
  if (!isRecord(update._meta)) {
    return undefined;
  }

  const goose = update._meta.goose;
  if (!isRecord(goose) || !('activeRunId' in goose)) {
    return undefined;
  }

  return typeof goose.activeRunId === 'string' || goose.activeRunId === null
    ? goose.activeRunId
    : undefined;
}

export function getGooseQueuedSteer(update: { _meta?: unknown }): string | undefined {
  if (!isRecord(update._meta)) return undefined;
  const goose = update._meta.goose;
  if (!isRecord(goose) || !isRecord(goose.queuedSteer)) return undefined;
  return typeof goose.queuedSteer.messageId === 'string' ? goose.queuedSteer.messageId : undefined;
}

export function rawInputToArguments(rawInput: unknown): Record<string, unknown> {
  return isRecord(rawInput) ? rawInput : {};
}

export function toolIdentity(update: ToolCall | ToolCallUpdate): ToolIdentity {
  if (!isRecord(update._meta)) {
    return {};
  }

  const goose = update._meta.goose;
  if (!isRecord(goose) || !isRecord(goose.toolCall)) {
    return {};
  }

  return {
    toolName: typeof goose.toolCall.toolName === 'string' ? goose.toolCall.toolName : undefined,
    extensionName:
      typeof goose.toolCall.extensionName === 'string' ? goose.toolCall.extensionName : undefined,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
