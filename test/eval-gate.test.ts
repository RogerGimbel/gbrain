import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEvalGateCommand } from '../src/commands/eval-gate.ts';
import { buildEvalCaptureFile, writeEvalCaptureFile } from '../src/core/eval-capture.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('eval gate command', () => {
  test('prints help without requiring a capture file', async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      await runEvalGateCommand({} as any, ['--help']);
    } finally {
      console.log = originalLog;
    }
    expect(lines.join('\n')).toContain('gbrain eval gate');
  });

  test('passes when replayed capture top1 matches expected slug', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-eval-gate-'));
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      const capturePath = join(dir, 'capture.json');
      writeEvalCaptureFile(capturePath, buildEvalCaptureFile({
        generatedAt: '2026-05-30T18:00:00.000Z',
        cases: [{ query: 'SelfGrowth', expectedSlug: 'projects/control/project-status/selfgrowth', topResults: [] }],
      }));
      await runEvalGateCommand(makeKeywordEngine({
        SelfGrowth: [makeResult('projects/control/project-status/selfgrowth', 1)],
      }) as any, [capturePath]);
      expect(lines.join('\n')).toContain('PASS');
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passes from a qrels file with expected slugs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-eval-qrels-gate-'));
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      const qrelsPath = join(dir, 'qrels.json');
      await Bun.write(qrelsPath, JSON.stringify({
        schema_version: 1,
        qrels: [{ query: 'Rodaco', expectedSlugs: ['knowledge/companies/rodaco/summary'] }],
      }));
      await runEvalGateCommand(makeKeywordEngine({
        Rodaco: [makeResult('knowledge/companies/rodaco/summary', 1)],
      }) as any, ['--qrels', qrelsPath]);
      expect(lines.join('\n')).toContain('PASS');
    } finally {
      console.log = originalLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeResult(slug: string, score: number): SearchResult {
  return { slug, title: slug, type: 'test', chunk_text: slug, score, chunk_id: 1 } as SearchResult;
}

function makeKeywordEngine(resultsByQuery: Record<string, SearchResult[]>) {
  return {
    searchKeyword: async (query: string) => resultsByQuery[query] ?? [],
  };
}
