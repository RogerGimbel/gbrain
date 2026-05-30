import { describe, test, expect } from 'bun:test';
import { sortNewestFirst } from '../src/core/sort-newest-first.ts';

describe('sortNewestFirst', () => {
  test('date-prefixed paths get sorted newest-first', () => {
    const input = [
      'meetings/2020-01-01-old.md',
      'meetings/2026-05-13-recent.md',
      'meetings/2024-03-15-middle.md',
    ];
    expect(sortNewestFirst([...input])).toEqual([
      'meetings/2026-05-13-recent.md',
      'meetings/2024-03-15-middle.md',
      'meetings/2020-01-01-old.md',
    ]);
  });

  test('mixed prefixes produce deterministic descending order', () => {
    const input = [
      'concepts/a.md',
      'meetings/2026-05-13.md',
      'people/zoe.md',
      'daily/2026-05-12.md',
    ];
    expect(sortNewestFirst([...input])).toEqual([
      'people/zoe.md',
      'meetings/2026-05-13.md',
      'daily/2026-05-12.md',
      'concepts/a.md',
    ]);
  });

  test('mutates in place and returns the same reference', () => {
    const arr = ['a.md', 'c.md', 'b.md'];
    const ret = sortNewestFirst(arr);
    expect(ret).toBe(arr);
    expect(arr).toEqual(['c.md', 'b.md', 'a.md']);
  });
});
