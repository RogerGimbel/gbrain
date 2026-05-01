import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
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
  runDreamSandboxPromotionPacket,
  runDreamSandboxPromotionApplyDryRun,
  runDreamSandboxPromotionCanonicalPromote,
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

async function makePromotionPacket(root: string, reviewed = true): Promise<string> {
  const input = makeTranscript(root, '2026-04-30-gbrain-staging-apply.txt');
  const outputRoot = join(root, 'sandbox-output');
  const packetRoot = join(root, 'promotion-review');
  const result = runDreamSandbox({ input, outputRoot, dryRun: false });
  const evaluation = await runDreamSandboxCrossReferenceEvaluation({
    result,
    queries: ['GBrain'],
    limit: 1,
    search: async query => ([{
      query,
      slug: 'projects/control/agent-stack-upgrade-plan-2026-04-30',
      title: 'Agent Stack Upgrade Plan',
      type: 'project-plan',
      score: 0.99,
    }]),
  });
  const packet = runDreamSandboxPromotionPacket({ result, evaluation, packetRoot });
  if (reviewed) {
    writeFileSync(packet.files.humanDecision, [
      '# Human decision',
      '',
      'Decision: promote-dry-run-only',
      'Reviewer: Roger',
      'Scope: staging-only',
      '',
    ].join('\n'), 'utf8');
  }
  return packetRoot;
}

