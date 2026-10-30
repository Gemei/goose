// Content-addressed caches shared across mounts. Entries survive React
// remounts (a session switch unmounts the whole list and remounts every
// card), which is what makes returning to a chat cheap: per-card work keyed
// by content hash is paid once instead of on every switch-back.
export class LruCache<T> {
  private maxEntries: number;
  private maxBytes: number | null;
  private bytes = 0;
  private map = new Map<string, { value: T; size: number }>();

  constructor(maxEntries: number, maxBytes: number | null = null) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get size(): number {
    return this.map.size;
  }

  get getBytes(): number {
    return this.bytes;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  put(key: string, value: T, size = 1): void {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      this.bytes -= entry.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    // Always keep the newest entry, even if it alone exceeds the budget.
    while (
      this.map.size > 1 &&
      (this.map.size > this.maxEntries || (this.maxBytes !== null && this.bytes > this.maxBytes))
    ) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  drop(key: string): void {
    const entry = this.map.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.size;
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }
}

export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(36);
}
