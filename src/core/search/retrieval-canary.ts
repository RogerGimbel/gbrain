import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RetrievalExperimentResult } from './retrieval-experiment.ts';

export type RetrievalCanaryMode = 'shadow' | 'canary';

export interface RetrievalCanaryInput {
  mode: RetrievalCanaryMode;
  profile?: string;
  allowedProfiles?: string[];
  gate: RetrievalExperimentResult;
  outputRoot?: string;
  dryRun?: boolean;
}

export interface RetrievalCanaryReport {
  schema_version: 1;
  generated_at: string;
  mode: RetrievalCanaryMode;
  scope: string;
  profile?: string;
  gate_ok: boolean;
  canary_enabled: boolean;
  baseline_returned: boolean;
  candidate_served: boolean;
  rollback_required: boolean;
  live_global_ranking_changed: false;
  blockers: string[];
  safety_notes: string[];
  gate_metrics: RetrievalExperimentResult['metrics'];
  sideEffects: {
    globalRankingWrites: 0;
    liveDbWrites: 0;
  };
}

export function planRetrievalCanary(input: RetrievalCanaryInput): RetrievalCanaryReport {
  const blockers: string[] = [];
  const allowed = input.allowedProfiles ?? [];
  if (input.mode === 'canary') {
    if (!input.profile) blockers.push('canary mode requires --profile');
    if (input.profile && allowed.length > 0 && !allowed.includes(input.profile)) blockers.push(`profile ${input.profile} is not allowlisted for retrieval canary`);
    if (!input.gate.ok) blockers.push('retrieval experiment gate failed');
  }
  const canaryEnabled = input.mode === 'canary' && blockers.length === 0;
  const report: RetrievalCanaryReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: input.mode,
    scope: canaryEnabled ? `profile:${input.profile}` : 'shadow/baseline',
    profile: input.profile,
    gate_ok: input.gate.ok,
    canary_enabled: canaryEnabled,
    baseline_returned: input.mode === 'shadow' || !canaryEnabled,
    candidate_served: canaryEnabled,
    rollback_required: input.mode === 'canary' && (!input.gate.ok || blockers.length > 0),
    live_global_ranking_changed: false,
    blockers,
    safety_notes: safetyNotes(input.mode, canaryEnabled),
    gate_metrics: input.gate.metrics,
    sideEffects: { globalRankingWrites: 0, liveDbWrites: 0 },
  };
  if (input.outputRoot && !input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'retrieval-canary.json'), JSON.stringify(report, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'retrieval-canary.md'), renderRetrievalCanaryMarkdown(report), 'utf8');
  }
  return report;
}

export function renderRetrievalCanaryMarkdown(report: RetrievalCanaryReport): string {
  return [
    '---',
    'title: Retrieval Canary Report',
    'type: retrieval-canary-report',
    'source_agent: GBrain',
    'source_origin: retrieval-canary',
    `source_updated_at: ${report.generated_at}`,
    `status: ${report.canary_enabled || report.mode === 'shadow' ? 'pass' : 'blocked'}`,
    '---',
    '',
    '# Retrieval Canary Report',
    '',
    `- mode: ${report.mode}`,
    `- scope: ${report.scope}`,
    `- gate ok: ${report.gate_ok}`,
    `- canary enabled: ${report.canary_enabled}`,
    `- baseline returned: ${report.baseline_returned}`,
    `- candidate served: ${report.candidate_served}`,
    `- rollback required: ${report.rollback_required}`,
    `- live global ranking changed: ${report.live_global_ranking_changed}`,
    '',
    '## Gate metrics',
    '',
    `- protected top1: ${report.gate_metrics.protected_top1_passed}/${report.gate_metrics.protected_top1_total}`,
    `- mean_mrr_delta: ${report.gate_metrics.mean_mrr_delta}`,
    `- mean_ndcg_delta: ${report.gate_metrics.mean_ndcg_delta}`,
    '',
    '## Blockers',
    '',
    ...(report.blockers.length ? report.blockers.map(b => `- ${b}`) : ['- none']),
    '',
    '## Safety / rollback',
    '',
    ...report.safety_notes.map(note => `- ${note}`),
    '- Rollback is disabling the explicit profile canary flag; no global ranking setting is changed by this command.',
    '',
  ].join('\n');
}

function safetyNotes(mode: RetrievalCanaryMode, enabled: boolean): string[] {
  if (mode === 'shadow') return ['Shadow mode returns baseline results only.', 'Candidate comparison is logged for review only.'];
  if (enabled) return ['Canary mode is scoped to an explicit allowlisted profile.', 'Global retrieval behavior remains unchanged.'];
  return ['Canary failed closed; baseline remains the only served result.', 'Review blockers before retrying.'];
}
