import { getTextAndImageContent, type Message } from '../types/message';

/** Chat prose only. Tool calls, command output, and thinking stay out of search. */
export function messageSearchText(message: Message): string {
  return getTextAndImageContent(message).textContent;
}

/** Message indexes for each occurrence. The transcript stays mounted as-is. */
export function findTranscriptMatches(
  messages: readonly Message[],
  term: string,
  caseSensitive: boolean
): number[] {
  const needle = term.trim();
  if (!needle) return [];
  const query = caseSensitive ? needle : needle.toLowerCase();
  const matches: number[] = [];

  messages.forEach((message, index) => {
    if (message.metadata?.userVisible === false) return;
    const text = messageSearchText(message);
    const haystack = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    while (from < haystack.length) {
      const at = haystack.indexOf(query, from);
      if (at < 0) break;
      matches.push(index);
      from = at + query.length;
    }
  });

  return matches;
}

/** Which hit inside one message `cursor` points at. Several hits can share a message. */
export function occurrenceWithinMessage(matches: readonly number[], cursor: number): number {
  const messageIndex = matches[cursor];
  let occurrence = 0;
  for (let index = 0; index < cursor; index++) {
    if (matches[index] === messageIndex) occurrence++;
  }
  return occurrence;
}
