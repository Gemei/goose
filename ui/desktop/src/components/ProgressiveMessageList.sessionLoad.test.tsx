import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import type { Message, MessageContent } from '../types/message';
import MessageList from './MessageList';
import { endUserGesture, endUserInput } from '../utils/smoothScroll';

const renderCounts = vi.hoisted(() => new Map<string, number>());

vi.mock('./GooseMessage', () => ({
  default: ({ message }: { message: Message }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <div>{id}</div>;
  },
}));

vi.mock('./UserMessage', () => ({
  default: ({ message }: { message: Message }) => {
    const id = message.id ?? 'missing-id';
    renderCounts.set(id, (renderCounts.get(id) ?? 0) + 1);
    return <div>{id}</div>;
  },
}));

// The chat list short-circuits hydration to the instant path under jsdom
// (prefersInstantScroll returns true), which means the session-load drain
// never runs anywhere in unit tests. Force the timed path: a mount with zero
// messages, the transcript landing mid-load, and the batched hydration that
// mounts history after the live tail.
vi.mock('../utils/smoothScroll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/smoothScroll')>()),
  prefersInstantScroll: () => false,
}));

const visibleMetadata: Message['metadata'] = { agentVisible: true, userVisible: true };
const SESSION_ID = 'session-load-test';
const TRANSCRIPT_SIZE = 80;
const viewport = { clientHeight: 400, scrollHeight: 20000 };

const isUserMessage = (message: Message) => message.role === 'user';
const append = vi.fn();

function message(id: string, role: Message['role'], content: MessageContent[]): Message {
  return { id, role, created: 1000, content, metadata: visibleMetadata };
}

function buildTranscript(): Message[] {
  return Array.from({ length: TRANSCRIPT_SIZE }, (_, index) =>
    message(`assistant-${index}`, 'assistant', [{ type: 'text', text: `Message ${index}` }])
  );
}

function renderListElements(messages: Message[]) {
  return (
    <IntlTestWrapper>
      <MessageList
        messages={messages}
        sessionId={SESSION_ID}
        isUserMessage={isUserMessage}
        showLoadingThreshold={50}
      />
    </IntlTestWrapper>
  );
}

function renderVirtualList(messages: Message[]) {
  return render(
    <div data-radix-scroll-area-viewport data-testid="chat-viewport">
      {renderListElements(messages)}
    </div>
  );
}

function stubViewportGeometry() {
  const el = screen.getByTestId('chat-viewport');
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: viewport.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: viewport.scrollHeight });
  return el;
}

async function flushUntil(predicate: () => boolean, label: string) {
  let settled = false;
  const samples: string[] = [];
  // React only commits startTransition hydration work when an act scope
  // ends; poll in short act scopes so each exit flushes one drain window.
  for (let i = 0; i < 60; i++) {
    await act(async () => {
      await new Promise((r) => window.setTimeout(r, 100));
    });
    if (predicate()) {
      settled = true;
      break;
    }
    if (i % 5 === 0) {
      const vp = screen.getByTestId('chat-viewport');
      samples.push(screen.queryAllByText(/assistant-\d+/).length + '@' + vp.scrollTop);
    }
  }
  if (!settled) {
    throw new Error(`timed out waiting for: ${label}; row samples: ${samples.join(',')}`);
  }
}

beforeEach(() => {
  renderCounts.clear();
  append.mockClear();
  endUserGesture();
  endUserInput();
  // jsdom provides neither rAF nor IntersectionObserver; both are needed to
  // run the guarded hydration paths with prefersInstantScroll off.
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = ((cb: (ts: number) => void) =>
      window.setTimeout(
        () => cb(performance.now()),
        16
      )) as unknown as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((id: number) =>
      window.clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
  }
  const stub = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): unknown[] {
      return [];
    }
  };
  window.IntersectionObserver = stub as unknown as typeof IntersectionObserver;
});

