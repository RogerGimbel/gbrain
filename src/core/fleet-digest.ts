import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface FleetDigestInput {
  outputRoot?: string;
  dryRun?: boolean;
  promotionQueue?: any;
  sourceHealth?: any;
  fleetDrift?: any;
  retrievalCanary?: any;
  promotionQueuePath?: string;
  sourceHealthPath?: string;
  fleetDriftPath?: string;
  retrievalCanaryPath?: string;
}

export interface FleetDigest {
  schema_version: 1;
  generated_at: string;
  title: string;
  sections: {
    promotion_queue: string;
    source_health: string;
    fleet_drift: string;
    retrieval_canary: string;
  };
  degraded_inputs: string[];
  recommendations: string[];
  delivery: {
    telegram_ready: boolean;
    scheduled_safe: boolean;
  };
  sideEffects: {
    canonicalVaultWrites: 0;
    liveDbWrites: 0;
    taskExecutions: 0;
  };
}

export function buildFleetDigest(input: FleetDigestInput): FleetDigest {
  const promotionQueue = input.promotionQueue ?? loadJson(input.promotionQueuePath);
  const sourceHealth = input.sourceHealth ?? loadJson(input.sourceHealthPath);
  const fleetDrift = input.fleetDrift ?? loadJson(input.fleetDriftPath);
  const retrievalCanary = input.retrievalCanary ?? loadJson(input.retrievalCanaryPath);
  const digest: FleetDigest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    title: 'GBrain Fleet Digest',
    sections: {
      promotion_queue: summarizePromotionQueue(promotionQueue),
      source_health: summarizeSourceHealth(sourceHealth),
      fleet_drift: summarizeFleetDrift(fleetDrift),
      retrieval_canary: summarizeRetrievalCanary(retrievalCanary),
    },
    degraded_inputs: degradedInputs(promotionQueue, sourceHealth, fleetDrift, retrievalCanary),
    recommendations: recommendations(promotionQueue, sourceHealth, fleetDrift, retrievalCanary),
    delivery: { telegram_ready: true, scheduled_safe: true },
    sideEffects: { canonicalVaultWrites: 0, liveDbWrites: 0, taskExecutions: 0 },
  };
  if (input.outputRoot && !input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'fleet-digest.json'), JSON.stringify(digest, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'fleet-digest.md'), renderFleetDigestMarkdown(digest), 'utf8');
  }
  return digest;
}

export function renderFleetDigestMarkdown(digest: FleetDigest): string {
  return [
    '---',
    'title: Fleet Digest',
    'type: fleet-digest',
    'source_agent: GBrain',
    'source_origin: fleet-digest',
    `source_updated_at: ${digest.generated_at}`,
    'status: staged',
    '---',
    '',
    '# Fleet Digest',
    '',
    `Generated: ${digest.generated_at}`,
    '',
    '## Promotion Queue',
    '',
    `- ${digest.sections.promotion_queue}`,
    '',
    '## Source Health',
    '',
    `- ${digest.sections.source_health}`,
    '',
    '## Fleet Drift',
    '',
    `- ${digest.sections.fleet_drift}`,
    '',
    '## Retrieval Canary',
    '',
    `- ${digest.sections.retrieval_canary}`,
    '',
    '## Degraded Inputs',
    '',
    ...(digest.degraded_inputs.length ? digest.degraded_inputs.map(d => `- ${d}`) : ['- none']),
    '',
    '## Recommendations',
    '',
    ...(digest.recommendations.length ? digest.recommendations.map(r => `- ${r}`) : ['- none']),
    '',
    '## Side Effects',
    '',
    `- canonical vault writes: ${digest.sideEffects.canonicalVaultWrites}`,
    `- live DB writes: ${digest.sideEffects.liveDbWrites}`,
    `- task executions: ${digest.sideEffects.taskExecutions}`,
    '',
  ].join('\n');
}

