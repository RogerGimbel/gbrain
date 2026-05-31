import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateSourceFixProposals, renderSourceFixProposalMarkdown } from '../src/core/source-fix-proposals.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-source-fix-'));
}

describe('source metadata fix proposals', () => {
  test('generates reviewable frontmatter proposals for missing source metadata without mutating files', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    const note = join(dir, 'hermes-routing.md');
    writeFileSync(note, ['---', 'title: Hermes Routing', 'type: note', '---', '# Hermes Routing'].join('\n'), 'utf8');
    const before = readFileSync(note, 'utf8');
    const output = join(root, 'proposals');

    const report = generateSourceFixProposals({ root, outputRoot: output, now: new Date('2026-05-30T12:00:00Z') });

    expect(report.summary.total_proposals).toBe(1);
    expect(report.proposals[0].path).toBe('knowledge/agent-fleet/hermes-routing.md');
    expect(report.proposals[0].confidence).toBe('medium');
    expect(report.proposals[0].proposed_frontmatter.source_agent).toBe('Hermes');
    expect(report.proposals[0].proposed_frontmatter.source_updated_at).toBe('2026-05-30');
    expect(report.proposals[0].patch).toContain('+source_agent: Hermes');
    expect(readFileSync(note, 'utf8')).toBe(before);
    expect(existsSync(join(output, 'source-fix-proposals.json'))).toBe(true);
    expect(existsSync(join(output, 'source-fix-proposals.md'))).toBe(true);
    expect(report.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 });
  });

  test('skips files that already have required source metadata', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hermes.md'), [
      '---',
      'title: Hermes',
      'source_agent: Hermes',
      'source_updated_at: 2026-05-30',
      '---',
      '# Hermes',
    ].join('\n'), 'utf8');

    const report = generateSourceFixProposals({ root, dryRun: true });

    expect(report.summary.total_proposals).toBe(0);
    expect(report.proposals).toEqual([]);
  });

  test('renders markdown with explicit review/apply warning', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/checkpoints/dev/foo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-05-30-argos.md'), '# Argos checkpoint', 'utf8');

    const report = generateSourceFixProposals({ root, dryRun: true, now: new Date('2026-05-30T12:00:00Z') });
    const markdown = renderSourceFixProposalMarkdown(report);

    expect(markdown).toContain('# Source Metadata Fix Proposals');
    expect(markdown).toContain('review-only');
    expect(markdown).toContain('source_agent: Argos');
  });

  test('prioritizes explicit agent path segments over incidental agent mentions in content', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet/adapters');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'argos.md'), '# Argos Adapter\n\nHermes can route work to Argos.', 'utf8');
    writeFileSync(join(dir, 'rogue.md'), '# Rogue Adapter\n\nHermes tracks Rogue status.', 'utf8');

    const report = generateSourceFixProposals({ root, dryRun: true, now: new Date('2026-05-30T12:00:00Z') });

    expect(report.proposals.find(p => p.path.endsWith('adapters/argos.md'))?.proposed_frontmatter.source_agent).toBe('Argos');
    expect(report.proposals.find(p => p.path.endsWith('adapters/rogue.md'))?.proposed_frontmatter.source_agent).toBe('Rogue');
  });

  test('treats explicit agent frontmatter as high-confidence source ownership without adding semantic status', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'argos-web-provider-decision.md'), [
      '---',
      'title: Argos Web Provider Decision',
      'agent: Hermes',
      '---',
      '# Argos Web Provider Decision',
    ].join('\n'), 'utf8');

    const report = generateSourceFixProposals({ root, dryRun: true, now: new Date('2026-05-30T12:00:00Z') });
    const proposal = report.proposals[0];

    expect(proposal.proposed_frontmatter.source_agent).toBe('Hermes');
    expect(proposal.confidence).toBe('high');
    expect(proposal.evidence).toContain('explicit agent frontmatter: Hermes');
    expect(proposal.proposed_frontmatter.status).toBeUndefined();
  });

  test('does not promote fleet-wide common docs from incidental content mentions', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet/common');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'checkpoint-contract.md'), [
      '---',
      'title: Agent Fleet Durable Checkpoint Contract',
      '---',
      '# Agent Fleet Durable Checkpoint Contract',
      'Roger agents include Hermes, Argos, Rogue, Winston, and Cato.',
    ].join('\n'), 'utf8');

    const report = generateSourceFixProposals({ root, dryRun: true, now: new Date('2026-05-30T12:00:00Z') });
    const proposal = report.proposals[0];

    expect(proposal.proposed_frontmatter.source_agent).toBe('unknown');
    expect(proposal.confidence).toBe('low');
    expect(proposal.evidence).toContain('fleet-wide common path requires manual source-agent review');
  });

  test('does not infer one owner for multi-agent filenames without explicit frontmatter', () => {
    const root = tmp();
    const dir = join(root, 'knowledge/agent-fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cato-winston-parity-caveat-readonly-audit.md'), [
      '---',
      'title: Cato/Winston Fleet Parity Caveat Read-only Audit',
      '---',
      '# Cato/Winston Fleet Parity Caveat Read-only Audit',
      'Cato and Winston both need GBrain parity checks.',
    ].join('\n'), 'utf8');

    const report = generateSourceFixProposals({ root, dryRun: true, now: new Date('2026-05-30T12:00:00Z') });
    const proposal = report.proposals[0];

    expect(proposal.proposed_frontmatter.source_agent).toBe('unknown');
    expect(proposal.confidence).toBe('low');
    expect(proposal.evidence).toContain('multiple agents in path require manual source-agent review: Winston, Cato');
  });
});
