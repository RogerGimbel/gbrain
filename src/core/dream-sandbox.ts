import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

const DEFAULT_CANONICAL_OBSIDIAN_ROOT = '/Users/rogergimbel/Knowledge/Winston';
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

export interface DreamSandboxOptions {
  input: string;
  outputRoot: string;
  dryRun?: boolean;
  canonicalRoot?: string;
}

export interface DreamSandboxResult {
  ok: true;
  input: string;
  outputRoot: string;
  slug: string;
  outputPath: string;
  markdown: string;
  written: boolean;
  contentHash: string;
  transcriptBytes: number;
  sideEffects: DreamSandboxSideEffects;
}

export interface DreamSandboxSideEffects {
  llmCalls: 0;
  minionJobs: 0;
  liveDbWrites: 0;
  canonicalVaultWrites: 0;
}

export type DreamSandboxCheckStatus = 'pass' | 'deferred' | 'fail';

export interface DreamSandboxGoalCheck {
  id: string;
  upstreamGoal: string;
  status: DreamSandboxCheckStatus;
  finding: string;
}

export interface DreamSandboxCrossReferenceHit {
  query: string;
  slug: string;
  title: string;
  type: string;
  score: number;
}

export interface DreamSandboxCrossReferenceQueryEvidence {
  query: string;
  results: DreamSandboxCrossReferenceHit[];
}

export interface DreamSandboxCrossReferenceEvidence {
  mode: 'read-only-keyword-search';
  queries: DreamSandboxCrossReferenceQueryEvidence[];
  sideEffects: DreamSandboxSideEffects;
}

export interface DreamSandboxCrossReferenceEvaluationOptions {
  result: DreamSandboxResult;
  queries: string[];
  limit?: number;
  search: (query: string, limit: number) => Promise<DreamSandboxCrossReferenceHit[]>;
}

export interface DreamSandboxEvaluation {
  overallStatus: 'sandbox-pass-needs-human-review' | 'sandbox-fail';
  slug: string;
  outputPath: string;
  input: string;
  contentHash: string;
  sideEffects: DreamSandboxSideEffects;
  upstreamGoalChecks: DreamSandboxGoalCheck[];
  crossReferences?: DreamSandboxCrossReferenceEvidence;
  recommendations: string[];
}

export type DreamSandboxDecisionRecommendation = 'promote' | 'park' | 'discard';

export interface DreamSandboxBatchDecisionOptions {
  inputs: string[];
  outputRoot: string;
  dryRun?: boolean;
  canonicalRoot?: string;
}

export interface DreamSandboxBatchDecisionEntry {
  result: DreamSandboxResult;
  evaluation: DreamSandboxEvaluation;
}

export interface DreamSandboxBatchDecisionReport {
  generatedAt: string;
  fixtureCount: number;
  overallRecommendation: DreamSandboxDecisionRecommendation;
  reason: string;
  aggregate: {
    passes: number;
    deferred: number;
    failures: number;
    sideEffects: DreamSandboxSideEffects;
  };
  results: DreamSandboxBatchDecisionEntry[];
  nextSteps: string[];
}

export interface DreamSandboxPromotionPacketOptions {
  result: DreamSandboxResult;
  evaluation: DreamSandboxEvaluation;
  packetRoot: string;
  canonicalRoot?: string;
}

export interface DreamSandboxPromotionPacketFiles {
  transcript: string;
  sandboxArtifact: string;
  xrefEvidence: string;
  canonicalNoteDraft: string;
  linksProposed: string;
  conflictsAndDuplicates: string;
  promotionSummary: string;
  humanDecision: string;
  manifest: string;
}

export interface DreamSandboxPromotionPacket {
  status: 'dry-run-review-only';
  packetRoot: string;
  sourceSlug: string;
  contentHash: string;
  files: DreamSandboxPromotionPacketFiles;
  sideEffects: DreamSandboxSideEffects;
}

export interface DreamSandboxPromotionApplyDryRunOptions {
  promotionPacketRoot: string;
  stagingVaultRoot: string;
  reportRoot: string;
  canonicalRoot?: string;
}

export interface DreamSandboxPromotionApplyDryRunSideEffects extends DreamSandboxSideEffects {
  stagingVaultWrites: number;
  liveSyncRuns: 0;
}

export interface DreamSandboxPromotionApplyDryRunResult {
  status: 'staging-dry-run-only';
  promotionPacketRoot: string;
  stagingVaultRoot: string;
  reportRoot: string;
  sourceSlug: string;
  contentHash: string;
  stagedSlug: string;
  stagedFiles: string[];
  reportFiles: {
    markdown: string;
    json: string;
    linksProposed: string;
    inputPacketCopy: string;
  };
  sideEffects: DreamSandboxPromotionApplyDryRunSideEffects;
}

