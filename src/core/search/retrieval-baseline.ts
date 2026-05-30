import { buildEvalCaptureFile, type EvalCaptureFile, type EvalCaptureMode } from '../eval-capture.ts';
import type { SearchResult } from '../types.ts';

export interface CanonicalRetrievalCase {
  query: string;
  expectedSlug: string;
  notes?: string;
}

export interface RetrievalResultSnapshot {
  rank: number;
  slug: string;
  title: string;
  type: string;
  score: number | null;
  stale: boolean;
  excerpt: string;
}

export interface RetrievalModeSummary {
  topSlug: string | null;
  expectedRank: number | null;
  expectedTop1: boolean;
  expectedTop3: boolean;
  expectedTop10: boolean;
  results: RetrievalResultSnapshot[];
}

export interface RetrievalCaseSummary {
  query: string;
  expectedSlug: string;
  notes?: string;
  hybridNoExpand: RetrievalModeSummary;
  hybridExpand: RetrievalModeSummary;
  keyword: RetrievalModeSummary;
}

export interface RetrievalModeResults {
  hybridNoExpand: SearchResult[];
  hybridExpand: SearchResult[];
  keyword: SearchResult[];
}

export const CANONICAL_RETRIEVAL_CASES: CanonicalRetrievalCase[] = [
  {
    query: 'OpenClaw',
    expectedSlug: 'projects/control/project-status/openclaw',
    notes: 'Bare OpenClaw should default to project status, not infra status or incidental mentions.',
  },
  {
    query: 'SelfGrowth canonical summary',
    expectedSlug: 'projects/control/project-status/selfgrowth',
    notes: 'Known watch item: canonical project status should beat raw/imported SelfGrowth pages.',
  },
  {
    query: 'SelfGrowth',
    expectedSlug: 'projects/control/project-status/selfgrowth',
    notes: 'Bare SelfGrowth should prefer maintained project status.',
  },
  {
    query: 'Rodaco',
    expectedSlug: 'knowledge/companies/rodaco/summary',
    notes: 'Bare company query should prefer company summary over same-name agent page.',
  },
  {
    query: 'Rodaco AI',
    expectedSlug: 'knowledge/companies/rodaco/summary',
    notes: 'Brand-style alias should still resolve to Rodaco company summary.',
  },
  {
    query: 'Hermes',
    expectedSlug: 'knowledge/agents/hermes',
    notes: 'Bare Hermes should prefer the Hermes agent profile.',
  },
  {
    query: 'Hermes Agent',
    expectedSlug: 'knowledge/agents/hermes',
    notes: 'Type-hint query should prefer the Hermes agent profile.',
  },
  {
    query: 'Winston',
    expectedSlug: 'knowledge/agents/winston',
    notes: 'Bare Winston should prefer the Winston agent profile.',
  },
  {
    query: 'GBrain',
    expectedSlug: 'knowledge/agents/gbrain',
    notes: 'Bare GBrain should prefer the maintained GBrain agent/service page.',
  },
  {
    query: 'Dale Abbott',
    expectedSlug: 'knowledge/people/dale-abbott/summary',
    notes: 'Collaborator recall should prefer the maintained person summary.',
  },
  {
    query: 'Roger Gimbel',
    expectedSlug: 'knowledge/people/roger-gimbel/summary',
    notes: 'Owner recall should prefer the maintained person summary.',
  },
  {
    query: 'M5 MacBook',
    expectedSlug: 'knowledge/infrastructure/m5-macbook/summary',
    notes: 'Primary-machine recall should prefer infrastructure summary.',
  },
  {
    query: 'Intel MacBook',
    expectedSlug: 'knowledge/infrastructure/intel-macbook/summary',
    notes: 'Headless-server recall should prefer infrastructure summary.',
  },
];

export function summarizeRetrievalCase(
  retrievalCase: CanonicalRetrievalCase,
  results: RetrievalModeResults,
  limit = 10,
): RetrievalCaseSummary {
  return {
    query: retrievalCase.query,
    expectedSlug: retrievalCase.expectedSlug,
    ...(retrievalCase.notes ? { notes: retrievalCase.notes } : {}),
    hybridNoExpand: summarizeMode(results.hybridNoExpand, retrievalCase.expectedSlug, limit),
    hybridExpand: summarizeMode(results.hybridExpand, retrievalCase.expectedSlug, limit),
    keyword: summarizeMode(results.keyword, retrievalCase.expectedSlug, limit),
  };
}

export function summarizeMode(results: SearchResult[], expectedSlug: string, limit = 10): RetrievalModeSummary {
  const trimmed = results.slice(0, limit);
  const expectedIdx = trimmed.findIndex(result => result.slug === expectedSlug);
  const expectedRank = expectedIdx >= 0 ? expectedIdx + 1 : null;

  return {
    topSlug: trimmed[0]?.slug ?? null,
    expectedRank,
    expectedTop1: expectedRank === 1,
    expectedTop3: expectedRank !== null && expectedRank <= 3,
    expectedTop10: expectedRank !== null && expectedRank <= 10,
    results: trimmed.map((result, idx) => ({
      rank: idx + 1,
      slug: result.slug,
      title: result.title,
      type: result.type,
      score: Number.isFinite(result.score) ? Number(result.score.toFixed(6)) : null,
      stale: Boolean(result.stale),
      excerpt: result.chunk_text.replace(/\s+/g, ' ').slice(0, 180),
    })),
  };
}

export function summarizeRetrievalSuite(summaries: RetrievalCaseSummary[]) {
  const modes = ['hybridNoExpand', 'hybridExpand', 'keyword'] as const;
  return Object.fromEntries(
    modes.map(mode => {
      const total = summaries.length;
      const top1 = summaries.filter(summary => summary[mode].expectedTop1).length;
      const top3 = summaries.filter(summary => summary[mode].expectedTop3).length;
      const top10 = summaries.filter(summary => summary[mode].expectedTop10).length;
      const missing = summaries.filter(summary => summary[mode].expectedRank === null).length;
      return [mode, { total, top1, top3, top10, missing }];
    }),
  );
}

export interface ReplayableRetrievalBaselineOptions {
  generatedAt?: string;
  git?: { branch?: string; head?: string };
}

export function buildReplayableRetrievalBaselineCapture(
  summaries: RetrievalCaseSummary[],
  opts: ReplayableRetrievalBaselineOptions = {},
): EvalCaptureFile {
  const modes = [
    ['hybridNoExpand', 'hybridNoExpand'],
    ['hybridExpand', 'hybridExpand'],
    ['keyword', 'keyword'],
  ] as const satisfies readonly (readonly [keyof Pick<RetrievalCaseSummary, 'hybridNoExpand' | 'hybridExpand' | 'keyword'>, EvalCaptureMode])[];

  return buildEvalCaptureFile({
    generatedAt: opts.generatedAt,
    git: opts.git,
    cases: summaries.flatMap(summary => modes.map(([summaryKey, mode]) => ({
      query: summary.query,
      expectedSlug: summary.expectedSlug,
      mode,
      ...(summary.notes ? { intent: summary.notes } : {}),
      topResults: summary[summaryKey].results,
    }))),
  });
}
