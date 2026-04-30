/**
 * Frontmatter inference — deterministic, audit-first metadata proposals.
 *
 * This local slice intentionally does not wire inference into import/sync and does
 * not write source files. It exists to evaluate whether upstream-style
 * zero-friction metadata inference is useful on Roger's real Obsidian vault
 * before any canonical frontmatter edits or live ingest behavior changes.
 */

import { basename } from 'path';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

export interface InferredFrontmatter {
  title: string;
  type: string;
  date?: string;
  source?: string;
  tags?: string[];
  skipped?: boolean;
  matchedRule?: string;
}

export interface DirectoryRule {
  pathPrefix: string;
  type: string;
  source?: string;
  tags?: string[];
  datePattern?: 'filename' | 'none';
  titleStrategy?: 'filename' | 'heading' | 'filename-full';
}

export interface FrontmatterAuditProposal {
  relativePath: string;
  inferred: InferredFrontmatter;
  generatedFrontmatter: string;
}

export interface FrontmatterAuditReport {
  root: string;
  generatedAt: string;
  summary: {
    totalMarkdown: number;
    missingFrontmatter: number;
    existingFrontmatter: number;
    byType: Record<string, number>;
    byRule: Record<string, number>;
  };
  proposals: FrontmatterAuditProposal[];
}

// Ordered most-specific first. Local Roger/Winston vault conventions precede
// upstream generic conventions. Audit-only: these are proposals, not writes.
export const DIRECTORY_RULES: DirectoryRule[] = [
  { pathPrefix: 'projects/control/project-status/', type: 'project-status', tags: ['project-status'], titleStrategy: 'heading' },
  { pathPrefix: 'projects/control/infrastructure-status/', type: 'infra-status', tags: ['infra-status'], titleStrategy: 'heading' },
  { pathPrefix: 'projects/control/', type: 'project', tags: ['control'], titleStrategy: 'heading' },
  { pathPrefix: 'knowledge/people/', type: 'people-profile', tags: ['people'], titleStrategy: 'heading' },
  { pathPrefix: 'knowledge/agents/', type: 'agent-profile', tags: ['agent'], titleStrategy: 'heading' },
  { pathPrefix: 'knowledge/companies/', type: 'company-summary', tags: ['company'], titleStrategy: 'heading' },
  { pathPrefix: 'knowledge/infrastructure/', type: 'infrastructure-summary', tags: ['infrastructure'], titleStrategy: 'heading' },
  { pathPrefix: 'knowledge/projects/', type: 'project-summary', tags: ['project'], titleStrategy: 'heading' },
  { pathPrefix: 'knowledge/services/', type: 'service-profile', tags: ['service'], titleStrategy: 'heading' },
  { pathPrefix: 'briefs/', type: 'checkpoint', tags: ['brief'], datePattern: 'filename', titleStrategy: 'heading' },
  { pathPrefix: 'subconscious/', type: 'source', source: 'subconscious', tags: ['subconscious'], datePattern: 'filename', titleStrategy: 'heading' },
  { pathPrefix: 'claude-memory/', type: 'source', source: 'claude-memory', tags: ['claude-memory'], titleStrategy: 'heading' },
  { pathPrefix: 'memory-archive-', type: 'source', source: 'memory-archive', tags: ['memory-archive'], datePattern: 'filename', titleStrategy: 'heading' },
  { pathPrefix: 'clippings/', type: 'source', source: 'clippings', tags: ['clipping'], titleStrategy: 'heading' },
  { pathPrefix: 'sources/', type: 'source', source: 'sources', tags: ['source'], titleStrategy: 'heading' },
  { pathPrefix: 'templates/', type: 'reference', tags: ['template'], titleStrategy: 'heading' },
  { pathPrefix: 'research/', type: 'reference', tags: ['research'], titleStrategy: 'heading' },
  { pathPrefix: 'indexes/', type: 'reference', tags: ['index'], titleStrategy: 'heading' },

  // Upstream-style generic conventions retained for staging against imported corpora.
  { pathPrefix: 'apple notes/youtube shows/', type: 'apple-note', source: 'apple-notes', tags: ['youtube', 'shows'], datePattern: 'filename', titleStrategy: 'filename' },
  { pathPrefix: 'apple notes/yc/', type: 'apple-note', source: 'apple-notes', tags: ['yc'], datePattern: 'filename', titleStrategy: 'filename' },
  { pathPrefix: 'apple notes/archived/', type: 'apple-note', source: 'apple-notes', tags: ['archived'], datePattern: 'filename', titleStrategy: 'filename' },
  { pathPrefix: 'apple notes/politics/', type: 'apple-note', source: 'apple-notes', tags: ['politics'], datePattern: 'filename', titleStrategy: 'filename' },
  { pathPrefix: 'apple notes/', type: 'apple-note', source: 'apple-notes', datePattern: 'filename', titleStrategy: 'filename' },
  { pathPrefix: 'daily/calendar/', type: 'calendar-index', source: 'calendar', datePattern: 'filename', titleStrategy: 'filename' },
  { pathPrefix: 'people/', type: 'person', titleStrategy: 'heading' },
  { pathPrefix: 'companies/', type: 'company', titleStrategy: 'heading' },
  { pathPrefix: 'projects/', type: 'project', titleStrategy: 'heading' },
  { pathPrefix: 'events/', type: 'event', titleStrategy: 'heading', datePattern: 'filename' },
  { pathPrefix: 'meetings/', type: 'meeting', titleStrategy: 'heading', datePattern: 'filename' },
  { pathPrefix: 'media/', type: 'media', titleStrategy: 'heading' },
  { pathPrefix: '', type: 'concept', titleStrategy: 'heading' },
];

