/**
 * Frontmatter inference audit tests.
 *
 * This slice is audit-only: infer metadata for files without YAML frontmatter,
 * report proposed changes, and never mutate the source vault.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  auditFrontmatterDirectory,
  inferFrontmatter,
  serializeFrontmatter,
} from '../src/core/frontmatter-inference.ts';

describe('frontmatter inference audit', () => {
  test('infers Roger-local project status metadata from path and heading', () => {
    const inferred = inferFrontmatter(
      'projects/control/project-status/example-app.md',
      '# Example App Status\n\nCurrent state.',
    );

    expect(inferred.skipped).toBe(false);
    expect(inferred.type).toBe('project-status');
    expect(inferred.title).toBe('Example App Status');
    expect(inferred.tags).toContain('project-status');
    expect(inferred.matchedRule).toBe('projects/control/project-status/');
  });

  test('skips files that already have frontmatter', () => {
    const inferred = inferFrontmatter(
      'knowledge/agents/hermes.md',
      '---\ntype: agent-profile\ntitle: Hermes Agent\n---\n# Hermes Agent',
    );

    expect(inferred.skipped).toBe(true);
  });

  test('serializes inferred metadata without slug or write-side effects', () => {
    const yaml = serializeFrontmatter({
      title: 'Title: With Colon',
      type: 'concept',
      tags: ['frontmatter-audit'],
      matchedRule: '(default)',
    });

    expect(yaml).toContain('title: "Title: With Colon"');
    expect(yaml).toContain('type: concept');
    expect(yaml).toContain('tags: ["frontmatter-audit"]');
    expect(yaml).not.toContain('matchedRule');
    expect(yaml).not.toContain('slug:');
  });

  test('quotes date-like titles so YAML parsers keep them as strings', () => {
    const inferred = inferFrontmatter('memory-archive-2026-Q1/2026-01-29.md', '# 2026-01-29\n\nBody.');

    const yaml = serializeFrontmatter(inferred);

    expect(yaml).toContain('title: "2026-01-29"');
  });

  test('audits a directory without modifying source files', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-frontmatter-audit-'));
    const missingPath = join(root, 'projects/control/project-status/example-app.md');
    const existingPath = join(root, 'knowledge/agents/hermes.md');
    mkdirSync(dirname(missingPath), { recursive: true });
    mkdirSync(dirname(existingPath), { recursive: true });
    writeFileSync(missingPath, '# Example App Status\n\nCurrent state.');
    writeFileSync(existingPath, '---\ntype: agent-profile\ntitle: Hermes Agent\n---\n# Hermes Agent');

    const before = readFileSync(missingPath, 'utf-8');
    const report = auditFrontmatterDirectory(root);
    const after = readFileSync(missingPath, 'utf-8');

    expect(after).toBe(before);
    expect(report.summary.totalMarkdown).toBe(2);
    expect(report.summary.missingFrontmatter).toBe(1);
    expect(report.summary.existingFrontmatter).toBe(1);
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0].relativePath).toBe('projects/control/project-status/example-app.md');
    expect(report.proposals[0].inferred.type).toBe('project-status');
    expect(report.summary.byType['project-status']).toBe(1);
  });
});
