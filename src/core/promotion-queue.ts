import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join, relative } from 'path';

export type PromotionRisk = 'low' | 'medium' | 'high';
export type PromotionStatus = 'ready' | 'blocked';

export interface PromotionQueueInput {
  inputRoot: string;
  outputRoot?: string;
  dryRun?: boolean;
}

export interface PromotionQueueItem {
  id: string;
  path: string;
  relative_path: string;
  title: string;
  artifact_class: string;
  source_agent: string;
  source_origin?: string;
  source_id?: string;
  checksum: string;
  risk: PromotionRisk;
  status: PromotionStatus;
  suggested_target: string;
  blockers: string[];
}

export interface PromotionQueueReport {
  generated_at: string;
  input_root: string;
  output_root?: string;
  summary: {
    total_items: number;
    ready_items: number;
    blocked_items: number;
    high_risk_items: number;
  };
  items: PromotionQueueItem[];
  sideEffects: {
    liveDbWrites: 0;
    canonicalVaultWrites: 0;
    liveSync: 0;
  };
}

const SECRET_PATTERNS = [
  /\b(api[_-]?key|secret|token|password|connection[_-]?string)\b\s*[:=]/i,
  /\bsk-[A-Za-z0-9._-]{8,}\b/,
  /postgres(?:ql)?:\/\//i,
];

export function scanPromotionQueue(input: PromotionQueueInput): PromotionQueueReport {
  if (!existsSync(input.inputRoot)) throw new Error(`Input root not found: ${input.inputRoot}`);
  const files = walk(input.inputRoot).filter(path => ['.md', '.json', '.txt'].includes(extname(path).toLowerCase()));
  const items = files.map(file => buildItem(file, input.inputRoot)).sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  const report: PromotionQueueReport = {
    generated_at: new Date().toISOString(),
    input_root: input.inputRoot,
    output_root: input.outputRoot,
    summary: {
      total_items: items.length,
      ready_items: items.filter(i => i.status === 'ready').length,
      blocked_items: items.filter(i => i.status === 'blocked').length,
      high_risk_items: items.filter(i => i.risk === 'high').length,
    },
    items,
    sideEffects: { liveDbWrites: 0, canonicalVaultWrites: 0, liveSync: 0 },
  };

  if (input.outputRoot && !input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'promotion-queue.json'), JSON.stringify(report, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'promotion-queue.md'), renderPromotionQueueMarkdown(report), 'utf8');
  }

  return report;
}

export function renderPromotionQueueMarkdown(report: PromotionQueueReport): string {
  const lines = [
    '# GBrain Promotion Queue',
    '',
    `Generated: ${report.generated_at}`,
    `Input root: \`${report.input_root}\``,
    '',
    '## Summary',
    '',
    `- total items: ${report.summary.total_items}`,
    `- ready items: ${report.summary.ready_items}`,
    `- blocked items: ${report.summary.blocked_items}`,
    `- high risk items: ${report.summary.high_risk_items}`,
    `- live DB writes: ${report.sideEffects.liveDbWrites}`,
    `- canonical vault writes: ${report.sideEffects.canonicalVaultWrites}`,
    `- live sync: ${report.sideEffects.liveSync}`,
    '',
    '## Items',
    '',
  ];
  for (const item of report.items) {
    lines.push(`### ${item.title}`);
    lines.push(`- id: \`${item.id}\``);
    lines.push(`- class: ${item.artifact_class}`);
    lines.push(`- status: ${item.status}`);
    lines.push(`- risk: ${item.risk}`);
    lines.push(`- source agent: ${item.source_agent}`);
    lines.push(`- suggested target: \`${item.suggested_target}\``);
    lines.push(`- checksum: \`${item.checksum}\``);
    if (item.blockers.length) lines.push(`- blockers: ${item.blockers.join('; ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildItem(file: string, root: string): PromotionQueueItem {
  const content = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(content);
  const artifactClass = classifyArtifact(file, content, fm);
  const blockers = blockersFor(file, content, artifactClass);
  const risk = riskFor(artifactClass, blockers);
  const checksum = createHash('sha256').update(content).digest('hex');
  const rel = relative(root, file);
  return {
    id: createHash('sha256').update(`${rel}:${checksum}`).digest('hex').slice(0, 16),
    path: file,
    relative_path: rel,
    title: fm.title ?? basename(file),
    artifact_class: artifactClass,
    source_agent: fm.source_agent ?? fm.agent ?? 'unknown',
    source_origin: fm.source_origin,
    source_id: fm.source_id,
    checksum,
    risk,
    status: blockers.length ? 'blocked' : 'ready',
    suggested_target: suggestedTarget(artifactClass),
    blockers,
  };
}

function blockersFor(file: string, content: string, artifactClass: string): string[] {
  const blockers: string[] = [];
  const name = basename(file).toLowerCase();
  if (artifactClass === 'raw-transcript' || name.includes('transcript')) blockers.push('raw transcript promotion is blocked');
  if (SECRET_PATTERNS.some(pattern => pattern.test(content))) blockers.push('secret-looking value detected; redact before promotion');
  return blockers;
}

function classifyArtifact(file: string, content: string, fm: Record<string, string>): string {
  const lower = `${file}\n${content.slice(0, 500)}`.toLowerCase();
  if (fm.type) return fm.type;
  if (lower.includes('raw transcript') || extname(file).toLowerCase() === '.txt') return 'raw-transcript';
  if (lower.includes('retrieval-experiment')) return 'retrieval-gate';
  if (lower.includes('source_health') || lower.includes('source-health') || lower.includes('source_covered')) return 'source-health';
  if (lower.includes('orphan')) return 'orphan-report';
  if (lower.includes('proactive-synthesis')) return 'synthesis-brief';
  return extname(file).toLowerCase() === '.json' ? 'json-report' : 'markdown-artifact';
}

function riskFor(artifactClass: string, blockers: string[]): PromotionRisk {
  if (blockers.length) return 'high';
  if (['source-health', 'retrieval-gate', 'orphan-report', 'json-report'].includes(artifactClass)) return 'low';
  if (artifactClass === 'session-packet' || artifactClass === 'synthesis-brief') return 'medium';
  return 'medium';
}

function suggestedTarget(artifactClass: string): string {
  switch (artifactClass) {
    case 'session-packet': return 'knowledge/session-packets/';
    case 'source-health': return 'knowledge/reports/source-health/';
    case 'retrieval-gate': return 'knowledge/reports/retrieval-gates/';
    case 'orphan-report': return 'knowledge/reports/graph/';
    case 'synthesis-brief': return 'knowledge/agent-fleet/briefs/';
    default: return 'knowledge/reports/staged/';
  }
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function walk(root: string): string[] {
  const entries = readdirSync(root);
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else if (st.isFile()) out.push(path);
  }
  return out;
}
