import { describe, test, expect } from 'bun:test';
import { scrubEvalText, scrubEvalCaptureValue } from '../src/core/eval-capture-scrub.ts';

describe('eval capture scrubber', () => {
  test('redacts emails, API keys, bearer tokens, and local user paths', () => {
    const input = 'Email roger@example.com with sk-abc123456789 or Bearer secret-token from /Users/rogergimbel/Knowledge/file.md';
    const out = scrubEvalText(input);
    expect(out).toContain('[email]');
    expect(out).toContain('[secret]');
    expect(out).toContain('Bearer [secret]');
    expect(out).toContain('/Users/[user]/Knowledge/file.md');
    expect(out).not.toContain('roger@example.com');
    expect(out).not.toContain('sk-abc123456789');
    expect(out).not.toContain('rogergimbel');
  });

  test('recursively scrubs nested capture values and truncates long strings', () => {
    const value = scrubEvalCaptureValue({
      query: 'Roger',
      intent: 'contact accfighter@gmail.com ' + 'x'.repeat(300),
      nested: ['token ghp_abcdefghijklmnopqrstuvwxyz1234567890'],
    }, 80) as any;
    expect(value.intent).toContain('[email]');
    expect(value.intent.length).toBeLessThanOrEqual(81);
    expect(value.nested[0]).toContain('[secret]');
  });
});