describe('MessageList session-load hydration', () => {
  it('mounts empty while the load is in flight, then sizes from the real transcript length', () => {
    const { rerender, container } = renderVirtualList([]);

    expect(screen.queryByText('assistant-0')).toBeNull();

    // Transcript arrives in one notify (finishSessionLoad materializes the
    // replay). Sizing must re-run from the real length: only the live tail
    // mounts before hydration, and rows stay hidden before first paint.
    rerender(
      <div data-radix-scroll-area-viewport data-testid="chat-viewport">
        {renderListElements(buildTranscript())}
      </div>
    );
    stubViewportGeometry();

    const list = container.querySelector('[data-testid="virtual-message-list"]');
    if (!(list instanceof HTMLElement)) throw new Error('missing virtual-message-list');
    expect(list.style.visibility).toBe('hidden');
    expect(screen.queryByText(`assistant-${TRANSCRIPT_SIZE - 1}`)).not.toBeNull();
    // Sizing must have moved the hydration frontier (only the live tail is
    // mounted) instead of mounting all 80 rows at once.
    expect(screen.queryByText('assistant-0')).toBeNull();
  });

  it('drains the hydration queue so the whole transcript mounts and the tail stays pinned', async () => {
    const { rerender, container } = renderVirtualList([]);
    const viewportEl = stubViewportGeometry();
    rerender(
      <div data-radix-scroll-area-viewport data-testid="chat-viewport">
        {renderListElements(buildTranscript())}
      </div>
    );

    await flushUntil(
      () =>
        screen.queryByText('assistant-0') !== null &&
        (container.querySelector('[data-testid="virtual-message-list"]') as HTMLElement | null)
          ?.style.visibility !== 'hidden',
      'full transcript hydrated and list visible'
    );

    expect(screen.getAllByText(/assistant-\d+/)).toHaveLength(TRANSCRIPT_SIZE);
    const list = container.querySelector('[data-testid="virtual-message-list"]');
    if (!(list instanceof HTMLElement)) throw new Error('missing virtual-message-list');
    expect(list.style.visibility).not.toBe('hidden');
    expect(viewportEl.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
  }, 20000);

  it('does not fight a user scrolling up while the hydration drain is running', async () => {
    const { rerender, container } = renderVirtualList([]);
    const viewportEl = stubViewportGeometry();
    rerender(<div data-radix-scroll-area-viewport data-testid="chat-viewport">{renderListElements(buildTranscript())}</div>);

    // The transcript lands and the drain starts (only the live tail is
    // mounted, so history is still loading). The user scrolls up right away.
    const list = container.querySelector('[data-testid="virtual-message-list"]');
    if (!(list instanceof HTMLElement)) throw new Error('missing virtual-message-list');
    expect(list.style.visibility).toBe('hidden');

    const userTop = viewport.scrollHeight - viewport.clientHeight - 3000;
    await act(async () => {
      viewportEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      viewportEl.scrollTop = userTop;
      viewportEl.dispatchEvent(new Event('scroll'));
      await new Promise((r) => window.setTimeout(r, 50));
    });

    // Hydration keeps mounting earlier batches in the background...
    await flushUntil(
      () => screen.queryByText('assistant-0') !== null,
      'full transcript to hydrate after the user scrolled up'
    );
    // ...but no batch may yank the viewport back to the live edge.
    expect(viewportEl.scrollTop).toBe(userTop);
  }, 20000);

  it('does not leak the previous transcript when a held-back load resets on revisit', () => {
    const { rerender, container } = renderVirtualList(buildTranscript());
    const mounted = Array.from(container.querySelectorAll('[data-message-index]'))
      .map((row) => row.textContent)
      .join('|');
    expect(mounted, `mounted rows on load: ${mounted}`).toContain('assistant-79');

    // Re-opening the session restarts the load: rows reset behind the hold.
    rerender(
      <div data-radix-scroll-area-viewport data-testid="chat-viewport">
        {renderListElements([])}
      </div>
    );
    expect(screen.queryAllByText(/assistant-\d+/)).toHaveLength(0);
  });
});
