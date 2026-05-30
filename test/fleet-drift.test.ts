import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { analyzeFleetDrift, renderFleetDriftMarkdown } from '../src/core/fleet-drift.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-fleet-drift-'));
}

describe('fleet drift detector', () => {
  test('reports stale source metadata, conflicting claims, dead refs, and superseded checkpoints without writes', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hermes-old.md'), [
      '---',
      'title: Hermes old status',
      'source_agent: Hermes',
      'source_updated_at: 2026-04-01',
      '---',
      'Hermes status: blocked',
      'File ref: /tmp/definitely-missing-gbrain-file',
    ].join('\n'), 'utf8');
    writeFileSync(join(dir, 'hermes-new.md'), [
      '---',
      'title: Hermes new status',
      'source_agent: Hermes',
      'source_updated_at: 2026-05-30',
      '---',
      'Hermes status: healthy',
    ].join('\n'), 'utf8');
    const cp = join(root, 'knowledge/checkpoints/dev/gbrain');
    mkdirSync(cp, { recursive: true });
    writeFileSync(join(cp, '2026-05-01-phase.md'), 'status: phase-1-complete', 'utf8');
    writeFileSync(join(cp, '2026-05-30-phase.md'), 'status: phase-2-complete', 'utf8');

    const output = join(root, 'reports');
    const report = analyzeFleetDrift({ root, outputRoot: output, now: new Date('2026-05-30T12:00:00Z'), staleAfterDays: 14 });

    expect(report.summary.total_findings).toBeGreaterThanOrEqual(4);
    expect(report.findings.some(f => f.kind === 'stale-source')).toBe(true);
    expect(report.findings.some(f => f.kind === 'conflict')).toBe(true);
    expect(report.findings.some(f => f.kind === 'dead-reference')).toBe(true);
    expect(report.findings.some(f => f.kind === 'superseded-checkpoint')).toBe(true);
    expect(existsSync(join(output, 'fleet-drift.json'))).toBe(true);
    expect(existsSync(join(output, 'fleet-drift.md'))).toBe(true);
    expect(report.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, deletes: 0 });
  });

  test('renders evidence-first markdown', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cato.md'), 'Cato status: degraded', 'utf8');
    writeFileSync(join(dir, 'cato2.md'), 'Cato status: healthy', 'utf8');

    const report = analyzeFleetDrift({ root, dryRun: true });
    const markdown = renderFleetDriftMarkdown(report);

    expect(markdown).toContain('# Fleet Drift Report');
    expect(markdown).toContain('evidence');
    expect(markdown).toContain('conflict');
  });
});
