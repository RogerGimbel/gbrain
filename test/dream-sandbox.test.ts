import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  assertSafeDreamSandboxRoot,
  evaluateDreamSandbox,
  planDreamSandbox,
  renderDreamSandboxBatchDecisionMarkdown,
  renderDreamSandboxEvaluationMarkdown,
  runDreamSandbox,
  runDreamSandboxBatchDecision,
  runDreamSandboxCrossReferenceEvaluation,
} from '../src/core/dream-sandbox.ts';
import { runDreamSandboxCommand } from '../src/commands/dream-sandbox.ts';

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

  test('evaluates sandbox output against upstream synthesis goals without promotion', () => {
    const root = makeTmpDir();
    const input = makeTranscript(root);
    const outputRoot = join(root, 'sandbox-output');
    const result = runDreamSandbox({ input, outputRoot, dryRun: false });

    const evaluation = evaluateDreamSandbox(result);

    expect(evaluation.overallStatus).toBe('sandbox-pass-needs-human-review');
    expect(evaluation.upstreamGoalChecks.map(c => c.id)).toEqual([
      'quote-user-verbatim',
      'cross-reference-existing-brain',
      'allowed-namespace',
      'slug-discipline',
      'no-canonical-write',
      'human-review-required',
    ]);
    expect(evaluation.upstreamGoalChecks.find(c => c.id === 'allowed-namespace')?.status).toBe('pass');
    expect(evaluation.upstreamGoalChecks.find(c => c.id === 'cross-reference-existing-brain')?.status).toBe('deferred');
    expect(evaluation.sideEffects).toEqual(result.sideEffects);

    const markdown = renderDreamSandboxEvaluationMarkdown(evaluation);
    expect(markdown).toContain('# Dream Sandbox Evaluation');
    expect(markdown).toContain('sandbox-pass-needs-human-review');
    expect(markdown).toContain('No live promotion is allowed from this report.');

    rmSync(root, { recursive: true, force: true });
  });

  test('CLI can write a sandbox evaluation report artifact without database access', async () => {
    const root = makeTmpDir();
    const input = makeTranscript(root);
    const outputRoot = join(root, 'sandbox-output');
    const reportPath = join(root, 'evaluation.md');

    const proc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'dream-sandbox',
      '--input', input,
      '--output', outputRoot,
      '--write-eval', reportPath,
      '--json',
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.evaluationPath).toBe(reportPath);
    expect(parsed.evaluation.overallStatus).toBe('sandbox-pass-needs-human-review');
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toContain('## Upstream goal comparison');

    rmSync(root, { recursive: true, force: true });
  });

  test('aggregates multiple real-pattern fixtures into a park decision when critical goals remain deferred', () => {
    const root = makeTmpDir();
    const outputRoot = join(root, 'sandbox-output');
    const inputs = [
      makeTranscript(root, '2026-04-23-hermes-upgrade-gpt55.txt'),
      makeTranscript(root, '2026-04-24-context-cap-fail-closed.txt'),
      makeTranscript(root, '2026-04-30-gbrain-frontmatter-review.txt'),
      makeTranscript(root, '2026-04-30-dream-sandbox-decision.txt'),
    ];

    const report = runDreamSandboxBatchDecision({ inputs, outputRoot, dryRun: false });

    expect(report.fixtureCount).toBe(4);
    expect(report.overallRecommendation).toBe('park');
    expect(report.aggregate.failures).toBe(0);
    expect(report.aggregate.deferred).toBeGreaterThan(0);
    expect(report.aggregate.sideEffects).toEqual({
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    });
    expect(report.results.every(r => r.result.slug.startsWith('experiments/dreams/'))).toBe(true);
    expect(report.results.every(r => existsSync(r.result.outputPath))).toBe(true);
    expect(report.nextSteps.join('\n')).toContain('Do not promote dream synthesis');

    const markdown = renderDreamSandboxBatchDecisionMarkdown(report);
    expect(markdown).toContain('# Dream Sandbox Decision Gate');
    expect(markdown).toContain('Recommendation: `park`');
    expect(markdown).toContain('cross-reference-existing-brain');
    expect(markdown).toContain('Fixture count: 4');

    rmSync(root, { recursive: true, force: true });
  });

  test('CLI can write a batch decision report from multiple inputs without database access', async () => {
    const root = makeTmpDir();
    const outputRoot = join(root, 'sandbox-output');
    const reportPath = join(root, 'decision-report.md');
    const first = makeTranscript(root, '2026-04-23-hermes-upgrade-gpt55.txt');
    const second = makeTranscript(root, '2026-04-30-dream-sandbox-decision.txt');

    const proc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'dream-sandbox',
      '--input', first,
      '--input', second,
      '--output', outputRoot,
      '--write-decision', reportPath,
      '--json',
    ], {
      cwd: new URL('..', import.meta.url).pathname,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed.decisionReportPath).toBe(reportPath);
    expect(parsed.decisionReport.fixtureCount).toBe(2);
    expect(parsed.decisionReport.overallRecommendation).toBe('park');
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, 'utf8')).toContain('Recommendation: `park`');

    rmSync(root, { recursive: true, force: true });
  });

  test('read-only cross-reference evaluation can satisfy the existing-brain search gate without writes', async () => {
    const root = makeTmpDir();
    const input = makeTranscript(root, '2026-04-30-gbrain-cross-reference.txt');
    const outputRoot = join(root, 'sandbox-output');
    const result = runDreamSandbox({ input, outputRoot, dryRun: false });

    const evaluation = await runDreamSandboxCrossReferenceEvaluation({
      result,
      queries: ['GBrain', 'Hermes'],
      limit: 2,
      search: async query => ([{
        query,
        slug: query === 'GBrain' ? 'knowledge/agents/gbrain' : 'knowledge/agents/hermes',
        title: query,
        type: 'agent-profile',
        score: 1,
      }]),
    });

    expect(evaluation.upstreamGoalChecks.find(c => c.id === 'cross-reference-existing-brain')?.status).toBe('pass');
    expect(evaluation.crossReferences?.queries).toHaveLength(2);
    expect(evaluation.crossReferences?.queries[0].results[0].slug).toBe('knowledge/agents/gbrain');
    expect(evaluation.sideEffects).toEqual({
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    });
    expect(renderDreamSandboxEvaluationMarkdown(evaluation)).toContain('## Read-only cross-reference/search evidence');

    rmSync(root, { recursive: true, force: true });
  });

  test('CLI writes read-only cross-reference evaluation report with an injected search engine', async () => {
    const root = makeTmpDir();
    const input = makeTranscript(root, '2026-04-30-gbrain-cross-reference-cli.txt');
    const outputRoot = join(root, 'sandbox-output');
    const reportPath = join(root, 'xref-report.md');
    const searched: string[] = [];
    const fakeEngine = {
      searchKeyword: async (query: string, opts?: { limit?: number }) => {
        searched.push(`${query}:${opts?.limit}`);
        return [{
          slug: query === 'GBrain' ? 'knowledge/agents/gbrain' : 'knowledge/agents/hermes',
          title: query,
          type: 'agent-profile',
          score: 0.9,
        }];
      },
    } as any;

    await runDreamSandboxCommand([
      '--input', input,
      '--output', outputRoot,
      '--write-xref-eval', reportPath,
      '--xref-query', 'GBrain',
      '--xref-query', 'Hermes',
      '--xref-limit', '2',
    ], fakeEngine);

    expect(searched).toEqual(['GBrain:2', 'Hermes:2']);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('## Read-only cross-reference/search evidence');
    expect(report).toContain('`knowledge/agents/gbrain`');
    expect(report).toContain('- Live GBrain DB writes: 0');
    expect(report).toContain('- Canonical Obsidian writes: 0');

    rmSync(root, { recursive: true, force: true });
  });
});
