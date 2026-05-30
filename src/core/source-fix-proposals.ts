import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join, relative, resolve, sep } from 'path';

export interface SourceFixProposalInput {
  root: string;
  outputRoot?: string;
  dryRun?: boolean;
  now?: Date;
}

export interface SourceFixProposal {
  path: string;
  title: string;
  missing_fields: string[];
  confidence: 'low' | 'medium' | 'high';
  evidence: string[];
  proposed_frontmatter: Record<string, string>;
  patch: string;
}

export interface SourceFixProposalReport {
  generated_at: string;
  root: string;
  output_root?: string;
  summary: {
    files_scanned: number;
    total_proposals: number;
    high_confidence: number;
    medium_confidence: number;
    low_confidence: number;
  };
  proposals: SourceFixProposal[];
  sideEffects: {
    canonicalVaultWrites: 0;
    liveDbWrites: 0;
    liveSync: 0;
  };
}

export type SourceFixConfidence = 'low' | 'medium' | 'high';
export type SourceFixApplyStatus = 'eligible' | 'applied' | 'skipped' | 'blocked';

export interface SourceFixApplyInput {
  reportPath: string;
  root: string;
  outputRoot?: string;
  apply?: boolean;
  dryRun?: boolean;
  minConfidence?: SourceFixConfidence;
  excludeUnknown?: boolean;
  limit?: number;
}

export interface SourceFixApplyItem {
  path: string;
  status: SourceFixApplyStatus;
  confidence: SourceFixConfidence;
  proposed_frontmatter: Record<string, string>;
  reasons: string[];
}

export interface SourceFixApplyReceipt {
  schema_version: 1;
  generated_at: string;
  report_path: string;
  root: string;
  apply: boolean;
  min_confidence: SourceFixConfidence;
  exclude_unknown: boolean;
  limit?: number;
  summary: {
    proposals_seen: number;
    eligible: number;
    applied: number;
    skipped: number;
    blocked: number;
  };
  items: SourceFixApplyItem[];
  sideEffects: {
    canonicalVaultWrites: number;
    liveDbWrites: 0;
    liveSync: 0;
  };
}

export function generateSourceFixProposals(input: SourceFixProposalInput): SourceFixProposalReport {
  if (!existsSync(input.root)) throw new Error(`Root not found: ${input.root}`);
  const now = input.now ?? new Date();
  const files = listMarkdownFiles(input.root).filter(file => isFleetRelevant(relative(input.root, file).replace(/\\/g, '/')));
  const proposals = files.map(file => proposalForFile(input.root, file, now)).filter((p): p is SourceFixProposal => Boolean(p));
  const report: SourceFixProposalReport = {
    generated_at: now.toISOString(),
    root: input.root,
    output_root: input.outputRoot,
    summary: {
      files_scanned: files.length,
      total_proposals: proposals.length,
      high_confidence: proposals.filter(p => p.confidence === 'high').length,
      medium_confidence: proposals.filter(p => p.confidence === 'medium').length,
      low_confidence: proposals.filter(p => p.confidence === 'low').length,
    },
    proposals,
    sideEffects: { canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 },
  };

  if (input.outputRoot && !input.dryRun) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'source-fix-proposals.json'), JSON.stringify(report, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'source-fix-proposals.md'), renderSourceFixProposalMarkdown(report), 'utf8');
  }

  return report;
}

