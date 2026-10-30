import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ImageData, Message, MessageContent } from '../types/message';
import { IntlTestWrapper } from '../i18n/test-utils';
import MessageList from './MessageList';
import { endUserGesture, endUserInput } from '../utils/smoothScroll';

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

describe('MessageList batching', () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(`assistant-${index}`, 'assistant', [{ type: 'text', text: `Message ${index}` }])
  );

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderBatchedList(onRenderingComplete = vi.fn()) {
    render(
      <StrictMode>
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            batchSize={2}
            batchDelay={20}
            showLoadingThreshold={0}
            onRenderingComplete={onRenderingComplete}
          />
        </IntlTestWrapper>
      </StrictMode>
    );
    return onRenderingComplete;
  }

  it('renders exactly one batch per delay in StrictMode', () => {
    renderBatchedList();

    expect(screen.queryByText('assistant-1')).not.toBeNull();
    expect(screen.queryByText('assistant-2')).toBeNull();

    act(() => vi.advanceTimersByTime(20));
    expect(screen.queryByText('assistant-3')).not.toBeNull();
    expect(screen.queryByText('assistant-4')).toBeNull();

    act(() => vi.advanceTimersByTime(20));
    expect(screen.queryByText('assistant-5')).not.toBeNull();
    expect(screen.queryByText('assistant-6')).toBeNull();
  });

  it('reports completion once after the final batch', () => {
    const onRenderingComplete = renderBatchedList();

    for (let batch = 0; batch < 4; batch++) {
      act(() => vi.advanceTimersByTime(20));
    }
    expect(screen.queryByText('assistant-9')).not.toBeNull();
    expect(onRenderingComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(50));
    expect(onRenderingComplete).toHaveBeenCalledTimes(1);
  });
});

