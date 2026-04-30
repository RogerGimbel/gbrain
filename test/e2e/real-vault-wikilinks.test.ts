import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'fs';
import { join, relative } from 'path';
import { extractLinksFromFile } from '../../src/commands/extract.ts';
import { extractPageLinks } from '../../src/core/link-extraction.ts';
import { slugifyPath } from '../../src/core/sync.ts';

const VAULT_DIR = process.env.GBRAIN_REAL_VAULT || '/Users/rogergimbel/Knowledge/Winston';

function walkMarkdownFiles(dir: string): { path: string; relPath: string }[] {
  const files: { path: string; relPath: string }[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      try {
        const stat = lstatSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.endsWith('.md') && !entry.startsWith('_')) files.push({ path: full, relPath: relative(dir, full) });
      } catch {
        // Ignore unreadable files in the live vault fixture.
      }
    }
  }
  walk(dir);
  return files;
}

describe('real-vault wikilink quality', () => {
  test('resolves unique bare Obsidian wikilinks by basename without creating ambiguous phantom links', () => {
    if (!existsSync(VAULT_DIR)) return;

    const files = walkMarkdownFiles(VAULT_DIR);
    expect(files.length).toBeGreaterThan(100);
    const allSlugs = new Set(files.map(file => slugifyPath(file.relPath)));

    const dashboardRelPath = 'briefs/winston-operations-dashboard.md';
    const dashboard = readFileSync(join(VAULT_DIR, dashboardRelPath), 'utf-8');
    const dashboardLinks = extractLinksFromFile(dashboard, dashboardRelPath, allSlugs);

    expect(dashboardLinks.some(link => link.to_slug === 'welcome')).toBe(true);
    expect(dashboardLinks.some(link => link.to_slug === 'briefs/welcome')).toBe(false);

    const compatibilityRelPath = 'indexes/compatibility-and-alias-index.md';
    const compatibility = readFileSync(join(VAULT_DIR, compatibilityRelPath), 'utf-8');
    const compatibilityLinks = extractLinksFromFile(compatibility, compatibilityRelPath, allSlugs);

    expect(compatibilityLinks.some(link => link.to_slug === 'knowledge/projects/selfgrowth-knowledge-pilot/wiki/product-priorities')).toBe(true);
    expect(compatibilityLinks.some(link => link.to_slug === 'indexes/product-priorities')).toBe(false);

    // Ambiguous bare basename in the real vault should not be guessed.
    expect(compatibilityLinks.some(link => link.context.includes('[[Overview]]'))).toBe(false);
  });

  test('keeps explicit path wikilinks stable for canonical agent pages', () => {
    if (!existsSync(VAULT_DIR)) return;

    const files = walkMarkdownFiles(VAULT_DIR);
    const allSlugs = new Set(files.map(file => slugifyPath(file.relPath)));
    const agentsRelPath = 'AGENTS.md';
    const agents = readFileSync(join(VAULT_DIR, agentsRelPath), 'utf-8');
    const links = extractLinksFromFile(agents, agentsRelPath, allSlugs);
    const targets = new Set(links.map(link => link.to_slug));

    expect(targets.has('knowledge/agents/winston')).toBe(true);
    expect(targets.has('knowledge/agents/hermes')).toBe(true);
    expect(targets.has('knowledge/agents/gbrain')).toBe(true);
  });

  test('DB/auto-link extractor uses the same real-vault basename resolution when all slugs are available', () => {
    if (!existsSync(VAULT_DIR)) return;

    const files = walkMarkdownFiles(VAULT_DIR);
    const allSlugs = new Set(files.map(file => slugifyPath(file.relPath)));
    const dashboardRelPath = 'briefs/winston-operations-dashboard.md';
    const dashboard = readFileSync(join(VAULT_DIR, dashboardRelPath), 'utf-8');
    const candidates = extractPageLinks(dashboard, {}, 'concept' as any, slugifyPath(dashboardRelPath), allSlugs);

    expect(candidates.some(link => link.targetSlug === 'welcome')).toBe(true);
    expect(candidates.some(link => link.targetSlug === 'briefs/welcome')).toBe(false);
  });
});