export function assertSafeDreamSandboxRoot(
  outputRoot: string,
  canonicalRoot = DEFAULT_CANONICAL_OBSIDIAN_ROOT,
): void {
  const out = resolve(outputRoot);
  const canonical = resolve(canonicalRoot);
  if (out === canonical || out.startsWith(canonical + '/')) {
    throw new Error(`Refusing dream sandbox output under canonical Obsidian vault: ${out}`);
  }
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'transcript';
}

function yamlString(value: string): string {
  return JSON.stringify(value ?? '');
}

function inferDateFromName(fileName: string): string {
  const match = fileName.match(DATE_PREFIX_RE);
  if (match) return match[1];
  return new Date().toISOString().slice(0, 10);
}

function excerpt(content: string, max = 900): string {
  const cleaned = content.replace(/\r\n/g, '\n').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).trimEnd() + '\n…';
}

export function planDreamSandbox(opts: DreamSandboxOptions): DreamSandboxResult {
  if (!opts.input) throw new Error('--input is required');
  if (!opts.outputRoot) throw new Error('--output is required');
  const input = resolve(opts.input);
  const outputRoot = resolve(opts.outputRoot);
  assertSafeDreamSandboxRoot(outputRoot, opts.canonicalRoot);
  if (!existsSync(input)) throw new Error(`Input transcript does not exist: ${input}`);

  const content = readFileSync(input, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');
  const fileName = basename(input);
  const date = inferDateFromName(fileName);
  const baseSlug = slugifySegment(fileName);
  const slug = `experiments/dreams/${date}/${baseSlug}-${contentHash.slice(0, 8)}`;
  const outputPath = join(outputRoot, `${slug}.md`);
  const title = `Dream Sandbox — ${baseSlug}`;
  const markdown = [
    '---',
    `title: ${yamlString(title)}`,
    'type: source',
    'tags:',
    '  - dream-sandbox',
    '  - experimental',
    'status: sandbox-only',
    `source_path: ${yamlString(input)}`,
    `content_hash: ${yamlString(contentHash)}`,
    `generated_at: ${yamlString(new Date().toISOString())}`,
    '---',
    '',
    `# ${title}`,
    '',
    'Promotion status: sandbox-only. This is an experimental dream-synthesis artifact and must not be treated as canonical memory without human review.',
    '',
    '## Safety envelope',
    '',
    '- LLM calls: 0',
    '- Minion/subagent jobs: 0',
    '- Live GBrain DB writes: 0',
    '- Canonical Obsidian writes: 0',
    '- Allowed namespace: `experiments/dreams/...`',
    '',
    '## Source transcript excerpt',
    '',
    '```text',
    excerpt(content),
    '```',
    '',
    '## Promotion checklist',
    '',
    '- [ ] Human reviewed the source transcript.',
    '- [ ] Human reviewed this generated artifact.',
    '- [ ] Canonical target namespace selected explicitly.',
    '- [ ] Live retrieval baseline checked before promotion.',
  ].join('\n');

  return {
    ok: true,
    input,
    outputRoot,
    slug,
    outputPath,
    markdown,
    written: false,
    contentHash,
    transcriptBytes: Buffer.byteLength(content, 'utf8'),
    sideEffects: {
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    },
  };
}

export function runDreamSandbox(opts: DreamSandboxOptions): DreamSandboxResult {
  const result = planDreamSandbox(opts);
  if (!opts.dryRun) {
    mkdirSync(dirname(result.outputPath), { recursive: true });
    writeFileSync(result.outputPath, result.markdown, 'utf8');
    return { ...result, written: true };
  }
  return result;
}

export function evaluateDreamSandbox(
  result: DreamSandboxResult,
  crossReferences?: DreamSandboxCrossReferenceEvidence,
): DreamSandboxEvaluation {
  const crossReferenceHits = crossReferences?.queries.reduce((sum, q) => sum + q.results.length, 0) ?? 0;
  const crossReferenceStatus: DreamSandboxCheckStatus = crossReferences
    ? (crossReferenceHits > 0 ? 'pass' : 'fail')
    : 'deferred';
  const crossReferenceFinding = crossReferences
    ? (crossReferenceHits > 0
      ? `Read-only keyword search found ${crossReferenceHits} candidate existing brain references across ${crossReferences.queries.length} queries; no writes were performed.`
      : `Read-only keyword search ran ${crossReferences.queries.length} queries but found no existing brain references.`)
    : 'Deferred intentionally: the sandbox evaluator does not connect to live GBrain or run search unless an explicit read-only searcher is supplied.';
  const checks: DreamSandboxGoalCheck[] = [
    {
      id: 'quote-user-verbatim',
      upstreamGoal: 'Quote the user verbatim; do not paraphrase memorable phrasing.',
      status: result.markdown.includes('```text') ? 'pass' : 'fail',
      finding: result.markdown.includes('```text')
        ? 'The sandbox artifact preserves a verbatim transcript excerpt instead of pretending to synthesize canonical memory.'
        : 'The artifact does not include a verbatim transcript excerpt.',
    },
    {
      id: 'cross-reference-existing-brain',
      upstreamGoal: 'Cross-reference existing brain content after searching before writes.',
      status: crossReferenceStatus,
      finding: crossReferenceFinding,
    },
    {
      id: 'allowed-namespace',
      upstreamGoal: 'Write only to an allowlisted namespace.',
      status: result.slug.startsWith('experiments/dreams/') ? 'pass' : 'fail',
      finding: `Output slug is ${result.slug}; expected experimental namespace experiments/dreams/...`,
    },
    {
      id: 'slug-discipline',
      upstreamGoal: 'Use lowercase alphanumeric/hyphen slash-separated slugs with no extensions.',
      status: /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/.test(result.slug) ? 'pass' : 'fail',
      finding: 'Slug format is checked locally before any promotion path exists.',
    },
    {
      id: 'no-canonical-write',
      upstreamGoal: 'Do not write directly to canonical live pages during first evaluation.',
      status: result.sideEffects.liveDbWrites === 0 && result.sideEffects.canonicalVaultWrites === 0 ? 'pass' : 'fail',
      finding: 'Sandbox command reports zero live DB writes and zero canonical Obsidian writes.',
    },
    {
      id: 'human-review-required',
      upstreamGoal: 'Require human review before synthesized output becomes canonical memory.',
      status: result.markdown.includes('Promotion checklist') && result.markdown.includes('sandbox-only') ? 'pass' : 'fail',
      finding: 'Artifact includes sandbox-only warning plus a promotion checklist.',
    },
  ];
  const failed = checks.some(c => c.status === 'fail');
  return {
    overallStatus: failed ? 'sandbox-fail' : 'sandbox-pass-needs-human-review',
    slug: result.slug,
    outputPath: result.outputPath,
    input: result.input,
    contentHash: result.contentHash,
    sideEffects: result.sideEffects,
    upstreamGoalChecks: checks,
    crossReferences,
    recommendations: [
      'No live promotion is allowed from this report.',
      'Human-review the sandbox artifact before designing any canonical write path.',
      crossReferences
        ? 'Use read-only cross-reference results as evidence only; do not create wikilinks or canonical pages automatically.'
        : 'Keep the next Step 6 slice sandboxed; do not add Anthropic calls, minions, live DB writes, or canonical vault writes yet.',
      crossReferences
        ? 'If the references look useful, next design a dry-run promotion proposal rather than a live write path.'
        : 'If the format is useful, next add fixture-based quality cases for real session patterns before any live integration.',
    ],
  };
}

export async function runDreamSandboxCrossReferenceEvaluation(
  opts: DreamSandboxCrossReferenceEvaluationOptions,
): Promise<DreamSandboxEvaluation> {
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
  const uniqueQueries = Array.from(new Set(opts.queries.map(q => q.trim()).filter(Boolean)));
  const queries: DreamSandboxCrossReferenceQueryEvidence[] = [];
  for (const query of uniqueQueries) {
    const results = await opts.search(query, limit);
    queries.push({
      query,
      results: results.slice(0, limit).map(hit => ({
        query,
        slug: hit.slug,
        title: hit.title,
        type: hit.type,
        score: hit.score,
      })),
    });
  }
  const crossReferences: DreamSandboxCrossReferenceEvidence = {
    mode: 'read-only-keyword-search',
    queries,
    sideEffects: {
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    },
  };
  return evaluateDreamSandbox(opts.result, crossReferences);
}

export function runDreamSandboxBatchDecision(opts: DreamSandboxBatchDecisionOptions): DreamSandboxBatchDecisionReport {
  if (!opts.inputs || opts.inputs.length === 0) throw new Error('At least one --input fixture is required');
  assertSafeDreamSandboxRoot(opts.outputRoot, opts.canonicalRoot);

  const results = opts.inputs.map(input => {
    const result = runDreamSandbox({
      input,
      outputRoot: opts.outputRoot,
      dryRun: opts.dryRun,
      canonicalRoot: opts.canonicalRoot,
    });
    return { result, evaluation: evaluateDreamSandbox(result) };
  });

  const aggregate = results.reduce((acc, entry) => {
    for (const check of entry.evaluation.upstreamGoalChecks) {
      if (check.status === 'pass') acc.passes += 1;
      if (check.status === 'deferred') acc.deferred += 1;
      if (check.status === 'fail') acc.failures += 1;
    }
    acc.sideEffects.llmCalls += entry.result.sideEffects.llmCalls;
    acc.sideEffects.minionJobs += entry.result.sideEffects.minionJobs;
    acc.sideEffects.liveDbWrites += entry.result.sideEffects.liveDbWrites;
    acc.sideEffects.canonicalVaultWrites += entry.result.sideEffects.canonicalVaultWrites;
    return acc;
  }, {
    passes: 0,
    deferred: 0,
    failures: 0,
    sideEffects: {
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    } as DreamSandboxSideEffects,
  });

  const overallRecommendation: DreamSandboxDecisionRecommendation = aggregate.failures > 0
    ? 'discard'
    : aggregate.deferred > 0
      ? 'park'
      : 'promote';
  const reason = overallRecommendation === 'discard'
    ? 'At least one real-session fixture failed a safety or quality gate.'
    : overallRecommendation === 'park'
      ? 'Real-session fixtures stayed safe, but critical goals remain deferred; do not call this implemented yet.'
      : 'All fixture gates passed with no critical deferrals; a reviewed promotion path can be designed next.';
  const nextSteps = overallRecommendation === 'park'
    ? [
      'Do not promote dream synthesis to live GBrain or canonical Obsidian yet.',
      'Keep this as Step 6 sandbox evidence rather than an implemented feature.',
      'If continuing, add read-only GBrain search/cross-reference evaluation in another sandbox-only slice.',
      'Require explicit human approval before any LLM calls, minion jobs, live DB writes, or canonical vault writes.',
    ]
    : overallRecommendation === 'discard'
      ? [
        'Remove or quarantine the sandbox code before it becomes dead production surface.',
        'Do not add a write path or LLM/minion integration.',
      ]
      : [
        'Design a dry-run promotion patch path with rollback artifacts.',
        'Run retrieval baseline before and after any staged promotion.',
        'Require human review before canonical writes.',
      ];

  return {
    generatedAt: new Date().toISOString(),
    fixtureCount: results.length,
    overallRecommendation,
    reason,
    aggregate,
    results,
    nextSteps,
  };
}

export function renderDreamSandboxBatchDecisionMarkdown(report: DreamSandboxBatchDecisionReport): string {
  const lines: string[] = [];
  lines.push('# Dream Sandbox Decision Gate');
  lines.push('');
  lines.push(`- Recommendation: \`${report.overallRecommendation}\``);
  lines.push(`- Reason: ${report.reason}`);
  lines.push(`- Fixture count: ${report.fixtureCount}`);
  lines.push(`- Generated at: \`${report.generatedAt}\``);
  lines.push('');
  lines.push('## Aggregate checks');
  lines.push('');
  lines.push(`- Passed checks: ${report.aggregate.passes}`);
  lines.push(`- Deferred checks: ${report.aggregate.deferred}`);
  lines.push(`- Failed checks: ${report.aggregate.failures}`);
  lines.push(`- LLM calls: ${report.aggregate.sideEffects.llmCalls}`);
  lines.push(`- Minion/subagent jobs: ${report.aggregate.sideEffects.minionJobs}`);
  lines.push(`- Live GBrain DB writes: ${report.aggregate.sideEffects.liveDbWrites}`);
  lines.push(`- Canonical Obsidian writes: ${report.aggregate.sideEffects.canonicalVaultWrites}`);
  lines.push('');
  lines.push('## Fixture results');
  lines.push('');
  for (const [idx, entry] of report.results.entries()) {
    lines.push(`### Fixture ${idx + 1}: ${basename(entry.result.input)}`);
    lines.push('');
    lines.push(`- Status: \`${entry.evaluation.overallStatus}\``);
    lines.push(`- Slug: \`${entry.result.slug}\``);
    lines.push(`- Output: \`${entry.result.outputPath}\``);
    lines.push(`- Bytes: ${entry.result.transcriptBytes}`);
    lines.push('- Goal checks:');
    for (const check of entry.evaluation.upstreamGoalChecks) {
      lines.push(`  - ${check.id}: \`${check.status}\` — ${check.finding}`);
    }
    lines.push('');
  }
  lines.push('## Next steps');
  lines.push('');
  for (const step of report.nextSteps) lines.push(`- ${step}`);
  return lines.join('\n');
}

function flattenCrossReferenceHits(evaluation: DreamSandboxEvaluation): DreamSandboxCrossReferenceHit[] {
  return evaluation.crossReferences?.queries.flatMap(query => query.results) ?? [];
}

function renderPromotionDraft(result: DreamSandboxResult, evaluation: DreamSandboxEvaluation): string {
  const transcript = readFileSync(result.input, 'utf8');
  const hits = flattenCrossReferenceHits(evaluation);
  const candidateLines = hits.length === 0
    ? ['- No read-only candidate references supplied; keep this packet parked.']
    : hits.map(hit => `- \`${hit.slug}\` — ${hit.title} (${hit.type}, score ${hit.score})`);
  const summary = excerpt(transcript, 500).replace(/```/g, '``\\`');
  return [
    '---',
    `title: ${yamlString(`Draft promotion review — ${basename(result.input).replace(/\.[^.]+$/, '')}`)}`,
    'type: source',
    'status: draft-promotion-review',
    'source: dream-sandbox',
    'promotion_mode: dry-run',
    `source_path: ${yamlString(result.input)}`,
    `source_slug: ${yamlString(result.slug)}`,
    `content_hash: ${yamlString(result.contentHash)}`,
    `generated_at: ${yamlString(new Date().toISOString())}`,
    '---',
    '',
    '# Draft promotion review',
    '',
    'Status: dry-run review only. This is not canonical memory and has not been synced, embedded, or written to live GBrain.',
    '',
    '## Derived summary draft',
    '',
    summary,
    '',
    '## Verbatim source excerpt',
    '',
    '```text',
    excerpt(transcript, 900),
    '```',
    '',
    '## Candidate existing pages checked before new-page creation',
    '',
    ...candidateLines,
    '',
    '## Human review required',
    '',
    '- [ ] The artifact captures durable memory, not transient task progress.',
    '- [ ] Summary is accurate and not over-synthesized.',
    '- [ ] Quotes are verbatim and not misattributed.',
    '- [ ] Existing pages were checked before proposing a new page.',
    '- [ ] Links are useful and not graph spam.',
    '- [ ] Reviewer selected promote, revise, park, or discard.',
    '',
    '## Safety side effects',
    '',
    `- LLM calls: ${evaluation.sideEffects.llmCalls}`,
    `- Minion/subagent jobs: ${evaluation.sideEffects.minionJobs}`,
    `- Live GBrain DB writes: ${evaluation.sideEffects.liveDbWrites}`,
    `- Canonical Obsidian writes: ${evaluation.sideEffects.canonicalVaultWrites}`,
  ].join('\n');
}

function renderPromotionLinks(result: DreamSandboxResult, evaluation: DreamSandboxEvaluation): string {
  const links = flattenCrossReferenceHits(evaluation).map(hit => ({
    from_slug: result.slug,
    to_slug: hit.slug,
    link_type: 'references-candidate',
    evidence_query: hit.query,
    evidence_score: hit.score,
    reason: `Read-only cross-reference candidate from query ${JSON.stringify(hit.query)}; human review required before any link write.`,
    action: 'review-ambiguous',
  }));
  return JSON.stringify(links, null, 2) + '\n';
}

function renderPromotionConflicts(evaluation: DreamSandboxEvaluation): string {
  const hits = flattenCrossReferenceHits(evaluation);
  const lines: string[] = [];
  lines.push('# Conflicts and duplicates');
  lines.push('');
  lines.push('Status: dry-run review only. No canonical writes have been made.');
  lines.push('');
  lines.push('## Likely duplicate or update candidates');
  lines.push('');
  if (hits.length === 0) {
    lines.push('- No candidate references were supplied; do not promote until read-only search evidence exists.');
  } else {
    for (const hit of hits) lines.push(`- \`${hit.slug}\` — ${hit.title} (${hit.type}, score ${hit.score})`);
  }
  lines.push('');
  lines.push('## Reasons to discard instead of promote');
  lines.push('');
  lines.push('- The item is a transient execution log rather than durable memory.');
  lines.push('- Candidate existing pages already cover the fact.');
  lines.push('- Proposed links would add graph noise.');
  lines.push('- Human reviewer cannot verify the quote or summary.');
  return lines.join('\n');
}

function renderPromotionSummary(packetRoot: string, result: DreamSandboxResult, evaluation: DreamSandboxEvaluation): string {
  const crossReferenceCheck = evaluation.upstreamGoalChecks.find(check => check.id === 'cross-reference-existing-brain');
  return [
    '# Promotion packet summary',
    '',
    `- Status: \`dry-run-review-only\``,
    `- Packet root: \`${packetRoot}\``,
    `- Source slug: \`${result.slug}\``,
    `- Content hash: \`${result.contentHash}\``,
    `- Evaluation status: \`${evaluation.overallStatus}\``,
    `- Cross-reference gate: \`${crossReferenceCheck?.status ?? 'unknown'}\``,
    '',
    '## Side effects',
    '',
    '- LLM calls: 0',
    '- Minion/subagent jobs: 0',
    '- Live GBrain DB writes: 0',
    '- Canonical Obsidian writes: 0',
    '',
    '## Recommendation',
    '',
    'Do not apply this packet automatically. Roger must choose promote, revise, park, or discard before any later apply slice.',
  ].join('\n');
}

function renderHumanDecision(): string {
  return [
    '# Human decision',
    '',
    'Decision: pending-human-review',
    '',
    'Allowed decisions:',
    '',
    '- promote — approve a later one-packet apply slice',
    '- revise — regenerate with narrower scope or corrected links',
    '- park — keep as sandbox evidence only',
    '- discard — ignore or remove this packet',
    '',
    'Reviewer notes:',
    '',
    '- ',
  ].join('\n');
}

export function runDreamSandboxPromotionPacket(opts: DreamSandboxPromotionPacketOptions): DreamSandboxPromotionPacket {
  if (!opts.packetRoot) throw new Error('--write-promotion-packet is required');
  const packetRoot = resolve(opts.packetRoot);
  assertSafeDreamSandboxRoot(packetRoot, opts.canonicalRoot);
  const inputDir = join(packetRoot, 'input');
  const proposedDir = join(packetRoot, 'proposed');
  const reviewDir = join(packetRoot, 'review');
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(proposedDir, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });

  const files: DreamSandboxPromotionPacketFiles = {
    transcript: join(inputDir, 'transcript.txt'),
    sandboxArtifact: join(inputDir, 'sandbox-artifact.md'),
    xrefEvidence: join(inputDir, 'xref-evidence.json'),
    canonicalNoteDraft: join(proposedDir, 'canonical-note-draft.md'),
    linksProposed: join(proposedDir, 'links-proposed.json'),
    conflictsAndDuplicates: join(proposedDir, 'conflicts-and-duplicates.md'),
    promotionSummary: join(proposedDir, 'promotion-summary.md'),
    humanDecision: join(reviewDir, 'human-decision.md'),
    manifest: join(packetRoot, 'manifest.json'),
  };

  writeFileSync(files.transcript, readFileSync(opts.result.input, 'utf8'), 'utf8');
  writeFileSync(files.sandboxArtifact, opts.result.markdown, 'utf8');
  writeFileSync(files.xrefEvidence, JSON.stringify(opts.evaluation.crossReferences ?? null, null, 2) + '\n', 'utf8');
  writeFileSync(files.canonicalNoteDraft, renderPromotionDraft(opts.result, opts.evaluation), 'utf8');
  writeFileSync(files.linksProposed, renderPromotionLinks(opts.result, opts.evaluation), 'utf8');
  writeFileSync(files.conflictsAndDuplicates, renderPromotionConflicts(opts.evaluation), 'utf8');
  writeFileSync(files.promotionSummary, renderPromotionSummary(packetRoot, opts.result, opts.evaluation), 'utf8');
  writeFileSync(files.humanDecision, renderHumanDecision(), 'utf8');

  const packet: DreamSandboxPromotionPacket = {
    status: 'dry-run-review-only',
    packetRoot,
    sourceSlug: opts.result.slug,
    contentHash: opts.result.contentHash,
    files,
    sideEffects: {
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
    },
  };
  writeFileSync(files.manifest, JSON.stringify(packet, null, 2) + '\n', 'utf8');
  return packet;
}

function assertPathInsideRoot(candidate: string, root: string, label: string): string {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + '/')) {
    throw new Error(`${label} must stay inside packet root: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

function readPromotionPacketManifest(packetRoot: string): DreamSandboxPromotionPacket {
  const manifestPath = join(packetRoot, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Promotion packet manifest missing: ${manifestPath}`);
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as DreamSandboxPromotionPacket;
  if (parsed.status !== 'dry-run-review-only') {
    throw new Error(`Promotion packet status must be dry-run-review-only, got: ${String(parsed.status)}`);
  }
  if (!parsed.sourceSlug || !parsed.contentHash) throw new Error('Promotion packet manifest missing sourceSlug/contentHash');
  return parsed;
}

function requirePacketFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`Promotion packet ${label} missing: ${path}`);
}

function assertReviewedForStagingDryRun(humanDecisionPath: string): void {
  const decision = readFileSync(humanDecisionPath, 'utf8');
  const hasDecision = /^Decision:\s*promote-dry-run-only\s*$/mi.test(decision);
  const hasReviewer = /^Reviewer:\s*Roger\s*$/mi.test(decision);
  const hasScope = /^Scope:\s*staging-only\s*$/mi.test(decision);
  if (!hasDecision || !hasReviewer || !hasScope) {
    throw new Error('Staging apply dry-run requires human-decision.md with Decision: promote-dry-run-only, Reviewer: Roger, and Scope: staging-only');
  }
}

function dateFromDreamSlug(sourceSlug: string): string {
  const match = sourceSlug.match(/^experiments\/dreams\/(\d{4}-\d{2}-\d{2})\//);
  return match?.[1] ?? new Date().toISOString().slice(0, 10);
}

function renderStagedPromotionMarkdown(packet: DreamSandboxPromotionPacket, draft: string): string {
  return [
    '<!-- staging-dry-run-only: generated by GBrain dream sandbox apply dry-run; not canonical memory -->',
    draft,
    '',
    '## Staging apply dry-run guardrail',
    '',
    '- Status: `staging-dry-run-only`',
    '- This file lives in a throwaway staging vault, not the canonical Obsidian vault.',
    '- No live GBrain DB writes, sync/import runs, embeddings, LLM calls, or minion jobs were performed.',
    `- Source sandbox slug: \`${packet.sourceSlug}\``,
    `- Source content hash: \`${packet.contentHash}\``,
  ].join('\n');
}

function renderApplyDryRunMarkdown(result: DreamSandboxPromotionApplyDryRunResult): string {
  return [
    '# Dream Sandbox Promotion Apply Dry-Run Report',
    '',
    '- Status: `staging-dry-run-only`',
    `- Promotion packet: \`${result.promotionPacketRoot}\``,
    `- Staging vault: \`${result.stagingVaultRoot}\``,
    `- Staged slug: \`${result.stagedSlug}\``,
    `- Content hash: \`${result.contentHash}\``,
    '',
    '## Generated staging files',
    '',
    ...result.stagedFiles.map(file => `- \`${file}\``),
    '',
    '## Side effects',
    '',
    `- LLM calls: ${result.sideEffects.llmCalls}`,
    `- Minion/subagent jobs: ${result.sideEffects.minionJobs}`,
    `- Live GBrain DB writes: ${result.sideEffects.liveDbWrites}`,
    `- Canonical Obsidian writes: ${result.sideEffects.canonicalVaultWrites}`,
    `- Staging vault writes: ${result.sideEffects.stagingVaultWrites}`,
    `- Live sync/import runs: ${result.sideEffects.liveSyncRuns}`,
    '',
    'No canonical Obsidian writes were performed.',
    'No live GBrain DB writes were performed.',
    'No live sync/import runs were performed.',
    '',
    '## Report artifacts',
    '',
    `- JSON: \`${result.reportFiles.json}\``,
    `- Proposed links copy: \`${result.reportFiles.linksProposed}\``,
    `- Input packet copy: \`${result.reportFiles.inputPacketCopy}\``,
  ].join('\n');
}

export function runDreamSandboxPromotionApplyDryRun(
  opts: DreamSandboxPromotionApplyDryRunOptions,
): DreamSandboxPromotionApplyDryRunResult {
  if (!opts.promotionPacketRoot) throw new Error('--promotion-packet is required');
  if (!opts.stagingVaultRoot) throw new Error('--staging-vault is required');
  if (!opts.reportRoot) throw new Error('--write-apply-report is required');

  const packetRoot = resolve(opts.promotionPacketRoot);
  const stagingVaultRoot = resolve(opts.stagingVaultRoot);
  const reportRoot = resolve(opts.reportRoot);
  assertSafeDreamSandboxRoot(packetRoot, opts.canonicalRoot);
  assertSafeDreamSandboxRoot(stagingVaultRoot, opts.canonicalRoot);
  assertSafeDreamSandboxRoot(reportRoot, opts.canonicalRoot);
  if (reportRoot === stagingVaultRoot || reportRoot.startsWith(stagingVaultRoot + '/')) {
    throw new Error('Apply dry-run report root must be outside the staging vault');
  }
  if (stagingVaultRoot.startsWith(packetRoot + '/') || reportRoot.startsWith(packetRoot + '/')) {
    throw new Error('Staging vault and report root must be outside the promotion packet root');
  }

  const packet = readPromotionPacketManifest(packetRoot);
  const files = {
    transcript: join(packetRoot, 'input', 'transcript.txt'),
    sandboxArtifact: join(packetRoot, 'input', 'sandbox-artifact.md'),
    xrefEvidence: join(packetRoot, 'input', 'xref-evidence.json'),
    canonicalNoteDraft: join(packetRoot, 'proposed', 'canonical-note-draft.md'),
    linksProposed: join(packetRoot, 'proposed', 'links-proposed.json'),
    conflictsAndDuplicates: join(packetRoot, 'proposed', 'conflicts-and-duplicates.md'),
    promotionSummary: join(packetRoot, 'proposed', 'promotion-summary.md'),
    humanDecision: join(packetRoot, 'review', 'human-decision.md'),
  };
  for (const [label, path] of Object.entries(files)) requirePacketFile(path, label);
  assertReviewedForStagingDryRun(files.humanDecision);

  const date = dateFromDreamSlug(packet.sourceSlug);
  const base = slugifySegment(basename(packet.sourceSlug));
  const stagedSlug = `experiments/dream-promotions/${date}/${base}`;
  const stagedPath = join(stagingVaultRoot, `${stagedSlug}.md`);
  assertPathInsideRoot(stagedPath, stagingVaultRoot, 'Staged promotion file');

  mkdirSync(dirname(stagedPath), { recursive: true });
  mkdirSync(reportRoot, { recursive: true });
  const reportPacketCopy = join(reportRoot, 'input-packet-copy');
  rmSync(reportPacketCopy, { recursive: true, force: true });
  cpSync(packetRoot, reportPacketCopy, { recursive: true });

  writeFileSync(stagedPath, renderStagedPromotionMarkdown(packet, readFileSync(files.canonicalNoteDraft, 'utf8')), 'utf8');
  const linksReport = join(reportRoot, 'links-proposed.json');
  writeFileSync(linksReport, readFileSync(files.linksProposed, 'utf8'), 'utf8');

  const result: DreamSandboxPromotionApplyDryRunResult = {
    status: 'staging-dry-run-only',
    promotionPacketRoot: packetRoot,
    stagingVaultRoot,
    reportRoot,
    sourceSlug: packet.sourceSlug,
    contentHash: packet.contentHash,
    stagedSlug,
    stagedFiles: [stagedPath],
    reportFiles: {
      markdown: join(reportRoot, 'apply-dry-run-report.md'),
      json: join(reportRoot, 'apply-dry-run-report.json'),
      linksProposed: linksReport,
      inputPacketCopy: reportPacketCopy,
    },
    sideEffects: {
      llmCalls: 0,
      minionJobs: 0,
      liveDbWrites: 0,
      canonicalVaultWrites: 0,
      stagingVaultWrites: 1,
      liveSyncRuns: 0,
    },
  };

  writeFileSync(result.reportFiles.markdown, renderApplyDryRunMarkdown(result), 'utf8');
  writeFileSync(result.reportFiles.json, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}

export function renderDreamSandboxEvaluationMarkdown(evaluation: DreamSandboxEvaluation): string {
  const lines: string[] = [];
  lines.push('# Dream Sandbox Evaluation');
  lines.push('');
  lines.push(`- Status: \`${evaluation.overallStatus}\``);
  lines.push(`- Input: \`${evaluation.input}\``);
  lines.push(`- Output: \`${evaluation.outputPath}\``);
  lines.push(`- Slug: \`${evaluation.slug}\``);
  lines.push(`- Content hash: \`${evaluation.contentHash}\``);
  lines.push('');
  lines.push('## Safety side effects');
  lines.push('');
  lines.push(`- LLM calls: ${evaluation.sideEffects.llmCalls}`);
  lines.push(`- Minion/subagent jobs: ${evaluation.sideEffects.minionJobs}`);
  lines.push(`- Live GBrain DB writes: ${evaluation.sideEffects.liveDbWrites}`);
  lines.push(`- Canonical Obsidian writes: ${evaluation.sideEffects.canonicalVaultWrites}`);
  lines.push('');
  lines.push('## Upstream goal comparison');
  lines.push('');
  for (const check of evaluation.upstreamGoalChecks) {
    lines.push(`### ${check.id}`);
    lines.push('');
    lines.push(`- Status: \`${check.status}\``);
    lines.push(`- Upstream goal: ${check.upstreamGoal}`);
    lines.push(`- Finding: ${check.finding}`);
    lines.push('');
  }
  if (evaluation.crossReferences) {
    lines.push('## Read-only cross-reference/search evidence');
    lines.push('');
    lines.push(`- Mode: \`${evaluation.crossReferences.mode}\``);
    lines.push(`- LLM calls: ${evaluation.crossReferences.sideEffects.llmCalls}`);
    lines.push(`- Minion/subagent jobs: ${evaluation.crossReferences.sideEffects.minionJobs}`);
    lines.push(`- Live GBrain DB writes: ${evaluation.crossReferences.sideEffects.liveDbWrites}`);
    lines.push(`- Canonical Obsidian writes: ${evaluation.crossReferences.sideEffects.canonicalVaultWrites}`);
    lines.push('');
    for (const query of evaluation.crossReferences.queries) {
      lines.push(`### Query: ${query.query}`);
      lines.push('');
      if (query.results.length === 0) {
        lines.push('- No results.');
      } else {
        for (const hit of query.results) {
          lines.push(`- \`${hit.slug}\` — ${hit.title} (${hit.type}, score ${hit.score})`);
        }
      }
      lines.push('');
    }
  }
  lines.push('## Recommendations');
  lines.push('');
  for (const recommendation of evaluation.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  return lines.join('\n');
}
