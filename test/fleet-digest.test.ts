import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildFleetDigest, renderFleetDigestMarkdown } from '../src/core/fleet-digest.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-fleet-digest-'));
}

describe('fleet digest', () => {
  test('combines queue, source, drift, and canary reports into review digest without writes outside output', () => {
    const output = tmp();
    const digest = buildFleetDigest({
      outputRoot: output,
      promotionQueue: { summary: { ready_items: 2, blocked_items: 1, total_items: 3 }, items: [{ title: 'Packet', status: 'ready' }] },
      sourceHealth: { summary: { source_covered: 7, total_files: 10, missing_source_metadata: 3, stale_sources: 1 } },
      fleetDrift: { summary: { total_findings: 4, conflicts: 1, dead_references: 1, stale_sources: 1, superseded_checkpoints: 1 }, findings: [{ kind: 'conflict', subject: 'Hermes status' }] },
      retrievalCanary: { mode: 'shadow', gate_ok: true, canary_enabled: false, rollback_required: false, gate_metrics: { protected_top1_passed: 13, protected_top1_total: 13, mean_mrr_delta: 0 } },
    });

    expect(digest.sections.promotion_queue).toContain('2 ready');
    expect(digest.sections.source_health).toContain('7/10');
    expect(digest.sections.fleet_drift).toContain('4 finding');
    expect(digest.sections.retrieval_canary).toContain('13/13');
    expect(digest.recommendations.length).toBeGreaterThan(0);
    expect(digest.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, taskExecutions: 0 });
    expect(existsSync(join(output, 'fleet-digest.json'))).toBe(true);
    expect(existsSync(join(output, 'fleet-digest.md'))).toBe(true);
  });

  test('renders Telegram-friendly markdown with no table syntax', () => {
    const digest = buildFleetDigest({ dryRun: true, promotionQueue: { summary: { ready_items: 0, blocked_items: 0, total_items: 0 } } });
    const markdown = renderFleetDigestMarkdown(digest);

    expect(markdown).toContain('# Fleet Digest');
    expect(markdown).toContain('## Recommendations');
    expect(markdown).not.toContain('|');
  });

  test('degrades gracefully when inputs are missing or malformed and queue is blocked-heavy', () => {
    const root = tmp();
    const output = join(root, 'digest');
    const queuePath = join(root, 'blocked-heavy-promotion-queue.json');
    const badSourcePath = join(root, 'bad-source-health.json');
    const missingDriftPath = join(root, 'missing-fleet-drift.json');
    const blockedCanaryPath = join(root, 'blocked-retrieval-canary.json');
    writeFileSync(queuePath, JSON.stringify({ summary: { ready_items: 0, blocked_items: 4, total_items: 4, high_risk_items: 3 } }), 'utf8');
    writeFileSync(badSourcePath, '{ this is not json', 'utf8');
    writeFileSync(blockedCanaryPath, JSON.stringify({ mode: 'canary', gate_ok: true, canary_enabled: false, rollback_required: true, gate_metrics: { protected_top1_passed: 13, protected_top1_total: 13, mean_mrr_delta: 0 } }), 'utf8');

    const digest = buildFleetDigest({
      outputRoot: output,
      promotionQueuePath: queuePath,
      sourceHealthPath: badSourcePath,
      fleetDriftPath: missingDriftPath,
      retrievalCanaryPath: blockedCanaryPath,
    });
    const markdown = readFileSync(join(output, 'fleet-digest.md'), 'utf8');

    expect(digest.sections.promotion_queue).toContain('0 ready, 4 blocked');
    expect(digest.sections.source_health).toMatch(/unavailable|malformed/i);
    expect(digest.sections.fleet_drift).toMatch(/unavailable|missing/i);
    expect(digest.sections.retrieval_canary).toContain('canary mode');
    expect(digest.recommendations.join('\n')).toMatch(/blocked promotion|degraded|missing|malformed|canary disabled/i);
    expect(digest.delivery.telegram_ready).toBe(true);
    expect(digest.delivery.scheduled_safe).toBe(true);
    expect(digest.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, taskExecutions: 0 });
    expect(markdown).toContain('## Degraded Inputs');
    expect(markdown).not.toContain('|');
  });
});
