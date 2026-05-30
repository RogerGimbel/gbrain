import { describe, test, expect } from 'bun:test';
import { evaluateCorrectnessGate } from '../../src/core/bench/correctness-gate.ts';

describe('correctness gate', () => {
  test('passes when all replay cases pass', () => {
    const result = evaluateCorrectnessGate({
      total: 2,
      passed: 2,
      failed: 0,
      cases: [
        { query: 'A', expectedSlug: 'a', actualTopSlug: 'a', passed: true },
        { query: 'B', expectedSlug: 'b', actualTopSlug: 'b', passed: true },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test('fails with readable messages for top1 mismatches', () => {
    const result = evaluateCorrectnessGate({
      total: 1,
      passed: 0,
      failed: 1,
      cases: [{ query: 'A', expectedSlug: 'a', actualTopSlug: 'wrong', passed: false }],
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('A expected a, got wrong');
  });
});
