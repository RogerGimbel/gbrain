import { describe, expect, test, beforeEach, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSourceUnchangedSinceSync,
  _setGitHeadProbeForTests,
  _setGitCleanProbeForTests,
} from '../../src/core/git-head.ts';

beforeEach(() => {
  _setGitHeadProbeForTests(null);
  _setGitCleanProbeForTests(null);
});

afterAll(() => {
  _setGitHeadProbeForTests(null);
  _setGitCleanProbeForTests(null);
});

describe('isSourceUnchangedSinceSync', () => {
  test('returns true when HEAD matches the last synced commit', () => {
    _setGitHeadProbeForTests(() => 'abc123');
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(true);
  });

  test('returns false when HEAD differs from the last synced commit', () => {
    _setGitHeadProbeForTests(() => 'def456');
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(false);
  });

  test('short-circuits missing inputs without probing git', () => {
    let calls = 0;
    _setGitHeadProbeForTests(() => { calls++; return 'abc123'; });
    expect(isSourceUnchangedSinceSync(null, 'abc123')).toBe(false);
    expect(isSourceUnchangedSinceSync('/tmp/repo', null)).toBe(false);
    expect(calls).toBe(0);
  });

  test('fails closed when clean working tree is required and the tree is dirty', () => {
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => false);
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123', { requireCleanWorkingTree: true })).toBe(false);
  });

  test('returns true when HEAD matches and required clean probe is clean', () => {
    _setGitHeadProbeForTests(() => 'abc123');
    _setGitCleanProbeForTests(() => true);
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123', { requireCleanWorkingTree: true })).toBe(true);
  });

  test('fails closed instead of throwing when probes throw', () => {
    _setGitHeadProbeForTests(() => { throw new Error('git exploded'); });
    expect(isSourceUnchangedSinceSync('/tmp/repo', 'abc123')).toBe(false);
  });

  test('default probe uses array args and does not execute shell metacharacters', () => {
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);
    const sentinelDir = mkdtempSync(join(tmpdir(), 'git-head-sentinel-'));
    const sentinelPath = join(sentinelDir, 'pwned');
    const adversarialPath = `/nonexistent/$(touch ${sentinelPath})/repo`;
    try {
      expect(isSourceUnchangedSinceSync(adversarialPath, 'abc123')).toBe(false);
      expect(existsSync(sentinelPath)).toBe(false);
    } finally {
      rmSync(sentinelDir, { recursive: true, force: true });
    }
  });
});
