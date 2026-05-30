import type { EvalReplaySummary } from '../eval-capture.ts';

export interface CorrectnessGateResult {
  ok: boolean;
  failures: string[];
}

export function evaluateCorrectnessGate(summary: EvalReplaySummary): CorrectnessGateResult {
  const failures = summary.cases
    .filter((testCase) => !testCase.passed)
    .map((testCase) => `${testCase.query} expected ${testCase.expectedSlug ?? 'n/a'}, got ${testCase.actualTopSlug ?? 'none'}`);
  return { ok: failures.length === 0, failures };
}