export function renderSourceFixProposalMarkdown(report: SourceFixProposalReport): string {
  const lines = [
    '# Source Metadata Fix Proposals',
    '',
    'Mode: review-only. These proposals do not mutate canonical notes or live GBrain.',
    '',
    `Root: \`${report.root}\``,
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- files scanned: ${report.summary.files_scanned}`,
    `- total proposals: ${report.summary.total_proposals}`,
    `- high confidence: ${report.summary.high_confidence}`,
    `- medium confidence: ${report.summary.medium_confidence}`,
    `- low confidence: ${report.summary.low_confidence}`,
    `- canonical vault writes: ${report.sideEffects.canonicalVaultWrites}`,
    '',
    '## Proposals',
    '',
  ];
  for (const proposal of report.proposals) {
    lines.push(`### ${proposal.path}`);
    lines.push(`- title: ${proposal.title}`);
    lines.push(`- confidence: ${proposal.confidence}`);
    lines.push(`- missing: ${proposal.missing_fields.join(', ')}`);
    lines.push(`- evidence: ${proposal.evidence.join('; ')}`);
    lines.push('');
    lines.push('```yaml');
    for (const [key, value] of Object.entries(proposal.proposed_frontmatter)) lines.push(`${key}: ${value}`);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

export function applySourceFixProposals(input: SourceFixApplyInput): SourceFixApplyReceipt {
  if (!existsSync(input.reportPath)) throw new Error(`Source fix proposal report not found: ${input.reportPath}`);
  if (!existsSync(input.root)) throw new Error(`Root not found: ${input.root}`);
  const report = JSON.parse(readFileSync(input.reportPath, 'utf8')) as SourceFixProposalReport;
  const minConfidence = input.minConfidence ?? 'medium';
  const excludeUnknown = input.excludeUnknown ?? true;
  const apply = Boolean(input.apply) && !input.dryRun;
  const limit = input.limit;
  const items: SourceFixApplyItem[] = [];
  let selected = 0;
  let applied = 0;

  for (const proposal of report.proposals ?? []) {
    const reasons = eligibilityReasons(input.root, proposal, minConfidence, excludeUnknown, limit, selected);
    const eligible = reasons.length === 0;
    if (eligible) selected += 1;
    let status: SourceFixApplyStatus = eligible ? 'eligible' : reasons.some(r => r.includes('escapes root') || r.includes('not found')) ? 'blocked' : 'skipped';
    if (eligible && apply) {
      const target = resolve(input.root, proposal.path);
      const content = readFileSync(target, 'utf8');
      const updated = applyFrontmatterAdditions(content, proposal.proposed_frontmatter);
      if (updated === content) {
        status = 'skipped';
        reasons.push('all proposed frontmatter already present');
      } else {
        writeFileSync(target, updated, 'utf8');
        status = 'applied';
        applied += 1;
      }
    }
    items.push({
      path: proposal.path,
      status,
      confidence: proposal.confidence,
      proposed_frontmatter: proposal.proposed_frontmatter,
      reasons,
    });
  }

  const receipt: SourceFixApplyReceipt = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    report_path: input.reportPath,
    root: input.root,
    apply,
    min_confidence: minConfidence,
    exclude_unknown: excludeUnknown,
    limit,
    summary: {
      proposals_seen: report.proposals?.length ?? 0,
      eligible: items.filter(i => i.status === 'eligible' || i.status === 'applied').length,
      applied: items.filter(i => i.status === 'applied').length,
      skipped: items.filter(i => i.status === 'skipped').length,
      blocked: items.filter(i => i.status === 'blocked').length,
    },
    items,
    sideEffects: { canonicalVaultWrites: applied, liveDbWrites: 0, liveSync: 0 },
  };
  if (input.outputRoot) {
    mkdirSync(input.outputRoot, { recursive: true });
    writeFileSync(join(input.outputRoot, 'source-fix-apply-receipt.json'), JSON.stringify(receipt, null, 2), 'utf8');
    writeFileSync(join(input.outputRoot, 'source-fix-apply-receipt.md'), renderSourceFixApplyReceiptMarkdown(receipt), 'utf8');
  }
  return receipt;
}

export function renderSourceFixApplyReceiptMarkdown(receipt: SourceFixApplyReceipt): string {
  return [
    '# Source Metadata Apply Receipt',
    '',
    `Generated: ${receipt.generated_at}`,
    `Mode: ${receipt.apply ? 'apply' : 'dry-run'}`,
    `Root: \`${receipt.root}\``,
    `Report: \`${receipt.report_path}\``,
    '',
    '## Summary',
    '',
    `- proposals seen: ${receipt.summary.proposals_seen}`,
    `- eligible: ${receipt.summary.eligible}`,
    `- applied: ${receipt.summary.applied}`,
    `- skipped: ${receipt.summary.skipped}`,
    `- blocked: ${receipt.summary.blocked}`,
    `- canonical vault writes: ${receipt.sideEffects.canonicalVaultWrites}`,
    `- live DB writes: ${receipt.sideEffects.liveDbWrites}`,
    `- live sync: ${receipt.sideEffects.liveSync}`,
    '',
    '## Items',
    '',
    ...receipt.items.map(item => `- ${item.status}: ${item.path}${item.reasons.length ? ` — ${item.reasons.join('; ')}` : ''}`),
    '',
  ].join('\n');
}

function eligibilityReasons(root: string, proposal: SourceFixProposal, minConfidence: SourceFixConfidence, excludeUnknown: boolean, limit: number | undefined, applied: number): string[] {
  const reasons: string[] = [];
  if (confidenceRank(proposal.confidence) < confidenceRank(minConfidence)) reasons.push(`confidence ${proposal.confidence} below ${minConfidence}`);
  if (excludeUnknown && proposal.proposed_frontmatter.source_agent === 'unknown') reasons.push('source_agent unknown requires manual review');
  const target = resolve(root, proposal.path);
  if (pathEscapesRoot(root, target)) reasons.push(`proposal path escapes root: ${proposal.path}`);
  else if (!existsSync(target)) reasons.push(`target file not found: ${proposal.path}`);
  if (limit !== undefined && applied >= limit) reasons.push(`limit ${limit} reached`);
  return reasons;
}

function confidenceRank(confidence: SourceFixConfidence): number {
  return { low: 0, medium: 1, high: 2 }[confidence];
}

function pathEscapesRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/') || rel === '' && false;
}