function loadJson(path?: string): any | undefined {
  if (!path) return undefined;
  if (!existsSync(path)) return degradedInput(path, 'missing');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return degradedInput(path, `malformed JSON: ${message}`);
  }
}

function degradedInput(path: string, reason: string): any {
  return { __fleet_digest_degraded_input: true, path, reason };
}

function isDegradedInput(value: any): boolean {
  return Boolean(value?.__fleet_digest_degraded_input);
}

function degradedSummary(name: string, report: any): string {
  return `${name} unavailable (${report.reason}: ${report.path})`;
}

function summarizePromotionQueue(report: any): string {
  if (!report) return 'no promotion queue input';
  if (isDegradedInput(report)) return degradedSummary('promotion queue', report);
  const s = report.summary ?? {};
  return `${s.ready_items ?? 0} ready, ${s.blocked_items ?? 0} blocked, ${s.total_items ?? 0} total promotion item(s)`;
}

function summarizeSourceHealth(report: any): string {
  if (!report) return 'no source-health input';
  if (isDegradedInput(report)) return degradedSummary('source-health', report);
  const s = report.summary ?? {};
  return `${s.source_covered ?? 0}/${s.total_files ?? 0} source-covered, ${s.missing_source_metadata ?? 0} missing metadata, ${s.stale_sources ?? 0} stale`;
}

function summarizeFleetDrift(report: any): string {
  if (!report) return 'no fleet-drift input';
  if (isDegradedInput(report)) return degradedSummary('fleet-drift', report);
  const s = report.summary ?? {};
  return `${s.total_findings ?? 0} finding(s), ${s.conflicts ?? 0} conflict(s), ${s.dead_references ?? 0} dead reference(s), ${s.superseded_checkpoints ?? 0} superseded checkpoint(s)`;
}

function summarizeRetrievalCanary(report: any): string {
  if (!report) return 'no retrieval-canary input';
  if (isDegradedInput(report)) return degradedSummary('retrieval-canary', report);
  const metrics = report.gate_metrics ?? {};
  return `${report.mode ?? 'unknown'} mode, gate ok ${Boolean(report.gate_ok)}, canary enabled ${Boolean(report.canary_enabled)}, protected top1 ${metrics.protected_top1_passed ?? '?'}/${metrics.protected_top1_total ?? '?'}, MRR delta ${metrics.mean_mrr_delta ?? '?'}`;
}

function degradedInputs(queue: any, source: any, drift: any, canary: any): string[] {
  return [
    ['promotion queue', queue],
    ['source-health', source],
    ['fleet-drift', drift],
    ['retrieval-canary', canary],
  ].flatMap(([name, report]) => isDegradedInput(report) ? [`${name}: ${report.reason} (${report.path})`] : []);
}

function recommendations(queue: any, source: any, drift: any, canary: any): string[] {
  const out: string[] = [];
  const degraded = degradedInputs(queue, source, drift, canary);
  if (degraded.length > 0) out.push('Digest is degraded: resolve missing or malformed report inputs before relying on full fleet status.');
  if ((queue?.summary?.ready_items ?? 0) > 0) out.push('Review ready promotion queue items for possible controlled promotion.');
  if ((queue?.summary?.blocked_items ?? 0) > 0) out.push('Resolve blocked promotion items before retrying promotion.');
  if ((source?.summary?.missing_source_metadata ?? 0) > 0) out.push('Run source-fix-proposals for missing source metadata.');
  if ((drift?.summary?.total_findings ?? 0) > 0) out.push('Triage fleet-drift findings with evidence before editing canonical notes.');
  if (canary?.rollback_required) out.push('Keep retrieval canary disabled until gate/profile blockers are resolved.');
  if (canary && !isDegradedInput(canary) && !canary.rollback_required && canary.gate_ok) out.push('Retrieval candidate is safe to keep in shadow mode or a scoped profile canary.');
  if (out.length === 0) out.push('No urgent fleet maintenance action detected.');
  return out;
}
