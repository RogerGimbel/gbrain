import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildEvalCaptureFile, writeEvalCaptureFile } from '../../src/core/eval-capture.ts';
import { loadBaselineFile } from '../../src/core/bench/baseline-file.ts';

describe('baseline-file helpers', () => {
  test('loads a replayable eval capture as a baseline file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-baseline-file-'));
    try {
      const path = join(dir, 'baseline.json');
      writeEvalCaptureFile(path, buildEvalCaptureFile({
        generatedAt: '2026-05-30T18:00:00.000Z',
        cases: [{ query: 'Rodaco', expectedSlug: 'knowledge/companies/rodaco/summary', topResults: [] }],
      }));
      const baseline = loadBaselineFile(path);
      expect(baseline.cases).toHaveLength(1);
      expect(baseline.cases[0].query).toBe('Rodaco');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
