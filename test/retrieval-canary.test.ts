import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { planRetrievalCanary, renderRetrievalCanaryMarkdown } from '../src/core/search/retrieval-canary.ts';
import type { RetrievalExperimentResult } from '../src/core/search/retrieval-experiment.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-retrieval-canary-'));
}

function gate(ok = true): RetrievalExperimentResult {
  return {
    schema_version: 1,
    generated_at: '2026-05-30T12:00:00Z',
    candidate_enabled: false,
    ok,
    failures: ok ? [] : ['top1 regression'],
    baseline: { config: { name: 'baseline', strategy: 'hybrid' }, k: 3, mean_precision: 1, mean_recall: 1, mean_mrr: 1, mean_ndcg: 1, queries: [] },
    candidate: { config: { name: 'candidate', strategy: 'hybrid' }, k: 3, mean_precision: ok ? 1 : 0.5, mean_recall: 1, mean_mrr: ok ? 1 : 0.5, mean_ndcg: ok ? 1 : 0.5, queries: [] },
    metrics: { mean_mrr_delta: ok ? 0 : -0.5, mean_ndcg_delta: ok ? 0 : -0.5, mean_precision_delta: ok ? 0 : -0.5, mean_recall_delta: 0, protected_top1_total: 13, protected_top1_passed: ok ? 13 : 12 },
  };
}

describe('retrieval canary planner', () => {
  test('shadow mode always returns baseline and logs candidate comparison', () => {
    const output = tmp();
    const result = planRetrievalCanary({ mode: 'shadow', profile: 'Hermes', gate: gate(true), outputRoot: output });

    expect(result.mode).toBe('shadow');
    expect(result.baseline_returned).toBe(true);
    expect(result.candidate_served).toBe(false);
    expect(result.canary_enabled).toBe(false);
    expect(result.rollback_required).toBe(false);
    expect(result.safety_notes).toContain('Shadow mode returns baseline results only.');
    expect(existsSync(join(output, 'retrieval-canary.json'))).toBe(true);
    expect(readFileSync(join(output, 'retrieval-canary.md'), 'utf8')).toContain('live global ranking changed: false');
  });

  test('canary mode requires an allowlisted profile and passing gate', () => {
    const result = planRetrievalCanary({ mode: 'canary', profile: 'Hermes', allowedProfiles: ['Hermes'], gate: gate(true), dryRun: true });

    expect(result.canary_enabled).toBe(true);
    expect(result.candidate_served).toBe(true);
    expect(result.scope).toBe('profile:Hermes');
  });

  test('canary mode fails closed when gate fails or profile is not allowlisted', () => {
    const failedGate = planRetrievalCanary({ mode: 'canary', profile: 'Hermes', allowedProfiles: ['Hermes'], gate: gate(false), dryRun: true });
    const blockedProfile = planRetrievalCanary({ mode: 'canary', profile: 'Argos', allowedProfiles: ['Hermes'], gate: gate(true), dryRun: true });

    expect(failedGate.canary_enabled).toBe(false);
    expect(failedGate.rollback_required).toBe(true);
    expect(blockedProfile.canary_enabled).toBe(false);
    expect(blockedProfile.blockers.join('\n')).toMatch(/not allowlisted/i);
  });

  test('canary mode requires an explicit allow-profile entry', () => {
    const missingAllowlist = planRetrievalCanary({ mode: 'canary', profile: 'Hermes', allowedProfiles: [], gate: gate(true), dryRun: true });

    expect(missingAllowlist.canary_enabled).toBe(false);
    expect(missingAllowlist.candidate_served).toBe(false);
    expect(missingAllowlist.baseline_returned).toBe(true);
    expect(missingAllowlist.rollback_required).toBe(true);
    expect(missingAllowlist.blockers.join('\n')).toMatch(/allow-profile|allowlist/i);
  });

  test('renders explicit rollback and no-global-change notes', () => {
    const result = planRetrievalCanary({ mode: 'canary', profile: 'Hermes', allowedProfiles: ['Hermes'], gate: gate(true), dryRun: true });
    const markdown = renderRetrievalCanaryMarkdown(result);

    expect(markdown).toContain('# Retrieval Canary Report');
    expect(markdown).toContain('live global ranking changed: false');
    expect(markdown).toContain('rollback');
  });
});
