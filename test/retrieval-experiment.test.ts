import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  compareRetrievalExperiment,
  renderRetrievalExperimentMarkdown,
  writeRetrievalExperimentArtifacts,
} from '../src/core/search/retrieval-experiment.ts';
import type { EvalReport } from '../src/core/search/eval.ts';

function report(name: string, mrr: number, ndcg: number, hits: string[][]): EvalReport {
  return {
    config: { name, strategy: 'hybrid' },
    k: 3,
    mean_precision: 0.5,
    mean_recall: 0.5,
    mean_mrr: mrr,
    mean_ndcg: ndcg,
    queries: hits.map((queryHits, idx) => ({
      query: `query ${idx + 1}`,
      hits: queryHits,
      precision_at_k: 0.5,
      recall_at_k: 0.5,
      mrr: queryHits[0] === `expected-${idx + 1}` ? 1 : 0,
      ndcg_at_k: queryHits[0] === `expected-${idx + 1}` ? 1 : 0,
    })),
  };
}

describe('retrieval experiment gate', () => {
  test('passes candidates that do not regress aggregate metrics or top1 expectations', () => {
    const baseline = report('baseline', 1, 1, [['expected-1'], ['expected-2']]);
    const candidate = report('candidate', 1, 1, [['expected-1'], ['expected-2']]);
    const result = compareRetrievalExperiment({
      baseline,
      candidate,
      expectedTop1ByQuery: { 'query 1': 'expected-1', 'query 2': 'expected-2' },
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.metrics.mean_mrr_delta).toBe(0);
  });

  test('fails closed on lower MRR and protected top1 regression', () => {
    const baseline = report('baseline', 1, 1, [['expected-1'], ['expected-2']]);
    const candidate = report('candidate', 0.5, 0.5, [['expected-1'], ['wrong', 'expected-2']]);
    const result = compareRetrievalExperiment({
      baseline,
      candidate,
      expectedTop1ByQuery: { 'query 1': 'expected-1', 'query 2': 'expected-2' },
    });

    expect(result.ok).toBe(false);
    expect(result.failures.some(f => f.includes('mean_mrr regression'))).toBe(true);
    expect(result.failures.some(f => f.includes('top1 regression: query 2'))).toBe(true);
  });

  test('writes gated experiment artifacts without enabling candidate ranking', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-retrieval-experiment-'));
    const baseline = report('baseline', 1, 1, [['expected-1']]);
    const candidate = report('candidate', 1, 1, [['expected-1']]);
    const result = compareRetrievalExperiment({ baseline, candidate, expectedTop1ByQuery: { 'query 1': 'expected-1' } });
    const markdown = renderRetrievalExperimentMarkdown(result);
    expect(markdown).toContain('candidate_enabled: false');
    const files = writeRetrievalExperimentArtifacts(root, result);
    expect(existsSync(files.json)).toBe(true);
    expect(existsSync(files.markdown)).toBe(true);
    expect(readFileSync(files.markdown, 'utf8')).toContain('Retrieval Experiment Gate');
  });
});
