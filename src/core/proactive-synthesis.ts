import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

export interface ProactiveSynthesisInput {
  sourceHealth?: string;
  capabilityCatalog?: string;
  orphanReport?: string;
  retrievalExperiment?: string;
  title?: string;
}

export interface ProactiveSynthesis {
  schema_version: 1;
  generated_at: string;
  title: string;
  status: 'sandbox-only';
  highlights: string[];
  follow_ups: string[];
  promotion_checklist: string[];
  inputs: Record<string, string | undefined>;
  side_effects: {
    llmCalls: 0;
    liveDbWrites: 0;
    canonicalVaultWrites: 0;
    liveSync: 0;
  };
}

const DEFAULT_CANONICAL_ROOT = '/Users/rogergimbel/Knowledge/Winston';

export function assertSafeSynthesisRoot(outputRoot: string, canonicalRoot = DEFAULT_CANONICAL_ROOT): void {
  const out = resolve(outputRoot);
  const canonical = resolve(canonicalRoot);
  if (out === canonical || out.startsWith(canonical + '/')) {
    throw new Error(`Refusing synthesis output under canonical Obsidian root: ${canonical}`);
  }
}

export function buildProactiveSynthesis(input: ProactiveSynthesisInput): ProactiveSynthesis {
  const highlights: string[] = [];
  const followUps: string[] = [];

  const source = readJson(input.sourceHealth);
  const sourceSummary = source?.summary;
  if (sourceSummary) {
    highlights.push(`Source coverage: ${num(sourceSummary.source_covered)}/${num(sourceSummary.total_files)} fleet-relevant file(s) covered.`);
    if (num(sourceSummary.missing_source_metadata) > 0) followUps.push(`${num(sourceSummary.missing_source_metadata)} file(s) missing source metadata.`);
    if (num(sourceSummary.stale_sources) > 0) followUps.push(`${num(sourceSummary.stale_sources)} stale source record(s) need review.`);
  }

  const capability = readJson(input.capabilityCatalog);
  const catalog = capability?.catalog ?? capability;
  if (catalog?.agents || catalog?.routes) {
    highlights.push(`Capability catalog: ${arr(catalog.agents).length} agent(s), ${arr(catalog.routes).length} route(s).`);
    const emptyRoutes = arr(catalog.routes).filter((r: any) => arr(r.agents).length === 0).map((r: any) => r.id).filter(Boolean);
    if (emptyRoutes.length > 0) followUps.push(`Capability routes without agents: ${emptyRoutes.join(', ')}.`);
  }

  const orphan = readJson(input.orphanReport);
  const orphanSummary = orphan?.report?.summary ?? orphan?.summary;
  if (orphanSummary) {
    highlights.push(`Graph orphans: ${num(orphanSummary.orphan_pages)}/${num(orphanSummary.total_pages)} page(s), ${num(orphanSummary.groups)} group(s).`);
    if (num(orphanSummary.orphan_pages) > 0) followUps.push(`Review remaining ${num(orphanSummary.orphan_pages)} orphan page(s) before auto-linking.`);
  }

  const retrieval = readJson(input.retrievalExperiment);
  const retrievalResult = retrieval?.result ?? retrieval;
  if (retrievalResult?.metrics) {
    const m = retrievalResult.metrics;
    const status = retrievalResult.ok ? 'passed' : 'failed';
    highlights.push(`Retrieval gate ${status}: protected top1 ${num(m.protected_top1_passed)}/${num(m.protected_top1_total)}, MRR delta ${num(m.mean_mrr_delta)}.`);
    if (!retrievalResult.ok) followUps.push('Retrieval experiment failed; do not promote candidate search config.');
  }

  if (highlights.length === 0) highlights.push('No input artifacts supplied; synthesis shell only.');
  if (followUps.length === 0) followUps.push('No immediate follow-ups detected from supplied artifacts.');

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    title: input.title ?? 'GBrain Agent Fleet Proactive Synthesis',
    status: 'sandbox-only',
    highlights,
    follow_ups: followUps,
    promotion_checklist: [
      'Verify all input artifacts are current and source-attributed.',
      'Confirm no secrets, raw transcripts, or private environment values are included.',
      'Promote only concise durable conclusions to Obsidian/GBrain.',
      'Keep speculative observations out of always-on memory.',
    ],
    inputs: {
      sourceHealth: input.sourceHealth,
      capabilityCatalog: input.capabilityCatalog,
      orphanReport: input.orphanReport,
      retrievalExperiment: input.retrievalExperiment,
    },
    side_effects: { llmCalls: 0, liveDbWrites: 0, canonicalVaultWrites: 0, liveSync: 0 },
  };
}

export function renderProactiveSynthesisMarkdown(synthesis: ProactiveSynthesis): string {
  return [
    '---',
    `title: ${JSON.stringify(synthesis.title)}`,
    'type: proactive-synthesis',
    'status: sandbox-only',
    'source_agent: GBrain',
    'source_origin: proactive-synthesis',
    `source_updated_at: ${synthesis.generated_at}`,
    'confidence: medium',
    '---',
    '',
    `# ${synthesis.title}`,
    '',
    'Status: sandbox-only',
    '',
    '## Highlights',
    list(synthesis.highlights),
    '',
    '## Follow-ups',
    list(synthesis.follow_ups),
    '',
    '## Promotion checklist',
    list(synthesis.promotion_checklist),
    '',
    '## Inputs',
    list(Object.entries(synthesis.inputs).filter(([, v]) => v).map(([k, v]) => `${k}: \`${v}\``)),
    '',
    '## Side effects',
    '',
    '- LLM calls: 0',
    '- live DB writes: 0',
    '- canonical vault writes: 0',
    '- live sync: 0',
    '',
  ].join('\n');
}

export function writeProactiveSynthesisSandbox(synthesis: ProactiveSynthesis, outputRoot: string, canonicalRoot = DEFAULT_CANONICAL_ROOT): { json: string; markdown: string } {
  assertSafeSynthesisRoot(outputRoot, canonicalRoot);
  mkdirSync(outputRoot, { recursive: true });
  const json = join(outputRoot, 'proactive-synthesis.json');
  const markdown = join(outputRoot, 'proactive-synthesis.md');
  writeFileSync(json, JSON.stringify(synthesis, null, 2), 'utf8');
  writeFileSync(markdown, renderProactiveSynthesisMarkdown(synthesis), 'utf8');
  return { json, markdown };
}

function readJson(path?: string): any | undefined {
  if (!path) return undefined;
  if (!existsSync(path)) throw new Error(`Input artifact not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function arr(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function list(items: string[]): string {
  return items.length ? items.map(i => `- ${i}`).join('\n') : '- none';
}
