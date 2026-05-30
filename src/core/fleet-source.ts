import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

export interface FleetSourceRecord {
  path: string;
  title?: string;
  type?: string;
  slug?: string;
  agent: string;
  profile?: string;
  origin?: string;
  source_id?: string;
  source_updated_at?: string;
  confidence?: string;
  status?: string;
  missing_fields: string[];
  stale: boolean;
  age_days?: number;
}

export interface FleetSourceSummary {
  root: string;
  generated_at: string;
  stale_after_days: number;
  total_files: number;
  source_covered: number;
  missing_source_metadata: number;
  stale_sources: number;
  agents: number;
}

export interface FleetAgentRollup {
  files: number;
  stale: number;
  missing_metadata: number;
  latest_source_updated_at?: string;
  origins: Record<string, number>;
  profiles: Record<string, number>;
}

export interface FleetSourceHealthReport {
  schema_version: 1;
  summary: FleetSourceSummary;
  by_agent: Record<string, FleetAgentRollup>;
  sources: FleetSourceRecord[];
  missing: FleetSourceRecord[];
  stale: FleetSourceRecord[];
}

export interface AnalyzeFleetSourcesOptions {
  now?: Date;
  staleAfterDays?: number;
  includeAllMarkdown?: boolean;
}

const DEFAULT_STALE_AFTER_DAYS = 14;
const REQUIRED_FIELDS = ['agent', 'source_updated_at'];

/**
 * Analyze source metadata on fleet/checkpoint markdown without mutating files.
 *
 * Source-aware convention accepts either compact `agent:` or explicit
 * `source_agent:` frontmatter. Optional fields include source_profile,
 * source_origin, source_id, confidence, and status.
 */
export function analyzeFleetSources(root: string, options: AnalyzeFleetSourcesOptions = {}): FleetSourceHealthReport {
  const now = options.now ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const files = listMarkdownFiles(root)
    .filter(path => options.includeAllMarkdown || isFleetRelevant(path, root));

  const sources = files.map(file => recordForFile(root, file, now, staleAfterDays));
  const missing = sources.filter(r => r.missing_fields.length > 0);
  const stale = sources.filter(r => r.stale);
  const by_agent: Record<string, FleetAgentRollup> = {};

  for (const source of sources) {
    const key = source.agent || 'unknown';
    const rollup = by_agent[key] ?? {
      files: 0,
      stale: 0,
      missing_metadata: 0,
      origins: {},
      profiles: {},
    };
    rollup.files += 1;
    if (source.stale) rollup.stale += 1;
    if (source.missing_fields.length > 0) rollup.missing_metadata += 1;
    if (source.origin) rollup.origins[source.origin] = (rollup.origins[source.origin] ?? 0) + 1;
    if (source.profile) rollup.profiles[source.profile] = (rollup.profiles[source.profile] ?? 0) + 1;
    if (source.source_updated_at && (!rollup.latest_source_updated_at || source.source_updated_at > rollup.latest_source_updated_at)) {
      rollup.latest_source_updated_at = source.source_updated_at;
    }
    by_agent[key] = rollup;
  }

  return {
    schema_version: 1,
    summary: {
      root,
      generated_at: now.toISOString(),
      stale_after_days: staleAfterDays,
      total_files: sources.length,
      source_covered: sources.length - missing.length,
      missing_source_metadata: missing.length,
      stale_sources: stale.length,
      agents: Object.keys(by_agent).length,
    },
    by_agent,
    sources,
    missing,
    stale,
  };
}

export function renderSourceHealthMarkdown(report: FleetSourceHealthReport): string {
  const s = report.summary;
  const lines = [
    '# Source Health',
    '',
    `- root: \`${s.root}\``,
    `- generated: ${s.generated_at}`,
    `- markdown files scanned: ${s.total_files}`,
    `- source covered: ${s.source_covered}`,
    `- missing source metadata: ${s.missing_source_metadata}`,
    `- stale sources: ${s.stale_sources} (>${s.stale_after_days} days)`,
    `- agents: ${s.agents}`,
    '',
    '## By agent',
    '',
  ];

  for (const [agent, rollup] of Object.entries(report.by_agent).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${agent}: ${rollup.files} file(s), stale ${rollup.stale}, missing metadata ${rollup.missing_metadata}`);
  }

  if (report.missing.length > 0) {
    lines.push('', '## Missing source metadata', '');
    for (const item of report.missing.slice(0, 25)) {
      lines.push(`- ${item.path}: missing ${item.missing_fields.join(', ')}`);
    }
  }

  if (report.stale.length > 0) {
    lines.push('', '## Stale sources', '');
    for (const item of report.stale.slice(0, 25)) {
      lines.push(`- ${item.path}: ${item.agent}, ${item.age_days?.toFixed(1)} days old (${item.source_updated_at ?? 'unknown'})`);
    }
  }

  return lines.join('\n') + '\n';
}

function recordForFile(root: string, file: string, now: Date, staleAfterDays: number): FleetSourceRecord {
  const content = readFileSync(file, 'utf-8');
  const fm = parseFrontmatter(content);
  const rel = relative(root, file).replace(/\\/g, '/');
  const agent = first(fm.source_agent, fm.agent, inferAgentFromPath(rel)) ?? 'unknown';
  const updated = first(fm.source_updated_at, fm.last_source_update, fm.last_reviewed, fm.updated, fm.created);
  const missing_fields = REQUIRED_FIELDS.filter(field => {
    if (field === 'agent') return agent === 'unknown';
    if (field === 'source_updated_at') return !updated;
    return false;
  });
  const ageDays = updated ? ageInDays(updated, now) : undefined;
  const stale = typeof ageDays === 'number' && ageDays > staleAfterDays;

  return {
    path: rel,
    title: stripQuotes(fm.title),
    type: fm.type,
    slug: first(fm.gbrain_slug, rel.replace(/\.md$/, '')),
    agent,
    profile: first(fm.source_profile, fm.profile),
    origin: first(fm.source_origin, fm.origin, fm.source_type),
    source_id: fm.source_id,
    source_updated_at: updated,
    confidence: fm.confidence,
    status: fm.status,
    missing_fields,
    stale,
    age_days: ageDays,
  };
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const body = content.slice(4, end);
  const result: Record<string, string> = {};
  for (const line of body.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#') || /^\s+-\s+/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]!] = stripQuotes(match[2]!.trim()) ?? '';
  }
  return result;
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === '.git' || entry === 'node_modules' || entry === '.obsidian') continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function isFleetRelevant(file: string, root: string): boolean {
  const rel = relative(root, file).replace(/\\/g, '/');
  return rel.startsWith('knowledge/agent-fleet/')
    || rel.startsWith('knowledge/checkpoints/dev/')
    || rel.startsWith('knowledge/agents/')
    || rel.includes('/agent-fleet/');
}

function inferAgentFromPath(rel: string): string | undefined {
  const lower = rel.toLowerCase();
  for (const name of ['hermes', 'argos', 'winston', 'cato', 'rogue', 'oomops', 'rodaco']) {
    if (lower.includes(name)) return name === 'oomops' ? 'OOMOps' : name[0].toUpperCase() + name.slice(1);
  }
  return undefined;
}

function ageInDays(value: string, now: Date): number | undefined {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return undefined;
  return (now.valueOf() - date.valueOf()) / 86_400_000;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find(v => typeof v === 'string' && v.trim().length > 0);
}

function stripQuotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/^['"]|['"]$/g, '');
}
