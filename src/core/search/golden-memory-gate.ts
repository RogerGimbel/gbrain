import { summarizeRetrievalSuite, type RetrievalCaseSummary } from './retrieval-baseline.ts';

export interface ExpectedPageCheck {
  query: string;
  expectedSlug: string;
  exists: boolean;
  title?: string | null;
  type?: string | null;
}

export interface GoldenMemoryHealthSnapshot {
  page_count?: number;
  embed_coverage?: number;
  stale_pages?: number;
  orphan_pages?: number;
  dead_links?: number;
  missing_embeddings?: number;
  brain_score?: number;
}

export interface GoldenMemoryGateInput {
  cases: RetrievalCaseSummary[];
  expectedPageChecks?: ExpectedPageCheck[];
  health?: GoldenMemoryHealthSnapshot;
}

export interface GoldenMemoryGateThresholds {
  requireHybridNoExpandTop1: boolean;
  requireHybridExpandTop1: boolean;
  maxMissingEmbeddings: number;
  maxDeadLinks: number;
  maxStalePages: number;
  minEmbedCoverage: number;
  minBrainScore: number;
}

export interface GoldenMemoryGateResult {
  ok: boolean;
  failures: string[];
  thresholds: GoldenMemoryGateThresholds;
  summary: ReturnType<typeof summarizeRetrievalSuite>;
}

export const DEFAULT_GOLDEN_MEMORY_THRESHOLDS: GoldenMemoryGateThresholds = {
  requireHybridNoExpandTop1: true,
  requireHybridExpandTop1: true,
  maxMissingEmbeddings: 0,
  maxDeadLinks: 0,
  maxStalePages: 0,
  minEmbedCoverage: 1,
  minBrainScore: 80,
};

export function evaluateGoldenMemoryGate(
  input: GoldenMemoryGateInput,
  thresholdOverrides: Partial<GoldenMemoryGateThresholds> = {},
): GoldenMemoryGateResult {
  const thresholds = { ...DEFAULT_GOLDEN_MEMORY_THRESHOLDS, ...thresholdOverrides };
  const failures: string[] = [];

  for (const check of input.expectedPageChecks ?? []) {
    if (!check.exists) {
      failures.push(`missing expected page: ${check.query} -> ${check.expectedSlug}`);
    }
  }

  for (const testCase of input.cases) {
    if (thresholds.requireHybridNoExpandTop1 && !testCase.hybridNoExpand.expectedTop1) {
      failures.push(
        `hybridNoExpand top1 regression: ${testCase.query} expected ${testCase.expectedSlug} at rank 1, got rank ${testCase.hybridNoExpand.expectedRank ?? 'missing'}`,
      );
    }
    if (thresholds.requireHybridExpandTop1 && !testCase.hybridExpand.expectedTop1) {
      failures.push(
        `hybridExpand top1 regression: ${testCase.query} expected ${testCase.expectedSlug} at rank 1, got rank ${testCase.hybridExpand.expectedRank ?? 'missing'}`,
      );
    }
  }

  const health = input.health;
  if (health) {
    if ((health.missing_embeddings ?? 0) > thresholds.maxMissingEmbeddings) {
      failures.push(
        `health regression: missing_embeddings ${health.missing_embeddings} exceeds max ${thresholds.maxMissingEmbeddings}`,
      );
    }
    if ((health.dead_links ?? 0) > thresholds.maxDeadLinks) {
      failures.push(`health regression: dead_links ${health.dead_links} exceeds max ${thresholds.maxDeadLinks}`);
    }
    if ((health.stale_pages ?? 0) > thresholds.maxStalePages) {
      failures.push(`health regression: stale_pages ${health.stale_pages} exceeds max ${thresholds.maxStalePages}`);
    }
    if ((health.embed_coverage ?? 1) < thresholds.minEmbedCoverage) {
      failures.push(
        `health regression: embed_coverage ${health.embed_coverage} below min ${thresholds.minEmbedCoverage}`,
      );
    }
    if ((health.brain_score ?? thresholds.minBrainScore) < thresholds.minBrainScore) {
      failures.push(`health regression: brain_score ${health.brain_score} below min ${thresholds.minBrainScore}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    thresholds,
    summary: summarizeRetrievalSuite(input.cases),
  };
}

export function formatGoldenMemoryFailures(failures: string[]): string {
  if (failures.length === 0) return 'Golden memory gate passed.';
  return ['Golden memory gate failed:', ...failures.map(failure => `- ${failure}`)].join('\n');
}
