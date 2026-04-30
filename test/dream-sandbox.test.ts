import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertSafeDreamSandboxRoot,
  planDreamSandbox,
  runDreamSandbox,
} from '../src/core/dream-sandbox.ts';

function makeTmpDir(prefix = 'gbrain-dream-sandbox-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeTranscript(root: string, name = '2026-04-30-hermes-session.txt'): string {
  const path = join(root, name);
  writeFileSync(path, [
    'Roger: We need a safer GBrain dream synthesis plan.',
    'Hermes: Use an isolated sandbox and never write canonical notes first.',
    'Roger: Produce a reviewable experimental note only.',
    'Hermes: Include source path, content hash, and promotion warnings.',
  ].join('\n'), 'utf8');
  return path;
}

describe('dream synthesis sandbox', () => {
  test('plans an experimental dream note without writing files in dry-run mode', () => {
    const root = makeTmpDir();
    const input = makeTranscript(root);
    const outputRoot = join(root, 'sandbox-output');

    const result = planDreamSandbox({ input, outputRoot, dryRun: true });

    expect(result.slug).toStartWith('experiments/dreams/2026-04-30/2026-04-30-hermes-session-');
    expect(result.outputPath).toStartWith(outputRoot);
    expect(result.markdown).toContain('type: source');
    expect(result.markdown).toContain('dream-sandbox');
    expect(result.markdown).toContain('Promotion status: sandbox-only');
    expect(existsSync(result.outputPath)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test('writes only under the explicit sandbox output root when not dry-run', () => {
    const root = makeTmpDir();
    const input = makeTranscript(root);
    const outputRoot = join(root, 'sandbox-output');

    const result = runDreamSandbox({ input, outputRoot, dryRun: false });

    expect(result.written).toBe(true);
    expect(existsSync(result.outputPath)).toBe(true);
    expect(readFileSync(result.outputPath, 'utf8')).toBe(result.markdown);
    expect(result.outputPath).toStartWith(outputRoot);
    expect(readFileSync(input, 'utf8')).toContain('safer GBrain dream synthesis plan');

    rmSync(root, { recursive: true, force: true });
  });

  test('refuses canonical vault output roots', () => {
    const canonicalRoot = '/Users/rogergimbel/Knowledge/Winston';
    expect(() => assertSafeDreamSandboxRoot(canonicalRoot, canonicalRoot)).toThrow(/canonical Obsidian/i);
    expect(() => assertSafeDreamSandboxRoot(join(canonicalRoot, 'experiments/dreams'), canonicalRoot)).toThrow(/canonical Obsidian/i);
  });

  test('does not call LLMs, minions, live DB, or canonical sync by design', () => {
    const root = makeTmpDir();
    const input = makeTranscript(root);
    const outputRoot = join(root, 'sandbox-output');

    const result = planDreamSandbox({ input, outputRoot, dryRun: true });

    expect(result.sideEffects).toEqual({
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    });

    rmSync(root, { recursive: true, force: true });
  });

  test('CLI help and dry-run run without connecting to a database', async () => {
    const root = makeTmpDir();
    const input = makeTranscript(root);
    const outputRoot = join(root, 'sandbox-output');

    const helpProc = Bun.spawn(['bun', 'run', 'src/cli.ts', 'dream-sandbox', '--help'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const helpStdout = await new Response(helpProc.stdout).text();
    expect(await helpProc.exited).toBe(0);
    expect(helpStdout).toContain('Usage: gbrain dream-sandbox');

    const runProc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'dream-sandbox',
      '--input', input,
      '--output', outputRoot,
      '--dry-run',
      '--json',
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(runProc.stdout).text();
    const stderr = await new Response(runProc.stderr).text();
    expect(await runProc.exited).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(false);
    expect(parsed.slug).toStartWith('experiments/dreams/2026-04-30/');

    rmSync(root, { recursive: true, force: true });
  });
});
