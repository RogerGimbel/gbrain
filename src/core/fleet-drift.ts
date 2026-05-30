import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';

export type FleetDriftKind = 'stale-source' | 'conflict' | 'dead-reference' | 'superseded-checkpoint';

export interface FleetDriftInput {
  root: string;
  outputRoot?: string;
  dryRun?: boolean;
  now?: Date;
  staleAfterDays?: number;
}

export interface FleetDriftFinding {
  kind: FleetDriftKind;
  severity: 'low' | 'medium' | 'high';
  path: string;
  subject: string;
  message: string;
  evidence: string[];
}

export interface FleetDriftReport {
  generated_at: string;
  root: string;
  summary: {
    files_scanned: number;
    total_findings: number;
    stale_sources: number;
    conflicts: number;
    dead_references: number;
    superseded_checkpoints: number;
  };
  findings: FleetDriftFinding[];
  sideEffects: {
    canonicalVaultWrites: 0;
    liveDbWrites: 0;
    deletes: 0;
  };
}

export function analyzeFleetDrift(input: FleetDriftInput): FleetDriftReport {
  if (!existsSync(input.root)) throw new Error(`Root not found: ${input.root}`);
  const now = input.now ?? new Date();
  const staleAfterDays = input.staleAfterDays ?? 30;
  const files = listMarkdownFiles(input.root).filter(file => isFleetRelevant(relative(input.root, file).replace(/\\/g, '/')));
  const docs = files.map(file => ({ path: relative(input.root, file).replace(/\\/g, '/'), abs: file, content: readFileSync(file, 'utf8'), fm: parseFrontmatter(readFileSync(file, 'utf8')) }));
  const findings: FleetDriftFinding[] = [];
  findings.push(...findStaleSources(docs, now, staleAfterDays));
  findings.push(...findConflicts(docs));
  findings.push(...findDeadRefs(docs));
  findings.push(...findSupersededCheckpoints(docs));
  findings.sort((a, b) => `${a.kind}:${a.path}`.localeCompare(`${b.kind}:${b.path}`));
  const report: FleetDriftReport = {
    generated_at: now.toISOString(),
    root: input.root,
    summary: {
      files_scanned: docs.length,
      total_findings: findings.length,
      stale_sources: findings.filter(f => f.kind === 'stale-source').length,
      conflicts: findings.filter(f => f.kind === 'conflict').length,
      dead_references: findings.filter(f => f.kind === 'dead-reference').length,
      superseded_checkpoints: findings.filter(f => f.kind === 'superseded-checkpoint').length,
    },
    findings,
    sideEffects: { canonicalVaultWrites: 0, liveDbWrites: 0, deletes: 0 },
  };

  if (input.outputRoot && !input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'fleet-drift.json'), JSON.stringify(report, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'fleet-drift.md'), renderFleetDriftMarkdown(report), 'utf8');
  }
  return report;
}

