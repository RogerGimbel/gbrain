import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { EvalReport } from './eval.ts';

export interface RetrievalExperimentInput {
  baseline: EvalReport;
  candidate: EvalReport;
  expectedTop1ByQuery?: Record<string, string>;
  minMrrDelta?: number;
  minNdcgDelta?: number;
}

export interface RetrievalExperimentResult {
  schema_version: 1;
  generated_at: string;
  candidate_enabled: false;
  ok: boolean;
  failures: string[];
  baseline: EvalReport;
  candidate: EvalReport;
  metrics: {
    mean_mrr_delta: number;
    mean_ndcg_delta: number;
    mean_precision_delta: number;
    mean_recall_delta: number;
    protected_top1_total: number;
    protected_top1_passed: number;
  };
}

export function compareRetrievalExperiment(input: RetrievalExperimentInput): RetrievalExperimentResult {
  const minMrrDelta = input.minMrrDelta ?? 0;
  const minNdcgDelta = input.minNdcgDelta ?? 0;
  const failures: string[] = [];
  const meanMrrDelta = roundMetric(input.candidate.mean_mrr - input.baseline.mean_mrr);
  const meanNdcgDelta = roundMetric(input.candidate.mean_ndcg - input.baseline.mean_ndcg);
  const meanPrecisionDelta = roundMetric(input.candidate.mean_precision - input.baseline.mean_precision);
  const meanRecallDelta = roundMetric(input.candidate.mean_recall - input.baseline.mean_recall);

  if (meanMrrDelta < minMrrDelta) {
    failures.push(`mean_mrr regression: delta ${meanMrrDelta} below minimum ${minMrrDelta}`);
  }
  if (meanNdcgDelta < minNdcgDelta) {
    failures.push(`mean_ndcg regression: delta ${meanNdcgDelta} below minimum ${minNdcgDelta}`);
  }

  let protectedTop1Total = 0;
  let protectedTop1Passed = 0;
  const expected = input.expectedTop1ByQuery ?? {};
  for (const [query, expectedSlug] of Object.entries(expected)) {
    protectedTop1Total += 1;
    const candidateQuery = input.candidate.queries.find(q => q.query === query);
    const top = candidateQuery?.hits[0] ?? null;
    if (top === expectedSlug) {
      protectedTop1Passed += 1;
    } else {
      failures.push(`top1 regression: ${query} expected ${expectedSlug}, got ${top ?? 'missing'}`);
    }
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    candidate_enabled: false,
    ok: failures.length === 0,
    failures,
    baseline: input.baseline,
    candidate: input.candidate,
    metrics: {
      mean_mrr_delta: meanMrrDelta,
      mean_ndcg_delta: meanNdcgDelta,
      mean_precision_delta: meanPrecisionDelta,
      mean_recall_delta: meanRecallDelta,
      protected_top1_total: protectedTop1Total,
      protected_top1_passed: protectedTop1Passed,
    },
  };
}

export function renderRetrievalExperimentMarkdown(result: RetrievalExperimentResult): string {
  return [
    '---',
    'title: Retrieval Experiment Gate',
    'type: retrieval-experiment-gate',
    'source_agent: GBrain',
    'source_origin: retrieval-experiment',
    `source_updated_at: ${result.generated_at}`,
    'candidate_enabled: false',
    `status: ${result.ok ? 'pass' : 'fail'}`,
    '---',
    '',
    '# Retrieval Experiment Gate',
    '',
    `- generated: ${result.generated_at}`,
    `- ok: ${result.ok}`,
    '- candidate_enabled: false',
    '- live ranking changed: false',
    '',
    '## Metrics',
    '',
    `- mean_mrr_delta: ${result.metrics.mean_mrr_delta}`,
    `- mean_ndcg_delta: ${result.metrics.mean_ndcg_delta}`,
    `- mean_precision_delta: ${result.metrics.mean_precision_delta}`,
    `- mean_recall_delta: ${result.metrics.mean_recall_delta}`,
    `- protected_top1: ${result.metrics.protected_top1_passed}/${result.metrics.protected_top1_total}`,
    '',
    '## Failures',
    '',
    ...(result.failures.length ? result.failures.map(f => `- ${f}`) : ['- none']),
    '',
    '## Configs',
    '',
    `- baseline: ${result.baseline.config.name ?? result.baseline.config.strategy ?? 'baseline'}`,
    `- candidate: ${result.candidate.config.name ?? result.candidate.config.strategy ?? 'candidate'}`,
    '',
  ].join('\n');
}

export function writeRetrievalExperimentArtifacts(outputDir: string, result: RetrievalExperimentResult): { json: string; markdown: string } {
  mkdirSync(outputDir, { recursive: true });
  const json = join(outputDir, 'retrieval-experiment-gate.json');
  const markdown = join(outputDir, 'retrieval-experiment-gate.md');
  writeFileSync(json, JSON.stringify(result, null, 2), 'utf8');
  writeFileSync(markdown, renderRetrievalExperimentMarkdown(result), 'utf8');
  return { json, markdown };
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}
