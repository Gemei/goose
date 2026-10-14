import { describe, expect, it } from 'vitest';
import type { Message } from '../types/message';
import { findTranscriptMatches, occurrenceWithinMessage } from './transcriptSearch';

function message(id: string, text: string, userVisible = true): Message {
  return {
    id,
    role: 'assistant',
    created: 0,
    content: [{ type: 'text', text }],
    metadata: { userVisible, agentVisible: true },
  };
}

describe('findTranscriptMatches', () => {
  const messages = [
    message('a', 'Alpha beta'),
    message('b', 'hidden', false),
    message('c', 'Beta again, then beta'),
  ];

  it('finds every visible occurrence without mounting messages', () => {
    expect(findTranscriptMatches(messages, 'beta', false)).toEqual([0, 2, 2]);
  });

  it('respects case and an empty query', () => {
    expect(findTranscriptMatches(messages, 'Beta', true)).toEqual([2]);
    expect(findTranscriptMatches(messages, '   ', false)).toEqual([]);
  });

  it('searches chat text and skips tool output', () => {
    const mixed = message('d', 'please check the notes');
    mixed.content.push(
      {
        type: 'thinking',
        signature: 'sig',
        thinking: 'run the shell command',
      },
      {
        type: 'toolResponse',
        id: 'call-1',
        toolResult: {
          status: 'success',
          value: { content: [{ type: 'text', text: 'npm test output' }] },
        },
      }
    );
    expect(findTranscriptMatches([mixed], 'notes', false)).toEqual([0]);
    expect(findTranscriptMatches([mixed], 'shell', false)).toEqual([]);
    expect(findTranscriptMatches([mixed], 'npm', false)).toEqual([]);
  });

  it('counts repeated hits inside one message', () => {
    expect(occurrenceWithinMessage([0, 2, 2], 0)).toBe(0);
    expect(occurrenceWithinMessage([0, 2, 2], 1)).toBe(0);
    expect(occurrenceWithinMessage([0, 2, 2], 2)).toBe(1);
  });
});