describe('MessageList virtualization', () => {
  beforeEach(() => {
    // Gesture/input clocks are module state shared across tests in this file.
    endUserGesture();
    endUserInput();
  });

  const messages = Array.from({ length: 80 }, (_, index) =>
    message(`assistant-${index}`, 'assistant', [{ type: 'text', text: `Message ${index}` }])
  );

  function renderVirtualList() {
    return render(
      <IntlTestWrapper>
        <MessageList
          messages={messages}
          sessionId="test-session"
          append={append}
          isUserMessage={isUserMessage}
          showLoadingThreshold={50}
        />
      </IntlTestWrapper>
    );
  }

  it('mounts the full transcript so later scrolling does not build cards', () => {
    renderVirtualList();

    expect(screen.queryByText('assistant-79')).not.toBeNull();
    expect(screen.queryByText('assistant-0')).not.toBeNull();
    expect(screen.getAllByText(/assistant-/).length).toBe(80);
    expect(screen.queryByTestId('history-loading-overlay')).toBeNull();
  });

  it('mounts earlier rows when the transcript is scrolled up', () => {
    const { container } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 20000 });

    act(() => {
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
      viewport.scrollTop = 120;
      viewport.dispatchEvent(new Event('scroll'));
    });

    expect(screen.queryByText('assistant-0')).not.toBeNull();
    expect(messages).toHaveLength(80);
  });

  it('keeps a new reply visible when a wheel tick does not leave the bottom', () => {
    const { container, rerender } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    let scrollHeight = 12800;
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    act(() => {
      viewport.scrollTop = scrollHeight - viewport.clientHeight;
      viewport.dispatchEvent(new Event('scroll'));
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
    });
    const bottomBeforeReply = viewport.scrollTop;

    scrollHeight = 12960;
    const next = [
      ...messages,
      message('assistant-80', 'assistant', [{ type: 'text', text: 'Message 80' }]),
    ];
    rerender(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={next}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );

    expect(screen.queryByText('assistant-80')).not.toBeNull();
    expect(viewport.scrollTop).toBeGreaterThan(bottomBeforeReply);
  });

  it('re-pins the live edge when rows grow after the load settles', async () => {
    const resizeCallbacks: Array<() => void> = [];
    class TestResizeObserver {
      constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {
        resizeCallbacks.push(() => this.callback([], this));
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const original = window.ResizeObserver;
    window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
    if (typeof window.requestAnimationFrame !== 'function') {
      window.requestAnimationFrame = ((cb: (ts: number) => void) =>
        window.setTimeout(
          () => cb(performance.now()),
          16
        )) as unknown as typeof window.requestAnimationFrame;
      window.cancelAnimationFrame = ((id: number) =>
        window.clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
    }

    try {
      const { container } = render(
        <div data-radix-scroll-area-viewport data-testid="viewport">
          <IntlTestWrapper>
            <MessageList
              messages={messages}
              sessionId="test-session"
              append={append}
              isUserMessage={isUserMessage}
              showLoadingThreshold={50}
            />
          </IntlTestWrapper>
        </div>
      );
      const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
      if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
      Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
      let scrollHeight = 12800;
      Object.defineProperty(viewport, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight,
      });

      await act(async () => {
        viewport.scrollTop = scrollHeight - viewport.clientHeight;
        viewport.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 40));
      });

      // After hydration settles the idle reveal pass converts earlier rows
      // from their 160px content-visibility estimate. The transcript grows
      // with no render and no batch pin; the growth pin must keep the reader
      // glued to the live edge instead of stranding them above it.
      scrollHeight = 13600;
      await act(async () => {
        for (const fire of resizeCallbacks) fire();
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      expect(viewport.scrollTop).toBe(scrollHeight - viewport.clientHeight);
    } finally {
      window.ResizeObserver = original;
    }
  });

  it('does not snap back to the tail after the user scrolls up during a new reply', async () => {
    const { container, rerender } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    let scrollHeight = 12800;
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    await act(async () => {
      viewport.scrollTop = scrollHeight - viewport.clientHeight;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const afterScrollUp = scrollHeight - viewport.clientHeight - 80;
    await act(async () => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })
      );
      viewport.scrollTop = afterScrollUp;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    scrollHeight = 13200;
    const next = [
      ...messages,
      message('assistant-80', 'assistant', [{ type: 'text', text: 'Message 80' }]),
    ];
    rerender(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={next}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );

    expect(viewport.scrollTop).toBe(afterScrollUp);
    expect(viewport.scrollTop).toBeLessThan(scrollHeight - viewport.clientHeight - 1);
  });

  it('rejoins the tail after scrolling back to the live edge', async () => {
    const { container, rerender } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    let scrollHeight = 12800;
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    await act(async () => {
      viewport.scrollTop = scrollHeight - viewport.clientHeight;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      viewport.scrollTop = 120;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      viewport.scrollTop = scrollHeight - viewport.clientHeight;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    scrollHeight = 13200;
    const next = [
      ...messages,
      message('assistant-80', 'assistant', [{ type: 'text', text: 'Message 80' }]),
    ];
    rerender(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={next}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );

    expect(screen.queryByText('assistant-80')).not.toBeNull();
    expect(viewport.scrollTop).toBe(scrollHeight - viewport.clientHeight);
  });

  it('detaches follow when an in-band nudge settles above the bottom', async () => {
    const { container, rerender } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    let scrollHeight = 12800;
    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });

    const settleAtBottom = () =>
      act(async () => {
        viewport.scrollTop = scrollHeight - viewport.clientHeight;
        viewport.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 40));
      });

    await settleAtBottom();
    // A few px up, still inside the resume band: while the gesture is fresh
    // flushes may re-glue; only the settle decides, and it finds the user
    // parked 20px above the bottom.
    await act(async () => {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -20, bubbles: true, cancelable: true })
      );
      viewport.scrollTop = scrollHeight - viewport.clientHeight - 20;
      viewport.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Settled reading: growth must not yank the viewport to the tail.
    scrollHeight = 13200;
    const withReply = [
      ...messages,
      message('assistant-80', 'assistant', [{ type: 'text', text: 'Message 80' }]),
    ];
    rerender(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={withReply}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    expect(viewport.scrollTop).toBe(12380);

    // Returning to the exact bottom re-attaches; the next flush glues.
    await settleAtBottom();
    scrollHeight = 13400;
    const withReply2 = [
      ...withReply,
      message('assistant-81', 'assistant', [{ type: 'text', text: 'Message 81' }]),
    ];
    rerender(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={withReply2}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    expect(viewport.scrollTop).toBe(13000);
  });

  it('mounts the tail when asked to scroll to the end', () => {
    const { container } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 20000 });

    act(() => {
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      viewport.scrollTop = 120;
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(screen.queryByText('assistant-0')).not.toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent('scroll-chat-to-bottom'));
    });

    expect(screen.queryByText('assistant-79')).not.toBeNull();
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
  });

  it('keeps already-mounted history when find is pressed', () => {
    renderVirtualList();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
    });

    expect(screen.queryByText('assistant-0')).not.toBeNull();
    expect(screen.queryByText('assistant-79')).not.toBeNull();
    expect(screen.getAllByText(/assistant-/).length).toBe(80);
  });

  it('does not cover the tail with a loading overlay after history is ready', () => {
    renderVirtualList();

    expect(screen.queryByTestId('history-loading-overlay')).toBeNull();
    expect(screen.queryByText('assistant-79')).not.toBeNull();
    expect(screen.getAllByText(/assistant-/).length).toBe(80);
  });

  it('hydrates earlier cards when the transcript is scrolled up', () => {
    const { container } = render(
      <div data-radix-scroll-area-viewport data-testid="viewport">
        <IntlTestWrapper>
          <MessageList
            messages={messages}
            sessionId="test-session"
            append={append}
            isUserMessage={isUserMessage}
            showLoadingThreshold={50}
          />
        </IntlTestWrapper>
      </div>
    );
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) throw new Error('missing viewport');
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 20000 });

    act(() => {
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event('scroll'));
    });
    act(() => {
      viewport.scrollTop = 120;
      viewport.dispatchEvent(new Event('scroll'));
    });

    expect(screen.queryByTestId('history-loading-overlay')).toBeNull();
    expect(screen.queryByText('assistant-0')).not.toBeNull();
  });
});
