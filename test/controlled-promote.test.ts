import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { planControlledPromotion, runControlledPromotion } from '../src/core/controlled-promote.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-controlled-promote-'));
}

function item(root: string, overrides: Record<string, unknown> = {}): string {
  const artifact = join(root, 'retrieval-gate.md');
  writeFileSync(artifact, ['---', 'title: Retrieval Gate', 'type: retrieval-gate', 'source_agent: GBrain', '---', '# Retrieval Gate'].join('\n'), 'utf8');
  const manifest = {
    id: 'abc123',
    title: 'Retrieval Gate',
    path: artifact,
    artifact_class: 'retrieval-gate',
    risk: 'low',
    status: 'ready',
    checksum: 'abcdef1234567890',
    blockers: [],
    ...overrides,
  };
  const manifestPath = join(root, 'item.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

describe('controlled promote', () => {
  test('dry-run plans an allowlisted append-only promotion without writing canonical target', () => {
    const root = tmp();
    const manifest = item(root);
    const targetRoot = join(root, 'vault');

    const receipt = planControlledPromotion({ itemPath: manifest, targetRoot, namespace: 'knowledge/reports/retrieval-gates' });

    expect(receipt.ok).toBe(true);
    expect(receipt.applied).toBe(false);
    expect(receipt.target_path).toContain('knowledge/reports/retrieval-gates');
    expect(receipt.target_path).toContain('retrieval-gate');
    expect(receipt.diff).toContain('+---');
    expect(receipt.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 });
    expect(existsSync(receipt.target_path)).toBe(false);
  });

  test('apply writes versioned artifact and receipt only for allowlisted low-risk ready item', () => {
    const root = tmp();
    const manifest = item(root);
    const targetRoot = join(root, 'vault');

    const receipt = runControlledPromotion({ itemPath: manifest, targetRoot, namespace: 'knowledge/reports/retrieval-gates', apply: true });

    expect(receipt.ok).toBe(true);
    expect(receipt.applied).toBe(true);
    expect(existsSync(receipt.target_path)).toBe(true);
    expect(readFileSync(receipt.target_path, 'utf8')).toContain('controlled_promotion_id');
    expect(receipt.sideEffects.canonicalVaultWrites).toBe(1);
  });

  test('refuses non-allowlisted namespace, blocked/high-risk/raw transcript, and secret content', () => {
    const root = tmp();
    const targetRoot = join(root, 'vault');
    const badNamespace = planControlledPromotion({ itemPath: item(root), targetRoot, namespace: 'knowledge/private' });
    const highRisk = planControlledPromotion({ itemPath: item(root, { risk: 'high' }), targetRoot, namespace: 'knowledge/reports/retrieval-gates' });
    const raw = planControlledPromotion({ itemPath: item(root, { artifact_class: 'raw-transcript' }), targetRoot, namespace: 'knowledge/reports/retrieval-gates' });
    const secretArtifact = join(root, 'secret.md');
    writeFileSync(secretArtifact, 'api_key = sk-123...cdef', 'utf8');
    const secretManifest = item(root, { path: secretArtifact });
    const secret = planControlledPromotion({ itemPath: secretManifest, targetRoot, namespace: 'knowledge/reports/retrieval-gates' });

    expect(badNamespace.ok).toBe(false);
    expect(highRisk.ok).toBe(false);
    expect(raw.ok).toBe(false);
    expect(secret.ok).toBe(false);
    expect([badNamespace, highRisk, raw, secret].flatMap(r => r.blockers).join('\n')).toMatch(/allowlisted|high-risk|raw transcript|secret/i);
  });

  test('refuses namespace traversal even when the namespace starts with an allowlisted prefix', () => {
    const root = tmp();
    const targetRoot = join(root, 'vault');
    const traversal = planControlledPromotion({
      itemPath: item(root),
      targetRoot,
      namespace: 'knowledge/reports/../../../escape-controlled-promotion-test',
    });

    expect(traversal.ok).toBe(false);
    expect(traversal.applied).toBe(false);
    expect(traversal.target_path).not.toContain('/escape-controlled-promotion-test/');
    expect(traversal.blockers.join('\n')).toMatch(/namespace|target path|traversal|escape/i);
  });

  test('refuses duplicate replay instead of overwriting an existing promoted artifact', () => {
    const root = tmp();
    const manifest = item(root);
    const targetRoot = join(root, 'vault');
    const first = runControlledPromotion({ itemPath: manifest, targetRoot, namespace: 'knowledge/reports/retrieval-gates', apply: true });
    const replay = runControlledPromotion({ itemPath: manifest, targetRoot, namespace: 'knowledge/reports/retrieval-gates', apply: true });

    expect(first.ok).toBe(true);
    expect(first.applied).toBe(true);
    expect(replay.ok).toBe(false);
    expect(replay.applied).toBe(false);
    expect(replay.target_path).toBe(first.target_path);
    expect(replay.sideEffects).toEqual({ canonicalVaultWrites: 0, liveDbWrites: 0, liveSync: 0 });
    expect(replay.blockers.join('\n')).toMatch(/already exists|duplicate|replay/i);
  });
});
