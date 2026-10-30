import { describe, it, expect } from 'vitest';
import { LruCache, hashString } from './markdownCache';

describe('hashString', () => {
  it('is deterministic', () => {
    expect(hashString('hello world')).toBe(hashString('hello world'));
  });

  it('distinguishes different inputs', () => {
    expect(hashString('const a = 1;')).not.toBe(hashString('const a = 2;'));
    expect(hashString('a\nb')).not.toBe(hashString('ab'));
  });

  it('handles empty and large inputs', () => {
    expect(hashString('')).toBe(hashString(''));
    expect(hashString('x'.repeat(200_000)).length).toBeGreaterThan(0);
    expect(hashString('x'.repeat(200_000))).toBe(hashString(`x${''}`.repeat(200_000)));
  });
});

describe('LruCache', () => {
  it('returns stored values', () => {
    const cache = new LruCache<number>(2);
    cache.put('a', 1);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used entry beyond the entry cap', () => {
    const cache = new LruCache<string>(2);
    cache.put('a', '1');
    cache.put('b', '2');
    cache.get('a');
    cache.put('c', '3');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
    expect(cache.size).toBe(2);
  });

  it('refreshes recency on get', () => {
    const cache = new LruCache<string>(2);
    cache.put('a', '1');
    cache.put('b', '2');
    cache.get('a');
    cache.put('c', '3');
    expect(cache.get('a')).toBe('1');
  });

  it('evicts by byte budget when provided', () => {
    const cache = new LruCache<string>(10, 10);
    cache.put('small', '12345', 5);
    cache.put('big', 'x'.repeat(12), 12);
    expect(cache.get('small')).toBeUndefined();
    expect(cache.get('big')).toBe('x'.repeat(12));
  });

  it('replaces an existing key without growing', () => {
    const cache = new LruCache<string>(2, 10);
    cache.put('k', 'aaaaaaaaaa', 8);
    cache.put('k', 'bb', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('k')).toBe('bb');
    // 8 + 2 never exceeded the budget together because replace subtracts first
    cache.put('other', 'zz', 2);
    expect(cache.get('k')).toBe('bb');
    expect(cache.get('other')).toBe('zz');
  });
});
