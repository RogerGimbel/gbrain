import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applySourceFixProposals, type SourceFixProposalReport } from '../src/core/source-fix-proposals.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-source-fix-apply-'));
}

function writeReport(root: string, report: Partial<SourceFixProposalReport>): string {
  const path = join(root, 'source-fix-proposals.json');
  writeFileSync(path, JSON.stringify({
    generated_at: '2026-05-30T12:00:00Z',
    root,
    summary: { files_scanned: 0, total_proposals: 0, high_confidence: 0, medium_confidence: 0, low_confidence: 0 },
    proposals: [],
    sideEffects: { canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 },
    ...report,
  }, null, 2), 'utf8');
  return path;
}

describe('source metadata fix apply lane', () => {
  test('dry-run selects eligible medium confidence non-unknown proposals without mutating files', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    const note = join(dir, 'hermes-routing.md');
    const second = join(dir, 'argos-routing.md');
    writeFileSync(note, ['---', 'title: Hermes Routing', '---', '# Hermes Routing'].join('\n'), 'utf8');
    writeFileSync(second, '# Argos Routing', 'utf8');
    const before = readFileSync(note, 'utf8');
    const secondBefore = readFileSync(second, 'utf8');
    const reportPath = writeReport(root, {
      proposals: [
        {
          path: 'knowledge/agent-fleet/hermes-routing.md',
          title: 'Hermes Routing',
          missing_fields: ['source_agent', 'source_updated_at'],
          confidence: 'medium',
          evidence: ['agent inferred as Hermes', 'agent-fleet path'],
          proposed_frontmatter: { source_agent: 'Hermes', source_updated_at: '2026-05-30', source_origin: 'agent-fleet-roadmap', confidence: 'medium' },
          patch: '',
        },
        {
          path: 'knowledge/agent-fleet/argos-routing.md',
          title: 'Argos Routing',
          missing_fields: ['source_agent', 'source_updated_at'],
          confidence: 'medium',
          evidence: ['agent inferred as Argos', 'agent-fleet path'],
          proposed_frontmatter: { source_agent: 'Argos', source_updated_at: '2026-05-30', source_origin: 'agent-fleet-roadmap', confidence: 'medium' },
          patch: '',
        },
      ],
    });

    const receipt = applySourceFixProposals({ reportPath, root, dryRun: true, minConfidence: 'medium', excludeUnknown: true, limit: 1 });

    expect(receipt.summary.eligible).toBe(1);
    expect(receipt.summary.skipped).toBe(1);
    expect(receipt.summary.applied).toBe(0);
    expect(receipt.items[0].status).toBe('eligible');
    expect(receipt.items[1].status).toBe('skipped');
    expect(receipt.items[1].reasons.join('\n')).toMatch(/limit 1 reached/);
    expect(readFileSync(note, 'utf8')).toBe(before);
    expect(readFileSync(second, 'utf8')).toBe(secondBefore);
    expect(receipt.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 });
  });

  test('apply writes only a limited eligible batch and emits a receipt', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    const first = join(dir, 'hermes-routing.md');
    const second = join(dir, 'unknown-contract.md');
    writeFileSync(first, '# Hermes Routing', 'utf8');
    writeFileSync(second, '# Fleet Contract', 'utf8');
    const output = join(root, 'apply-output');
    const reportPath = writeReport(root, {
      proposals: [
        {
          path: 'knowledge/agent-fleet/hermes-routing.md',
          title: 'Hermes Routing',
          missing_fields: ['source_agent', 'source_updated_at'],
          confidence: 'medium',
          evidence: ['agent inferred as Hermes', 'agent-fleet path'],
          proposed_frontmatter: { source_agent: 'Hermes', source_updated_at: '2026-05-30', source_origin: 'agent-fleet-roadmap', confidence: 'medium' },
          patch: '',
        },
        {
          path: 'knowledge/agent-fleet/unknown-contract.md',
          title: 'Fleet Contract',
          missing_fields: ['source_agent', 'source_updated_at'],
          confidence: 'low',
          evidence: ['agent-fleet path'],
          proposed_frontmatter: { source_agent: 'unknown', source_updated_at: '2026-05-30', source_origin: 'agent-fleet-roadmap', confidence: 'low' },
          patch: '',
        },
      ],
    });

    const receipt = applySourceFixProposals({ reportPath, root, outputRoot: output, apply: true, minConfidence: 'medium', excludeUnknown: true, limit: 1 });

    expect(receipt.summary.applied).toBe(1);
    expect(receipt.summary.skipped).toBe(1);
    expect(receipt.sideEffects.canonicalVaultWrites).toBe(1);
    expect(readFileSync(first, 'utf8')).toContain('source_agent: Hermes');
    expect(readFileSync(first, 'utf8')).toContain('source_updated_at: 2026-05-30');
    expect(readFileSync(second, 'utf8')).not.toContain('source_agent: unknown');
    expect(existsSync(join(output, 'source-fix-apply-receipt.json'))).toBe(true);
    expect(existsSync(join(output, 'source-fix-apply-receipt.md'))).toBe(true);
  });

  test('blocks proposal paths that escape the reviewed root', () => {
    const root = tmp();
    const reportPath = writeReport(root, {
      proposals: [{
        path: '../outside.md',
        title: 'Outside',
        missing_fields: ['source_agent'],
        confidence: 'medium',
        evidence: [],
        proposed_frontmatter: { source_agent: 'Hermes' },
        patch: '',
      }],
    });

    const receipt = applySourceFixProposals({ reportPath, root, dryRun: true, minConfidence: 'medium' });

    expect(receipt.summary.blocked).toBe(1);
    expect(receipt.items[0].status).toBe('blocked');
    expect(receipt.items[0].reasons.join('\n')).toMatch(/escapes root/i);
  });
});
