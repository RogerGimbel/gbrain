import { describe, expect, test } from 'bun:test';
import type { RetrievalCaseSummary } from '../src/core/search/retrieval-baseline.ts';
import {
  evaluateGoldenMemoryGate,
  formatGoldenMemoryFailures,
} from '../src/core/search/golden-memory-gate.ts';

function mode(topSlug: string | null, expectedRank: number | null) {
  return {
    topSlug,
    expectedRank,
    expectedTop1: expectedRank === 1,
    expectedTop3: expectedRank !== null && expectedRank <= 3,
    expectedTop10: expectedRank !== null && expectedRank <= 10,
    results: topSlug
      ? [{ rank: 1, slug: topSlug, title: topSlug, type: 'project', score: 1, stale: false, excerpt: '' }]
      : [],
  };
}

function caseSummary(query: string, expectedSlug: string, noExpandRank: number | null, expandRank: number | null): RetrievalCaseSummary {
  return {
    query,
    expectedSlug,
    hybridNoExpand: mode(noExpandRank === 1 ? expectedSlug : 'noise/page', noExpandRank),
    hybridExpand: mode(expandRank === 1 ? expectedSlug : 'noise/page', expandRank),
    keyword: mode(null, null),
  };
}

describe('golden memory upgrade gate', () => {
  test('passes when protected hybrid modes keep every expected slug at top1 and health is clean', () => {
    const gate = evaluateGoldenMemoryGate({
      cases: [
        caseSummary('OpenClaw', 'projects/control/project-status/openclaw', 1, 1),
        caseSummary('Rodaco', 'knowledge/companies/rodaco/summary', 1, 1),
      ],
      expectedPageChecks: [
        { query: 'OpenClaw', expectedSlug: 'projects/control/project-status/openclaw', exists: true },
        { query: 'Rodaco', expectedSlug: 'knowledge/companies/rodaco/summary', exists: true },
      ],
      health: {
        page_count: 705,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 44,
        dead_links: 0,
        missing_embeddings: 0,
        brain_score: 84,
      },
    });

    expect(gate.ok).toBe(true);
    expect(gate.failures).toEqual([]);
    expect(gate.summary.hybridNoExpand.top1).toBe(2);
    expect(gate.summary.hybridExpand.top1).toBe(2);
  });

  test('fails loudly when a protected query falls below top1 in no-expand hybrid mode', () => {
    const gate = evaluateGoldenMemoryGate({
      cases: [caseSummary('SelfGrowth canonical summary', 'projects/control/project-status/selfgrowth', 2, 1)],
      expectedPageChecks: [
        { query: 'SelfGrowth canonical summary', expectedSlug: 'projects/control/project-status/selfgrowth', exists: true },
      ],
      health: {
        page_count: 705,
        embed_coverage: 1,
        stale_pages: 0,
        orphan_pages: 44,
        dead_links: 0,
        missing_embeddings: 0,
        brain_score: 84,
      },
    });

    expect(gate.ok).toBe(false);
    expect(gate.failures).toContain(
      'hybridNoExpand top1 regression: SelfGrowth canonical summary expected projects/control/project-status/selfgrowth at rank 1, got rank 2',
    );
  });

  test('fails on missing expected pages and degraded health', () => {
    const gate = evaluateGoldenMemoryGate({
      cases: [caseSummary('Dale Abbott', 'knowledge/people/dale-abbott/summary', 1, 1)],
      expectedPageChecks: [
        { query: 'Dale Abbott', expectedSlug: 'knowledge/people/dale-abbott/summary', exists: false },
      ],
      health: {
        page_count: 705,
        embed_coverage: 0.99,
        stale_pages: 1,
        orphan_pages: 44,
        dead_links: 1,
        missing_embeddings: 2,
        brain_score: 70,
      },
    });

    expect(gate.ok).toBe(false);
    expect(gate.failures).toEqual([
      'missing expected page: Dale Abbott -> knowledge/people/dale-abbott/summary',
      'health regression: missing_embeddings 2 exceeds max 0',
      'health regression: dead_links 1 exceeds max 0',
      'health regression: stale_pages 1 exceeds max 0',
      'health regression: embed_coverage 0.99 below min 1',
      'health regression: brain_score 70 below min 80',
    ]);
    expect(formatGoldenMemoryFailures(gate.failures)).toContain('missing expected page');
  });
});
