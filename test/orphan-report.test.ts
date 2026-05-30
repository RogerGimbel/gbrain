import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildOrphanReport, renderOrphanIndexMarkdown, writeOrphanReport } from '../src/core/orphan-report.ts';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'gbrain-orphan-report-')); }

describe('orphan report', () => {
  test('groups pages with no incoming or outgoing graph links', async () => {
    const pages = [
      { slug: 'knowledge/agents/hermes', title: 'Hermes', type: 'agent-profile' },
      { slug: 'knowledge/agent-fleet/plan', title: 'Plan', type: 'project-plan' },
      { slug: 'random/note', title: 'Random', type: 'note' },
    ];
    const report = await buildOrphanReport({
      listPages: async () => pages as any,
      getLinks: async slug => slug === 'knowledge/agent-fleet/plan' ? [{ to_slug: 'knowledge/agents/hermes' }] as any : [],
      getBacklinks: async slug => slug === 'knowledge/agents/hermes' ? [{ from_slug: 'knowledge/agent-fleet/plan' }] as any : [],
    });

    expect(report.summary.total_pages).toBe(3);
    expect(report.summary.orphan_pages).toBe(1);
    expect(report.orphans[0].slug).toBe('random/note');
    expect(report.groups['random'].count).toBe(1);
  });

  test('renders an index page that links orphan slugs for safe repair', async () => {
    const report = await buildOrphanReport({
      listPages: async () => [{ slug: 'knowledge/projects/alpha', title: 'Alpha', type: 'project' }] as any,
      getLinks: async () => [],
      getBacklinks: async () => [],
    });
    const markdown = renderOrphanIndexMarkdown(report, { title: 'Fleet Orphan Index' });
    expect(markdown).toContain('Fleet Orphan Index');
    expect(markdown).toContain('[[knowledge/projects/alpha|Alpha]]');

    const out = writeOrphanReport(report, tmp(), { writeIndex: true });
    expect(existsSync(out.json)).toBe(true);
    expect(existsSync(out.markdown)).toBe(true);
    expect(existsSync(out.index!)).toBe(true);
    expect(readFileSync(out.index!, 'utf8')).toContain('graph-orphan-index');
  });
});