async function makeCanonicalPromotionPacket(root: string, targetPage: string): Promise<string> {
  const packetRoot = await makePromotionPacket(root, false);
  writeFileSync(join(packetRoot, 'review', 'human-decision.md'), [
    '# Human decision',
    '',
    'Decision: promote-canonical',
    'Reviewer: Hermes',
    'Scope: canonical-main-lane',
    `Target page: ${targetPage}`,
    'Canonical summary: Promote the reviewed dream-promotion lane into the guarded main workflow; do not promote the sample as a standalone page.',
    '',
  ].join('\n'), 'utf8');
  return packetRoot;
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

  test('generates a dry-run promotion packet under a sandbox review root only', async () => {
    const root = makeTmpDir();
    const input = makeTranscript(root, '2026-04-30-gbrain-promotion-packet.txt');
    const outputRoot = join(root, 'sandbox-output');
    const packetRoot = join(root, 'promotion-review');
    const result = runDreamSandbox({ input, outputRoot, dryRun: false });
    const evaluation = await runDreamSandboxCrossReferenceEvaluation({
      result,
      queries: ['GBrain'],
      limit: 1,
      search: async query => ([{
        query,
        slug: 'projects/control/agent-stack-upgrade-plan-2026-04-30',
        title: 'Agent Stack Upgrade Plan',
        type: 'project-plan',
        score: 0.99,
      }]),
    });

    const packet = runDreamSandboxPromotionPacket({ result, evaluation, packetRoot });

    expect(packet.status).toBe('dry-run-review-only');
    expect(packet.sideEffects).toEqual({
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    });
    expect(packet.files.canonicalNoteDraft).toStartWith(packetRoot);
    expect(packet.files.linksProposed).toStartWith(packetRoot);
    expect(existsSync(packet.files.canonicalNoteDraft)).toBe(true);
    expect(existsSync(packet.files.linksProposed)).toBe(true);
    expect(existsSync(packet.files.humanDecision)).toBe(true);
    const draft = readFileSync(packet.files.canonicalNoteDraft, 'utf8');
    expect(draft).toContain('status: draft-promotion-review');
    expect(draft).toContain('promotion_mode: dry-run');
    expect(draft).toContain('Human review required');
    expect(draft).toContain('projects/control/agent-stack-upgrade-plan-2026-04-30');
    const links = JSON.parse(readFileSync(packet.files.linksProposed, 'utf8'));
    expect(links[0].action).toBe('review-ambiguous');
    expect(links[0].to_slug).toBe('projects/control/agent-stack-upgrade-plan-2026-04-30');

    rmSync(root, { recursive: true, force: true });
  });

  test('promotion packet generator refuses canonical vault roots and CLI writes no canonical pages', async () => {
    const root = makeTmpDir();
    const input = makeTranscript(root, '2026-04-30-gbrain-promotion-cli.txt');
    const outputRoot = join(root, 'sandbox-output');
    const packetRoot = join(root, 'promotion-review');
    const fakeEngine = {
      searchKeyword: async () => [{
        slug: 'knowledge/agents/gbrain',
        title: 'GBrain',
        type: 'agent-profile',
        score: 0.9,
      }],
    } as any;

    await runDreamSandboxCommand([
      '--input', input,
      '--output', outputRoot,
      '--write-promotion-packet', packetRoot,
      '--xref-query', 'GBrain',
      '--json',
    ], fakeEngine);

    expect(existsSync(join(packetRoot, 'proposed', 'canonical-note-draft.md'))).toBe(true);
    expect(readFileSync(join(packetRoot, 'review', 'human-decision.md'), 'utf8')).toContain('Decision: pending-human-review');

    await expect(runDreamSandboxCommand([
      '--input', input,
      '--output', outputRoot,
      '--write-promotion-packet', join(root, 'canonical-subdir'),
      '--canonical-root', root,
    ])).rejects.toThrow(/canonical Obsidian/i);

    rmSync(root, { recursive: true, force: true });
  });

  test('staging-only apply dry-run requires reviewed packet and writes one proposed markdown page to staging vault', async () => {
    const root = makeTmpDir();
    const packetRoot = await makePromotionPacket(root, true);
    const stagingVault = join(root, 'staging-vault');
    const reportRoot = join(root, 'apply-report');

    const apply = runDreamSandboxPromotionApplyDryRun({
      promotionPacketRoot: packetRoot,
      stagingVaultRoot: stagingVault,
      reportRoot,
    });

    expect(apply.status).toBe('staging-dry-run-only');
    expect(apply.sideEffects).toEqual({
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
      stagingVaultWrites: 1,
      liveSyncRuns: 0,
    });
    expect(apply.stagedFiles).toHaveLength(1);
    expect(apply.stagedFiles[0]).toStartWith(resolve(stagingVault));
    expect(apply.stagedFiles[0]).toContain('/experiments/dream-promotions/');
    expect(existsSync(apply.stagedFiles[0])).toBe(true);
    expect(readFileSync(apply.stagedFiles[0], 'utf8')).toContain('staging-dry-run-only');
    expect(existsSync(join(reportRoot, 'apply-dry-run-report.md'))).toBe(true);
    expect(existsSync(join(reportRoot, 'apply-dry-run-report.json'))).toBe(true);
    expect(existsSync(join(reportRoot, 'links-proposed.json'))).toBe(true);
    expect(existsSync(join(reportRoot, 'input-packet-copy', 'manifest.json'))).toBe(true);
    expect(readFileSync(join(reportRoot, 'apply-dry-run-report.md'), 'utf8')).toContain('No canonical Obsidian writes were performed.');

    rmSync(root, { recursive: true, force: true });
  });

  test('staging-only apply dry-run refuses canonical staging vault roots and pending decisions', async () => {
    const root = makeTmpDir();
    const reviewedPacket = await makePromotionPacket(root, true);
    const pendingRoot = makeTmpDir('gbrain-dream-sandbox-pending-test-');
    const pendingPacket = await makePromotionPacket(pendingRoot, false);

    expect(() => runDreamSandboxPromotionApplyDryRun({
      promotionPacketRoot: reviewedPacket,
      stagingVaultRoot: root,
      reportRoot: join(root, 'report'),
      canonicalRoot: root,
    })).toThrow(/canonical Obsidian/i);

    expect(() => runDreamSandboxPromotionApplyDryRun({
      promotionPacketRoot: reviewedPacket,
      stagingVaultRoot: join(root, 'nested-staging'),
      reportRoot: join(root, 'report'),
      canonicalRoot: root,
    })).toThrow(/canonical Obsidian/i);

    expect(() => runDreamSandboxPromotionApplyDryRun({
      promotionPacketRoot: pendingPacket,
      stagingVaultRoot: join(pendingRoot, 'staging-vault'),
      reportRoot: join(pendingRoot, 'report'),
    })).toThrow(/promote-dry-run-only/i);

    rmSync(root, { recursive: true, force: true });
    rmSync(pendingRoot, { recursive: true, force: true });
  });

  test('CLI returns staging-only apply dry-run JSON and does not need a live engine', async () => {
    const root = makeTmpDir();
    const packetRoot = await makePromotionPacket(root, true);
    const copiedPacket = join(root, 'copied-promotion-review');
    cpSync(packetRoot, copiedPacket, { recursive: true });
    const stagingVault = join(root, 'staging-vault');
    const reportRoot = join(root, 'apply-report');

    const proc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'dream-sandbox',
      '--apply-promotion-dry-run',
      '--promotion-packet', copiedPacket,
      '--staging-vault', stagingVault,
      '--write-apply-report', reportRoot,
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
    expect(parsed.applyDryRun.status).toBe('staging-dry-run-only');
    expect(parsed.applyDryRun.sideEffects.liveDbWrites).toBe(0);
    expect(parsed.applyDryRun.sideEffects.canonicalVaultWrites).toBe(0);
    expect(parsed.applyDryRun.stagedFiles).toHaveLength(1);
    expect(existsSync(parsed.applyDryRun.stagedFiles[0])).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  test('canonical promotion requires reviewed packet and appends one curated block to an existing target page', async () => {
    const root = makeTmpDir();
    const canonicalRoot = join(root, 'canonical-vault');
    const targetPage = 'projects/control/agent-stack-upgrade-plan-2026-04-30';
    const targetPath = join(canonicalRoot, `${targetPage}.md`);
    const reportRoot = join(root, 'canonical-promotion-report');
    const packetRoot = await makeCanonicalPromotionPacket(root, targetPage);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, '# Agent Stack Upgrade Plan\n\nExisting plan body.\n', 'utf8');

    const promotion = runDreamSandboxPromotionCanonicalPromote({
      promotionPacketRoot: packetRoot,
      canonicalRoot,
      targetPage,
      reportRoot,
    });

    expect(promotion.status).toBe('canonical-main-lane-promoted');
    expect(promotion.targetPage).toBe(targetPage);
    expect(promotion.targetPath).toBe(resolve(targetPath));
    expect(promotion.sideEffects).toEqual({
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 1,
      proposedLinkWrites: 0,
      liveSyncRuns: 0,
      reportWrites: 4,
    });
    const target = readFileSync(targetPath, 'utf8');
    expect(target).toContain('## Dream sandbox reviewed promotion');
    expect(target).toContain('Decision: `promote-canonical`');
    expect(target).toContain('Promote the reviewed dream-promotion lane into the guarded main workflow');
    expect(target).not.toContain('Candidate existing pages checked before new-page creation');
    expect(existsSync(join(reportRoot, 'canonical-promotion-report.md'))).toBe(true);
    expect(existsSync(join(reportRoot, 'canonical-promotion-report.json'))).toBe(true);
    expect(existsSync(join(reportRoot, 'canonical-promotion-diff.md'))).toBe(true);
    expect(existsSync(join(reportRoot, 'links-proposed.json'))).toBe(true);
    expect(readFileSync(join(reportRoot, 'canonical-promotion-report.md'), 'utf8')).toContain('Proposed links were not written automatically.');

    rmSync(root, { recursive: true, force: true });
  });

  test('canonical promotion refuses staging decisions, missing target pages, new-page creation, and target traversal', async () => {
    const root = makeTmpDir();
    const stagingRoot = makeTmpDir('gbrain-dream-sandbox-staging-decision-test-');
    const canonicalRoot = join(root, 'canonical-vault');
    const targetPage = 'projects/control/agent-stack-upgrade-plan-2026-04-30';
    const targetPath = join(canonicalRoot, `${targetPage}.md`);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, '# Agent Stack Upgrade Plan\n', 'utf8');
    const stagingPacket = await makePromotionPacket(stagingRoot, true);
    const canonicalPacket = await makeCanonicalPromotionPacket(root, targetPage);
    const missingRoot = makeTmpDir('gbrain-dream-sandbox-missing-target-test-');
    const missingTargetPage = 'projects/control/new-page-is-not-allowed';
    const missingTargetPacket = await makeCanonicalPromotionPacket(missingRoot, missingTargetPage);

    expect(() => runDreamSandboxPromotionCanonicalPromote({
      promotionPacketRoot: stagingPacket,
      canonicalRoot,
      targetPage,
      reportRoot: join(root, 'report-staging'),
    })).toThrow(/promote-canonical/i);

    expect(() => runDreamSandboxPromotionCanonicalPromote({
      promotionPacketRoot: missingTargetPacket,
      canonicalRoot,
      targetPage: missingTargetPage,
      reportRoot: join(root, 'report-missing'),
    })).toThrow(/existing target page/i);

    expect(() => runDreamSandboxPromotionCanonicalPromote({
      promotionPacketRoot: canonicalPacket,
      canonicalRoot,
      targetPage: '../outside',
      reportRoot: join(root, 'report-traversal'),
    })).toThrow(/relative vault slug/i);

    rmSync(root, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  });

  test('CLI promotes a reviewed packet to an existing target page and emits JSON without a live engine', async () => {
    const root = makeTmpDir();
    const canonicalRoot = join(root, 'canonical-vault');
    const targetPage = 'projects/control/agent-stack-upgrade-plan-2026-04-30';
    const targetPath = join(canonicalRoot, `${targetPage}.md`);
    const packetRoot = await makeCanonicalPromotionPacket(root, targetPage);
    const reportRoot = join(root, 'canonical-promotion-report');
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, '# Agent Stack Upgrade Plan\n\nExisting plan body.\n', 'utf8');

    const proc = Bun.spawn([
      'bun', 'run', 'src/cli.ts', 'dream-sandbox',
      '--promote-reviewed-packet',
      '--promotion-packet', packetRoot,
      '--canonical-root', canonicalRoot,
      '--target-page', targetPage,
      '--write-promotion-report', reportRoot,
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
    expect(parsed.canonicalPromotion.status).toBe('canonical-main-lane-promoted');
    expect(parsed.canonicalPromotion.sideEffects.liveDbWrites).toBe(0);
    expect(parsed.canonicalPromotion.sideEffects.proposedLinkWrites).toBe(0);
    expect(readFileSync(targetPath, 'utf8')).toContain('Dream sandbox reviewed promotion');

    rmSync(root, { recursive: true, force: true });
  });
});
