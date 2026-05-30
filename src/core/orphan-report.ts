import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from './engine.ts';
import type { Link, Page } from './types.ts';

export interface OrphanRecord {
  slug: string;
  title: string;
  type: string;
  group: string;
}

export interface OrphanGroup {
  count: number;
  slugs: string[];
}

export interface OrphanReport {
  schema_version: 1;
  generated_at: string;
  summary: {
    total_pages: number;
    orphan_pages: number;
    linked_pages: number;
    groups: number;
  };
  groups: Record<string, OrphanGroup>;
  orphans: OrphanRecord[];
}

export type OrphanEngine = Pick<BrainEngine, 'listPages' | 'getLinks' | 'getBacklinks'>;

export async function buildOrphanReport(engine: OrphanEngine): Promise<OrphanReport> {
  const pages = await listAllPages(engine);
  const orphans: OrphanRecord[] = [];
  for (const page of pages) {
    const [links, backlinks] = await Promise.all([engine.getLinks(page.slug), engine.getBacklinks(page.slug)]);
    if (isOrphan(links, backlinks)) {
      orphans.push({
        slug: page.slug,
        title: page.title || page.slug,
        type: String(page.type || 'note'),
        group: groupForPage(page),
      });
    }
  }
  const groups: Record<string, OrphanGroup> = {};
  for (const orphan of orphans) {
    const group = groups[orphan.group] ?? { count: 0, slugs: [] };
    group.count += 1;
    group.slugs.push(orphan.slug);
    groups[orphan.group] = group;
  }
  for (const group of Object.values(groups)) group.slugs.sort();
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    summary: {
      total_pages: pages.length,
      orphan_pages: orphans.length,
      linked_pages: pages.length - orphans.length,
      groups: Object.keys(groups).length,
    },
    groups,
    orphans: orphans.sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

export function renderOrphanReportMarkdown(report: OrphanReport): string {
  const lines = [
    '# Graph Orphan Report',
    '',
    `- generated: ${report.generated_at}`,
    `- total pages: ${report.summary.total_pages}`,
    `- orphan pages: ${report.summary.orphan_pages}`,
    `- linked pages: ${report.summary.linked_pages}`,
    `- groups: ${report.summary.groups}`,
    '',
    '## Groups',
    '',
  ];
  for (const [name, group] of Object.entries(report.groups).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`- ${name}: ${group.count}`);
  }
  lines.push('', '## Orphans', '');
  for (const orphan of report.orphans.slice(0, 250)) {
    lines.push(`- ${orphan.slug} (${orphan.type}) — ${orphan.title}`);
  }
  return lines.join('\n') + '\n';
}

export function renderOrphanIndexMarkdown(report: OrphanReport, opts: { title?: string } = {}): string {
  const title = opts.title ?? 'GBrain Graph Orphan Index';
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'type: graph-orphan-index',
    'source_agent: GBrain',
    'source_origin: orphan-report',
    `source_updated_at: ${report.generated_at}`,
    'confidence: high',
    '---',
    '',
    `# ${title}`,
    '',
    'Purpose: provide explicit, reviewable graph links to orphan pages without bulk rewriting the orphan pages themselves.',
    '',
  ];
  for (const [name, group] of Object.entries(report.groups).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`## ${name}`);
    lines.push('');
    for (const slug of group.slugs) {
      const orphan = report.orphans.find(o => o.slug === slug);
      lines.push(`- [[${slug}|${orphan?.title ?? slug}]]`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function writeOrphanReport(report: OrphanReport, outputDir: string, opts: { writeIndex?: boolean } = {}): { json: string; markdown: string; index?: string } {
  mkdirSync(outputDir, { recursive: true });
  const json = join(outputDir, 'graph-orphan-report.json');
  const markdown = join(outputDir, 'graph-orphan-report.md');
  writeFileSync(json, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(markdown, renderOrphanReportMarkdown(report), 'utf8');
  let index: string | undefined;
  if (opts.writeIndex) {
    index = join(outputDir, 'graph-orphan-index.md');
    writeFileSync(index, renderOrphanIndexMarkdown(report), 'utf8');
  }
  return { json, markdown, index };
}

function isOrphan(links: Link[], backlinks: Link[]): boolean {
  return links.length === 0 && backlinks.length === 0;
}

async function listAllPages(engine: OrphanEngine): Promise<Page[]> {
  const pageSize = 500;
  const out: Page[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await engine.listPages({ limit: pageSize, offset } as any);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

function groupForPage(page: Page): string {
  const parts = page.slug.split('/').filter(Boolean);
  if (parts[0] === 'knowledge' && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  if (parts.length >= 1) return parts[0]!;
  return String(page.type || 'ungrouped');
}
