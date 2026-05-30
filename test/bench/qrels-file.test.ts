import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildEvalCaptureFile } from '../../src/core/eval-capture.ts';
import { buildQrelsFromCapture, loadQrelsFile } from '../../src/core/bench/qrels-file.ts';

describe('qrels-file helpers', () => {
  test('builds qrels from captured expected slugs', () => {
    const capture = buildEvalCaptureFile({
      generatedAt: '2026-05-30T18:00:00.000Z',
      cases: [{ query: 'SelfGrowth', expectedSlug: 'projects/control/project-status/selfgrowth', topResults: [] }],
    });
    const qrels = buildQrelsFromCapture(capture);
    expect(qrels.schema_version).toBe(1);
    expect(qrels.qrels[0]).toEqual({ query: 'SelfGrowth', expectedSlugs: ['projects/control/project-status/selfgrowth'] });
  });

  test('loads qrels JSON from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-qrels-'));
    try {
      const path = join(dir, 'qrels.json');
      writeFileSync(path, JSON.stringify({ schema_version: 1, qrels: [{ query: 'Q', expectedSlugs: ['a'] }] }));
      expect(loadQrelsFile(path).qrels[0].expectedSlugs).toEqual(['a']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