export function hasYamlFrontmatter(content: string): boolean {
  const firstNonEmpty = content.split('\n').find(line => line.trim().length > 0);
  return firstNonEmpty?.trim() === '---';
}

export function extractDateFromFilename(filename: string): string | null {
  const iso = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  const spaced = filename.match(/^(\d{4})\s+(\d{2})\s+(\d{2})\s/);
  if (spaced) return `${spaced[1]}-${spaced[2]}-${spaced[3]}`;

  return null;
}

export function extractTitleFromFilename(filename: string): string {
  let title = filename.replace(/\.md$/i, '');
  title = title.replace(/^\d{4}-\d{2}-\d{2}[\s_-]+/, '');
  title = title.replace(/^\d{4}\s+\d{2}\s+\d{2}\s+/, '');
  title = title.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

  if (title === title.toLowerCase() || title === title.toUpperCase()) {
    title = title.replace(/\b\w/g, char => char.toUpperCase());
  }

  return title || 'Untitled';
}

export function extractTitleFromHeading(content: string): string | null {
  for (const line of content.split('\n').slice(0, 20)) {
    const match = line.match(/^#\s+(.+)/);
    if (match) return match[1].trim();
  }
  return null;
}

export function inferFrontmatter(relativePath: string, content: string): InferredFrontmatter {
  if (hasYamlFrontmatter(content)) {
    return { title: '', type: '', skipped: true };
  }

  const normalizedPath = relativePath.replace(/\\/g, '/');
  const lowerPath = normalizedPath.toLowerCase();
  const filename = basename(normalizedPath);
  const rule = DIRECTORY_RULES.find(candidate => lowerPath.startsWith(candidate.pathPrefix.toLowerCase()))
    ?? DIRECTORY_RULES[DIRECTORY_RULES.length - 1];

  const date = (rule.datePattern ?? 'filename') === 'filename'
    ? extractDateFromFilename(filename) ?? undefined
    : undefined;

  let title: string;
  const strategy = rule.titleStrategy ?? 'filename';
  if (strategy === 'heading') {
    title = extractTitleFromHeading(content) ?? extractTitleFromFilename(filename);
  } else if (strategy === 'filename-full') {
    title = filename.replace(/\.md$/i, '').replace(/[-_]/g, ' ').trim() || 'Untitled';
  } else {
    title = extractTitleFromFilename(filename);
  }

  return {
    title,
    type: rule.type,
    date,
    source: rule.source,
    tags: rule.tags?.length ? [...rule.tags] : undefined,
    skipped: false,
    matchedRule: rule.pathPrefix || '(default)',
  };
}

export function serializeFrontmatter(fm: InferredFrontmatter): string {
  if (fm.skipped) return '';

  const lines = ['---'];
  lines.push(`title: ${formatYamlScalar(fm.title)}`);
  lines.push(`type: ${fm.type}`);
  if (fm.date) lines.push(`date: ${JSON.stringify(fm.date)}`);
  if (fm.source) lines.push(`source: ${formatYamlScalar(fm.source)}`);
  if (fm.tags?.length) lines.push(`tags: [${fm.tags.map(tag => JSON.stringify(tag)).join(', ')}]`);
  lines.push('---');
  return lines.join('\n') + '\n';
}

export function applyInference(relativePath: string, content: string): { content: string; inferred: InferredFrontmatter } {
  const inferred = inferFrontmatter(relativePath, content);
  if (inferred.skipped) return { content, inferred };
  return { content: `${serializeFrontmatter(inferred)}\n${content}`, inferred };
}

export function auditFrontmatterDirectory(root: string): FrontmatterAuditReport {
  const proposals: FrontmatterAuditProposal[] = [];
  let totalMarkdown = 0;
  let existingFrontmatter = 0;
  const byType: Record<string, number> = {};
  const byRule: Record<string, number> = {};

  for (const filePath of listMarkdownFiles(root)) {
    totalMarkdown++;
    const relativePath = relative(root, filePath).replace(/\\/g, '/');
    const content = readFileSync(filePath, 'utf-8');
    const inferred = inferFrontmatter(relativePath, content);
    if (inferred.skipped) {
      existingFrontmatter++;
      continue;
    }

    byType[inferred.type] = (byType[inferred.type] ?? 0) + 1;
    const rule = inferred.matchedRule ?? '(unknown)';
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    proposals.push({
      relativePath,
      inferred,
      generatedFrontmatter: serializeFrontmatter(inferred),
    });
  }

  proposals.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    root,
    generatedAt: new Date().toISOString(),
    summary: {
      totalMarkdown,
      missingFrontmatter: proposals.length,
      existingFrontmatter,
      byType: sortRecord(byType),
      byRule: sortRecord(byRule),
    },
    proposals,
  };
}

function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, out);
  out.sort();
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry === '.obsidian') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

function formatYamlScalar(value: string): string {
  return JSON.stringify(value ?? '');
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