function applyFrontmatterAdditions(content: string, additions: Record<string, string>): string {
  const keys = Object.keys(additions).filter(key => !frontmatterHasKey(content, key));
  if (keys.length === 0) return content;
  const lines = keys.map(key => `${key}: ${additions[key]}`);
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4);
    if (end !== -1) return `${content.slice(0, end)}\n${lines.join('\n')}${content.slice(end)}`;
  }
  return `---\n${lines.join('\n')}\n---\n\n${content}`;
}

function frontmatterHasKey(content: string, key: string): boolean {
  if (!content.startsWith('---\n')) return false;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return false;
  return new RegExp(`^${escapeRegExp(key)}\\s*:`, 'm').test(content.slice(4, end));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function proposalForFile(root: string, file: string, now: Date): SourceFixProposal | undefined {
  const content = readFileSync(file, 'utf8');
  const fm = parseFrontmatter(content);
  const rel = relative(root, file).replace(/\\/g, '/');
  const agent = first(fm.source_agent, fm.agent) ?? inferAgent(rel, content);
  const updated = first(fm.source_updated_at, fm.last_reviewed, fm.updated, fm.created);
  const missing: string[] = [];
  if (!fm.source_agent && !fm.agent) missing.push('source_agent');
  if (!updated) missing.push('source_updated_at');
  if (missing.length === 0) return undefined;
  const evidence = evidenceFor(rel, content, agent);
  const inferredAgent = agent ?? 'unknown';
  const proposed: Record<string, string> = {};
  if (!fm.source_agent) proposed.source_agent = inferredAgent;
  if (!updated) proposed.source_updated_at = now.toISOString().slice(0, 10);
  if (!fm.source_origin) proposed.source_origin = inferOrigin(rel);
  if (!fm.confidence) proposed.confidence = confidenceFor(inferredAgent, evidence);
  if (!fm.status) proposed.status = 'active';
  return {
    path: rel,
    title: stripQuotes(fm.title) ?? basename(file),
    missing_fields: missing,
    confidence: proposed.confidence as 'low' | 'medium' | 'high',
    evidence,
    proposed_frontmatter: proposed,
    patch: renderPatch(rel, proposed, content),
  };
}

function renderPatch(path: string, additions: Record<string, string>, content: string): string {
  const lines = [`--- ${path}`, `+++ ${path}`, '@@ frontmatter @@'];
  if (content.startsWith('---\n')) {
    for (const [key, value] of Object.entries(additions)) lines.push(`+${key}: ${value}`);
  } else {
    lines.push('+---');
    for (const [key, value] of Object.entries(additions)) lines.push(`+${key}: ${value}`);
    lines.push('+---');
  }
  return lines.join('\n');
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/);
    if (match) out[match[1]] = stripQuotes(match[2]) ?? '';
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

const KNOWN_AGENT_NAMES = ['Hermes', 'Argos', 'Winston', 'Cato', 'Rogue', 'OOMOps'];

function inferAgent(rel: string, content: string): string | undefined {
  const path = rel.toLowerCase();
  for (const name of KNOWN_AGENT_NAMES) {
    const token = name.toLowerCase();
    if (path.split('/').some(part => part === token || part === `${token}.md` || part.includes(`-${token}-`) || part.startsWith(`${token}-`) || part.endsWith(`-${token}.md`))) return name;
  }
  const hay = content.slice(0, 400).toLowerCase();
  for (const name of KNOWN_AGENT_NAMES) {
    if (hay.includes(name.toLowerCase())) return name;
  }
  return undefined;
}

function inferOrigin(rel: string): string {
  if (rel.startsWith('knowledge/checkpoints/')) return 'fleet-checkpoint';
  if (rel.startsWith('knowledge/agent-fleet/')) return 'agent-fleet-roadmap';
  if (rel.startsWith('knowledge/agents/')) return 'agent-profile';
  return 'unknown';
}

function confidenceFor(agent: string, evidence: string[]): 'low' | 'medium' | 'high' {
  if (agent === 'unknown') return 'low';
  if (evidence.length >= 2) return 'medium';
  return 'low';
}

function evidenceFor(rel: string, content: string, agent?: string): string[] {
  const evidence: string[] = [];
  if (agent) evidence.push(`agent inferred as ${agent}`);
  if (/knowledge\/checkpoints\//.test(rel)) evidence.push('checkpoint path');
  if (/knowledge\/agent-fleet\//.test(rel)) evidence.push('agent-fleet path');
  if (/knowledge\/agents\//.test(rel)) evidence.push('agent profile path');
  if (/\bHermes|Argos|Winston|Cato|Rogue|OOMOps\b/.test(content)) evidence.push('agent named in content');
  return evidence;
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find(v => typeof v === 'string' && v.trim().length > 0);
}

function stripQuotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/^['"]|['"]$/g, '');
}
