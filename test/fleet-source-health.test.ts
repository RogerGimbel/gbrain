import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { analyzeFleetSources, renderSourceHealthMarkdown } from '../src/core/fleet-source.ts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-source-health-'));
}

describe('fleet source health', () => {
  test('extracts source metadata from fleet checkpoint frontmatter', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'knowledge/checkpoints/dev/rodaco'), { recursive: true });
    writeFileSync(join(root, 'knowledge/checkpoints/dev/rodaco/cato.md'), `---\ntitle: Cato Rodaco Deploy Checkpoint\nagent: Cato\nsource_profile: cato\nsource_origin: telegram\nsource_id: cato:telegram:42\nsource_updated_at: 2026-05-30T17:00:00Z\nconfidence: high\n---\n# Cato Rodaco Deploy Checkpoint\n`);

    const report = analyzeFleetSources(root, { now: new Date('2026-05-30T18:00:00Z'), staleAfterDays: 7 });

    expect(report.summary.total_files).toBe(1);
    expect(report.summary.source_covered).toBe(1);
    expect(report.summary.missing_source_metadata).toBe(0);
    expect(report.summary.stale_sources).toBe(0);
    expect(report.sources[0].agent).toBe('Cato');
    expect(report.sources[0].profile).toBe('cato');
    expect(report.by_agent.Cato.files).toBe(1);
  });

  test('flags fleet docs missing source metadata and stale timestamps', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'knowledge/agent-fleet'), { recursive: true });
    writeFileSync(join(root, 'knowledge/agent-fleet/roadmap.md'), `---\ntitle: Roadmap\n---\n# Roadmap\n`);
    writeFileSync(join(root, 'knowledge/agent-fleet/hermes.md'), `---\ntitle: Hermes Old Note\nsource_agent: Hermes\nsource_updated_at: 2026-05-01\n---\n# Old\n`);

    const report = analyzeFleetSources(root, { now: new Date('2026-05-30T00:00:00Z'), staleAfterDays: 14 });

    expect(report.summary.total_files).toBe(2);
    expect(report.summary.missing_source_metadata).toBe(1);
    expect(report.summary.stale_sources).toBe(1);
    expect(report.missing[0].path).toContain('roadmap.md');
    expect(report.stale[0].agent).toBe('Hermes');
  });

  test('renders compact markdown for checkpoint readback', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'knowledge/agent-fleet'), { recursive: true });
    writeFileSync(join(root, 'knowledge/agent-fleet/argos.md'), `---\ntitle: Argos Release Watch\nsource_agent: Argos\nsource_profile: argos\nsource_updated_at: 2026-05-30\n---\n# Argos\n`);
    const report = analyzeFleetSources(root, { now: new Date('2026-05-30T00:00:00Z') });
    const markdown = renderSourceHealthMarkdown(report);
    expect(markdown).toContain('Source Health');
    expect(markdown).toContain('Argos');
    expect(markdown).toContain('missing source metadata: 0');
  });
});
