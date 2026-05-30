import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runEvalReplayCommand } from '../src/commands/eval-replay.ts';
import { buildEvalCaptureFile, writeEvalCaptureFile } from '../src/core/eval-capture.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('eval replay command', () => {
  test('prints help without requiring a capture file', async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      await runEvalReplayCommand({} as any, ['--help']);
    } finally {
      console.log = originalLog;
    }
    expect(lines.join('\n')).toContain('gbrain eval replay');
  });

  test('replays a capture file against engine search results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-eval-replay-'));
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (msg?: unknown) => { lines.push(String(msg ?? '')); };
    try {
      const capturePath = join(dir, 'capture.json');
      writeEvalCaptureFile(capturePath, buildEvalCaptureFile({
        generatedAt: '2026-05-30T18:00:00.000Z',
        cases: [{ query: 'Rodaco', expectedSlug: 'knowledge/companies/rodaco/summary', topResults: [] }],
      }));
      await runEvalReplayCommand(makeKeywordEngine({
        Rodaco: [makeResult('knowledge/companies/rodaco/summary', 1)],
      }) as any, [capturePath, '--limit', '3']);
      expect(lines.join('\n')).toContain('1/1 passed');
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
