import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildEvalCaptureFile,
  writeEvalCaptureFile,
  loadEvalCaptureFile,
  replayEvalCapture,
} from '../src/core/eval-capture.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('eval capture helpers', () => {
  test('builds a scrubbed capture file from query cases', () => {
    const capture = buildEvalCaptureFile({
      generatedAt: '2026-05-30T18:00:00.000Z',
      git: { branch: 'test', head: 'abc123' },
      cases: [{
        query: 'Rodaco AI',
        expectedSlug: 'knowledge/companies/rodaco/summary',
        mode: 'hybridNoExpand',
        intent: 'email roger@example.com using sk-secret123456',
        topResults: [makeResult('knowledge/companies/rodaco/summary', 1)],
      }],
    });

    expect(capture.schema_version).toBe(1);
    expect(capture.cases[0].intent).toContain('[email]');
    expect(capture.cases[0].intent).toContain('[secret]');
    expect(capture.cases[0].topResults[0].slug).toBe('knowledge/companies/rodaco/summary');
  });

  test('writes and loads capture files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-eval-capture-'));
    try {
      const path = join(dir, 'capture.json');
      const capture = buildEvalCaptureFile({
        generatedAt: '2026-05-30T18:00:00.000Z',
        cases: [{ query: 'SelfGrowth', expectedSlug: 'projects/control/project-status/selfgrowth', topResults: [] }],
      });
      writeEvalCaptureFile(path, capture);
      expect(existsSync(path)).toBe(true);
      const loaded = loadEvalCaptureFile(path);
      expect(loaded.cases[0].query).toBe('SelfGrowth');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replays captured expected slugs against current search results', async () => {
    const capture = buildEvalCaptureFile({
      generatedAt: '2026-05-30T18:00:00.000Z',
      cases: [
        { query: 'Rodaco', expectedSlug: 'knowledge/companies/rodaco/summary', topResults: [] },
        { query: 'Unmapped Query', expectedSlug: 'expected/slug', topResults: [] },
      ],
    });
    const engine = makeKeywordEngine({
      Rodaco: [makeResult('knowledge/companies/rodaco/summary', 1)],
      'Unmapped Query': [makeResult('wrong/slug', 1)],
    });

    const replay = await replayEvalCapture(engine as any, capture, { limit: 3 });
    expect(replay.total).toBe(2);
    expect(replay.passed).toBe(1);
    expect(replay.failed).toBe(1);
    expect(replay.cases[1].actualTopSlug).toBe('wrong/slug');
  });
});

function makeResult(slug: string, score: number): SearchResult {
  return {
    slug,
    title: slug.split('/').pop() ?? slug,
    type: 'test',
    chunk_text: `Excerpt for ${slug}`,
    score,
    chunk_id: Math.round(score * 1000),
  } as SearchResult;
}

function makeKeywordEngine(resultsByQuery: Record<string, SearchResult[]>) {
  return {
    searchKeyword: async (query: string) => resultsByQuery[query] ?? [],
  };
}
