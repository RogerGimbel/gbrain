import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { planSessionPacket, runSessionPacketSandbox, assertSafeSessionPacketRoot } from '../src/core/session-packet.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-session-packet-'));
}

function transcript(root: string): string {
  const p = join(root, 'hermes-rodaco-session.txt');
  writeFileSync(p, [
    'Roger: We decided to keep Rodaco production read-only until approved.',
    'Hermes: Current state: public smoke passes and no deploys were run.',
    'Hermes: Changed artifacts: /Users/rogergimbel/Projects/rodaco-ops/package.json',
    'Hermes: Verification: Playwright public smoke passed with status 200.',
    'Roger: Next step is compare Hermes and Argos audits.',
    'Hermes: Blocker: authenticated prod smoke requires explicit approval.',
  ].join('\n'), 'utf8');
  return p;
}

describe('session packet sandbox', () => {
  test('plans a reviewable session packet without writing files in dry-run mode', () => {
    const root = tmp();
    const input = transcript(root);
    const outputRoot = join(root, 'packets');
    const result = planSessionPacket({ input, outputRoot, dryRun: true, sourceAgent: 'Hermes', sourceOrigin: 'telegram' });

    expect(result.slug).toStartWith('experiments/session-packets/hermes/');
    expect(result.markdown).toContain('Promotion status: sandbox-only');
    expect(result.markdown).toContain('source_agent: Hermes');
    expect(result.packet.decisions[0]).toContain('keep Rodaco production read-only');
    expect(result.packet.verification[0]).toContain('Playwright public smoke passed');
    expect(result.written).toBe(false);
    expect(existsSync(result.outputPath)).toBe(false);
  });

  test('writes only under explicit sandbox root', () => {
    const root = tmp();
    const input = transcript(root);
    const outputRoot = join(root, 'packets');
    const result = runSessionPacketSandbox({ input, outputRoot, sourceAgent: 'Hermes', sourceOrigin: 'telegram' });

    expect(result.written).toBe(true);
    expect(result.outputPath).toStartWith(outputRoot);
    expect(readFileSync(result.outputPath, 'utf8')).toBe(result.markdown);
    expect(result.sideEffects).toEqual({ llmCalls: 0, liveDbWrites: 0, canonicalVaultWrites: 0, liveSync: 0 });
  });

  test('refuses canonical vault output roots', () => {
    const canonicalRoot = '/Users/rogergimbel/Knowledge/Winston';
    expect(() => assertSafeSessionPacketRoot(canonicalRoot, canonicalRoot)).toThrow(/canonical Obsidian/i);
    expect(() => assertSafeSessionPacketRoot(join(canonicalRoot, 'knowledge/session-packets'), canonicalRoot)).toThrow(/canonical Obsidian/i);
  });
});
