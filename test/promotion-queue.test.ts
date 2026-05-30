import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scanPromotionQueue, renderPromotionQueueMarkdown } from '../src/core/promotion-queue.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-promotion-queue-'));
}

describe('promotion queue', () => {
  test('scans sandbox artifacts into deterministic promotion manifests without canonical writes', () => {
    const root = tmp();
    const input = join(root, 'experiments');
    const output = join(root, 'queue');
    const artifact = join(input, 'session-packet.md');
    mkdirSync(input, { recursive: true });
    writeFileSync(artifact, [
      '---',
      'title: Session Packet — Hermes',
      'type: session-packet',
      'status: sandbox-only',
      'source_agent: Hermes',
      'source_origin: telegram',
      'source_id: hermes:telegram:123',
      '---',
      '# Session Packet',
      '## Decisions',
      '- Keep writes gated.',
    ].join('\n'), 'utf8');

    const result = scanPromotionQueue({ inputRoot: input, outputRoot: output });

    expect(result.summary.total_items).toBe(1);
    expect(result.summary.ready_items).toBe(1);
    expect(result.items[0].artifact_class).toBe('session-packet');
    expect(result.items[0].risk).toBe('medium');
    expect(result.items[0].checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.items[0].suggested_target).toBe('knowledge/session-packets/');
    expect(result.sideEffects).toEqual({ liveDbWrites: 0, canonicalVaultWrites: 0, liveSync: 0 });
    expect(existsSync(join(output, 'promotion-queue.json'))).toBe(true);
    expect(existsSync(join(output, 'promotion-queue.md'))).toBe(true);
  });

  test('blocks raw transcripts and secret-looking artifacts', () => {
    const root = tmp();
    const input = join(root, 'experiments');
    const output = join(root, 'queue');
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, 'raw-transcript.txt'), 'Roger: raw transcript\nHermes: keep this raw', 'utf8');
    writeFileSync(join(input, 'report.md'), 'api_key = sk-1234567890abcdef1234567890abcdef', 'utf8');

    const result = scanPromotionQueue({ inputRoot: input, outputRoot: output });

    expect(result.summary.total_items).toBe(2);
    expect(result.summary.blocked_items).toBe(2);
    expect(result.items.every(item => item.status === 'blocked')).toBe(true);
    expect(result.items.flatMap(item => item.blockers).join('\n')).toMatch(/raw transcript|secret/i);
  });

  test('renders a reviewable markdown queue report', () => {
    const root = tmp();
    const input = join(root, 'experiments');
    const artifact = join(input, 'source-health.json');
    mkdirSync(input, { recursive: true });
    writeFileSync(artifact, JSON.stringify({ summary: { source_covered: 2 } }), 'utf8');

    const result = scanPromotionQueue({ inputRoot: input, dryRun: true });
    const markdown = renderPromotionQueueMarkdown(result);

    expect(markdown).toContain('# GBrain Promotion Queue');
    expect(markdown).toContain('source-health');
    expect(markdown).toContain('canonical vault writes: 0');
  });
});
