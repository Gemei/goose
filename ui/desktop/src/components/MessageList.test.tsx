import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImageData, InferenceMetadata, Message, MessageContent } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import MessageList from './MessageList';

const renderCounts = vi.hoisted(() => new Map<string, number>());
const messageUpdateCallbacks = vi.hoisted(
  () =>
    new Map<
      string,
      | ((
          messageId: string,
          newContent: string,
          editType: 'fork' | 'edit',
          retainedImages: ImageData[]
        ) => void)
      | undefined
    >()
);

vi.mock('./GooseMessage', () => ({
  default: ({ message }: { message: Message }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <div>{id}</div>;
  },
}));

vi.mock('./UserMessage', () => ({
  default: ({
    message,
    onMessageUpdate,
  }: {
    message: Message;
    onMessageUpdate?: (
      messageId: string,
      newContent: string,
      editType: 'fork' | 'edit',
      retainedImages: ImageData[]
    ) => void;
  }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    messageUpdateCallbacks.set(id, onMessageUpdate);
    return <div>{id}</div>;
  },
}));

const visibleMetadata: Message['metadata'] = { agentVisible: true, userVisible: true };
const append = vi.fn();
const isUserMessage = (message: Message) => message.role === 'user';

function message(id: string, role: Message['role'], content: MessageContent[]): Message {
  return { id, role, created: 1, content, metadata: visibleMetadata };
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((item) => ({
    ...item,
    content: item.content.map((content) => ({ ...content })),
    metadata: { ...item.metadata },
  }));
}

function toolRequest(id: string): MessageContent {
  return {
    type: 'toolRequest',
    id,
    toolCall: {
      status: 'success',
      value: { name: 'test_tool', arguments: {} },
    },
  };
}

function toolResponse(id: string): MessageContent {
  return {
    type: 'toolResponse',
    id,
    toolResult: {
      status: 'success',
      value: { content: [{ type: 'text', text: 'complete' }], isError: false },
    },
  };
}

function renderList(messages: Message[]) {
  return render(
    <MessageList
      messages={messages}
      sessionId="test-session"
      append={append}
      isUserMessage={isUserMessage}
    />,
    { wrapper: IntlTestWrapper }
  );
}

beforeEach(() => {
  vi.mocked(window.electron.on).mockClear();
  vi.mocked(window.electron.off).mockClear();
});

describe('MessageList render isolation', () => {
  beforeEach(() => {
    renderCounts.clear();
    messageUpdateCallbacks.clear();
    append.mockClear();
  });

  it('does not rerender historical rows from cloned equivalent messages', () => {
    const messages = [
      message('assistant-1', 'assistant', [{ type: 'text', text: 'First' }]),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      message('assistant-2', 'assistant', [{ type: 'text', text: 'Streaming' }]),
    ];
    const { rerender } = renderList(messages);

    rerender(
      <MessageList
        messages={cloneMessages(messages)}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts).toEqual(
      new Map([
        ['assistant-1', 1],
        ['user-1', 1],
        ['assistant-2', 1],
      ])
    );

    const updatedMessages = cloneMessages(messages);
    updatedMessages[2].content = [{ type: 'text', text: 'Streaming update' }];
    rerender(
      <MessageList
        messages={updatedMessages}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts).toEqual(
      new Map([
        ['assistant-1', 1],
        ['user-1', 1],
        ['assistant-2', 2],
      ])
    );
  });

  it('rerenders the matching request row when a tool response arrives', () => {
    const messages = [
      message('tool-request', 'assistant', [toolRequest('tool-1')]),
      message('unrelated', 'assistant', [{ type: 'text', text: 'Unrelated' }]),
      message('tool-response', 'user', []),
    ];
    const { rerender } = renderList(messages);
    const updatedMessages = cloneMessages(messages);
    updatedMessages[2].content = [toolResponse('tool-1')];

    rerender(
      <MessageList
        messages={updatedMessages}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
      />
    );

    expect(renderCounts.get('tool-request')).toBe(2);
    expect(renderCounts.get('unrelated')).toBe(1);
  });

  it('preserves the message update callback', () => {
    const onMessageUpdate = vi.fn();
    render(
      <MessageList
        messages={[message('user-1', 'user', [{ type: 'text', text: 'Original' }])]}
        sessionId="test-session"
        append={append}
        isUserMessage={isUserMessage}
        onMessageUpdate={onMessageUpdate}
      />,
      { wrapper: IntlTestWrapper }
    );
    const retainedImages: ImageData[] = [{ data: 'image', mimeType: 'image/png' }];

    messageUpdateCallbacks.get('user-1')?.('user-1', 'Updated', 'fork', retainedImages);

    expect(onMessageUpdate).toHaveBeenCalledWith('user-1', 'Updated', 'fork', retainedImages);
  });
});

describe('MessageList model change disclosure', () => {
  function assistantWithModel(id: string, inference: InferenceMetadata): Message {
    return {
      ...message(id, 'assistant', [{ type: 'text', text: id }]),
      metadata: { ...visibleMetadata, inference },
    };
  }

  it('labels models that the provider did not confirm as requested', () => {
    renderList([
      assistantWithModel('assistant-1', { provider: 'test', requestedModel: 'model-a' }),
      message('user-1', 'user', [{ type: 'text', text: 'Switch model' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-b' }),
    ]);

    expect(
      screen.getByText('Model changed: model-a (requested) → model-b (requested)')
    ).toBeInTheDocument();
  });

  it('shows a resolved model without the requested label', () => {
    renderList([
      assistantWithModel('assistant-1', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
      message('user-1', 'user', [{ type: 'text', text: 'Switch model' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-b' }),
    ]);

    expect(
      screen.getByText('Model changed: model-a-2026-01-01 → model-b (requested)')
    ).toBeInTheDocument();
  });

  it('does not report a change when only the resolved model is missing', () => {
    renderList([
      assistantWithModel('assistant-1', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-a' }),
      message('user-2', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-3', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
    ]);

    expect(screen.queryByText(/Model changed/)).toBeNull();
  });

  it('compares a resolved model with the last resolved one after a reply without one', () => {
    renderList([
      assistantWithModel('assistant-1', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-01-01',
      }),
      message('user-1', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-2', { provider: 'test', requestedModel: 'model-a' }),
      message('user-2', 'user', [{ type: 'text', text: 'Continue' }]),
      assistantWithModel('assistant-3', {
        provider: 'test',
        requestedModel: 'model-a',
        resolvedModel: 'model-a-2026-02-01',
      }),
    ]);

    expect(
      screen.getByText('Model changed: model-a-2026-01-01 → model-a-2026-02-01')
    ).toBeInTheDocument();
  });
});


