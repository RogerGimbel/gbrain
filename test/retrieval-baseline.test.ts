import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_RETRIEVAL_CASES,
  summarizeRetrievalCase,
  buildReplayableRetrievalBaselineCapture,
} from '../src/core/search/retrieval-baseline.ts';
import type { SearchResult } from '../src/core/types.ts';

function result(slug: string, score: number): SearchResult {
  return {
    slug,
    score,
    page_id: Math.floor(score * 1000),
    title: slug.split('/').pop() || slug,
    type: 'project',
    chunk_text: `excerpt for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: Math.floor(score * 1000),
    chunk_index: 0,
    stale: false,
  };
}

describe('retrieval baseline helpers', () => {
  test('summarizes expected canonical result position and top-k flags', () => {
    const summary = summarizeRetrievalCase(
      {
        query: 'SelfGrowth canonical summary',
        expectedSlug: 'projects/control/project-status/selfgrowth',
        notes: 'canonical project status should beat raw imported pages',
      },
      {
        hybridNoExpand: [
          result('raw/selfgrowth-import', 0.91),
          result('projects/control/project-status/selfgrowth', 0.81),
          result('knowledge/projects/selfgrowth-knowledge-pilot/wiki/selfgrowth-current-state', 0.72),
        ],
        hybridExpand: [result('projects/control/project-status/selfgrowth', 0.93)],
        keyword: [result('raw/selfgrowth-import', 0.55)],
      },
      10,
    );

    expect(summary.query).toBe('SelfGrowth canonical summary');
    expect(summary.expectedSlug).toBe('projects/control/project-status/selfgrowth');
    expect(summary.hybridNoExpand.topSlug).toBe('raw/selfgrowth-import');
    expect(summary.hybridNoExpand.expectedRank).toBe(2);
    expect(summary.hybridNoExpand.expectedTop1).toBe(false);
    expect(summary.hybridNoExpand.expectedTop3).toBe(true);
    expect(summary.hybridNoExpand.expectedTop10).toBe(true);
    expect(summary.hybridExpand.expectedTop1).toBe(true);
    expect(summary.keyword.expectedRank).toBe(null);
  });

  test('canonical retrieval cases include the known high-value entity set', () => {
    const byQuery = new Map(CANONICAL_RETRIEVAL_CASES.map(c => [c.query, c.expectedSlug]));

    expect(byQuery.get('OpenClaw')).toBe('projects/control/project-status/openclaw');
    expect(byQuery.get('SelfGrowth canonical summary')).toBe('projects/control/project-status/selfgrowth');
    expect(byQuery.get('Rodaco AI')).toBe('knowledge/companies/rodaco/summary');
    expect(byQuery.get('Hermes Agent')).toBe('knowledge/agents/hermes');
    expect(byQuery.get('Dale Abbott')).toBe('knowledge/people/dale-abbott/summary');
    expect(byQuery.get('M5 MacBook')).toBe('knowledge/infrastructure/m5-macbook/summary');
  });

  test('exports retrieval summaries as replayable eval capture cases per mode', () => {
    const summary = summarizeRetrievalCase(
      {
        query: 'Rodaco',
        expectedSlug: 'knowledge/companies/rodaco/summary',
        notes: 'company summary should be canonical',
      },
      {
        hybridNoExpand: [result('knowledge/companies/rodaco/summary', 0.99)],
        hybridExpand: [result('knowledge/companies/rodaco/summary', 0.98)],
        keyword: [result('knowledge/companies/rodaco/summary', 0.77)],
      },
      10,
    );

    const capture = buildReplayableRetrievalBaselineCapture([summary], {
      generatedAt: '2026-05-30T18:00:00.000Z',
      git: { branch: 'test-branch', head: 'abc123' },
    });

    expect(capture.schema_version).toBe(1);
    expect(capture.generated_at).toBe('2026-05-30T18:00:00.000Z');
    expect(capture.git).toEqual({ branch: 'test-branch', head: 'abc123' });
    expect(capture.cases.map(testCase => testCase.mode)).toEqual(['hybridNoExpand', 'hybridExpand', 'keyword']);
    expect(capture.cases.every(testCase => testCase.query === 'Rodaco')).toBe(true);
    expect(capture.cases.every(testCase => testCase.expectedSlug === 'knowledge/companies/rodaco/summary')).toBe(true);
    expect(capture.cases[0].topResults[0].slug).toBe('knowledge/companies/rodaco/summary');
  });
});
