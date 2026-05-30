import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join, relative } from 'path';

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