export function renderFleetDriftMarkdown(report: FleetDriftReport): string {
  const lines = [
    '# Fleet Drift Report',
    '',
    'Mode: evidence-first report only; no rewrites or deletes were performed.',
    '',
    `Root: \`${report.root}\``,
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- files scanned: ${report.summary.files_scanned}`,
    `- total findings: ${report.summary.total_findings}`,
    `- stale sources: ${report.summary.stale_sources}`,
    `- conflicts: ${report.summary.conflicts}`,
    `- dead references: ${report.summary.dead_references}`,
    `- superseded checkpoints: ${report.summary.superseded_checkpoints}`,
    `- canonical vault writes: ${report.sideEffects.canonicalVaultWrites}`,
    '',
    '## Findings',
    '',
  ];
  for (const finding of report.findings) {
    lines.push(`### ${finding.kind}: ${finding.subject}`);
    lines.push(`- path: \`${finding.path}\``);
    lines.push(`- severity: ${finding.severity}`);
    lines.push(`- message: ${finding.message}`);
    lines.push(`- evidence: ${finding.evidence.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

type Doc = { path: string; abs: string; content: string; fm: Record<string, string> };

function findStaleSources(docs: Doc[], now: Date, staleAfterDays: number): FleetDriftFinding[] {
  const out: FleetDriftFinding[] = [];
  for (const doc of docs) {
    const updated = doc.fm.source_updated_at ?? doc.fm.updated ?? doc.fm.created;
    if (!updated) continue;
    const age = (now.valueOf() - new Date(updated).valueOf()) / 86_400_000;
    if (Number.isFinite(age) && age > staleAfterDays) {
      out.push({
        kind: 'stale-source',
        severity: age > staleAfterDays * 4 ? 'high' : 'medium',
        path: doc.path,
        subject: doc.fm.source_agent ?? doc.fm.agent ?? doc.path,
        message: `source metadata is ${age.toFixed(1)} days old`,
        evidence: [`source_updated_at=${updated}`, `stale_after_days=${staleAfterDays}`],
      });
    }
  }
  return out;
}

function findConflicts(docs: Doc[]): FleetDriftFinding[] {
  const claimPattern = /\b(Hermes|Argos|Winston|Cato|Rogue|OOMOps)\s+status\s*:\s*(healthy|degraded|blocked|disconnected|connected)\b/ig;
  const claims = new Map<string, Array<{ path: string; value: string }>>();
  for (const doc of docs) {
    for (const match of doc.content.matchAll(claimPattern)) {
      const agent = match[1];
      const value = match[2].toLowerCase();
      const arr = claims.get(agent) ?? [];
      arr.push({ path: doc.path, value });
      claims.set(agent, arr);
    }
  }
  const out: FleetDriftFinding[] = [];
  for (const [agent, arr] of claims) {
    const values = new Set(arr.map(a => a.value));
    if (values.size > 1) {
      out.push({
        kind: 'conflict',
        severity: 'medium',
        path: arr.map(a => a.path).join(', '),
        subject: `${agent} status`,
        message: `conflicting status claims: ${Array.from(values).join(', ')}`,
        evidence: arr.map(a => `${a.path} says ${a.value}`),
      });
    }
  }
  return out;
}

function findDeadRefs(docs: Doc[]): FleetDriftFinding[] {
  const out: FleetDriftFinding[] = [];
  const pathPattern = /(?:^|\s)(\/(?:Users|tmp|var|opt|Volumes)\/[^\s`)'\"]+)/g;
  for (const doc of docs) {
    for (const match of doc.content.matchAll(pathPattern)) {
      const ref = match[1].replace(/[.,;:]$/, '');
      if (!existsSync(ref)) {
        out.push({
          kind: 'dead-reference',
          severity: 'low',
          path: doc.path,
          subject: ref,
          message: 'local file reference does not exist',
          evidence: [`missing path ${ref}`],
        });
      }
    }
  }
  return out;
}

function findSupersededCheckpoints(docs: Doc[]): FleetDriftFinding[] {
  const byDir = new Map<string, Doc[]>();
  for (const doc of docs.filter(d => d.path.startsWith('knowledge/checkpoints/dev/'))) {
    const dir = doc.path.split('/').slice(0, -1).join('/');
    const arr = byDir.get(dir) ?? [];
    arr.push(doc);
    byDir.set(dir, arr);
  }
  const out: FleetDriftFinding[] = [];
  for (const [dir, arr] of byDir) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.path.localeCompare(b.path));
    const latest = arr[arr.length - 1];
    for (const old of arr.slice(0, -1)) {
      out.push({
        kind: 'superseded-checkpoint',
        severity: 'low',
        path: old.path,
        subject: dir,
        message: 'older checkpoint appears superseded by a later checkpoint in same lane',
        evidence: [`older=${old.path}`, `latest=${latest.path}`],
      });
    }
  }
  return out;
}

function listMarkdownFiles(root: string): string[] {
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

function isFleetRelevant(rel: string): boolean {
  return rel.startsWith('knowledge/agent-fleet/') || rel.startsWith('knowledge/checkpoints/dev/') || rel.startsWith('knowledge/agents/');
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
